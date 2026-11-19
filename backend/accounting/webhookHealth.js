// Webhook monitoring. Morning gives no signal when it stops sending (after 15 failed deliveries
// the webhook simply becomes inactive), so health is inferred:
//   - answers Morning counts as failures, in a row (rejected in the archive, plus 403/429 in memory)
//   - customers created in Morning after webhooks were turned on, that only the periodic sync brought
//     in more than 10 minutes later, with no webhook for them ("missed")
//   - no accepted delivery for 7 days
// The periodic sync keeps the data right either way; these warnings say the fast path is broken.
import './schema.js'; // tables must exist before statements are prepared
import { db } from '../db.js';
import { isEnabled } from './flags.js';
import { webhookView } from './webhookConfig.js';
import { unarchivedFailures } from './webhookReceiver.js';
import { getProvider } from './providers/index.js';

export const MISSED_AFTER_MINUTES = 10;
const MISSED_LOOKBACK_HOURS = 48;
const FAILURE_STREAK_WARNING = 3;
export const MORNING_DISABLES_AFTER = 15;
const QUIET_DAYS = 7;

const iso = (ms) => new Date(ms).toISOString();

/** When the webhooks flag was last turned on (null if never stored). */
const flagOnSince = () => db.prepare("SELECT updated_at FROM acc_feature_flags WHERE key = 'webhooks' AND enabled = 1").get()?.updated_at ?? null;

export function webhookHealth(connectionId, now = Date.now()) {
  const view = webhookView(connectionId);
  const enabled = isEnabled('webhooks');
  const configured = view.secretSet && !!view.path;
  const lastAccepted = db.prepare("SELECT MAX(received_at) AS at FROM acc_webhook_archive WHERE connection_id = ? AND outcome = 'accepted'").get(connectionId).at;
  const lastAny = db.prepare('SELECT MAX(received_at) AS at FROM acc_webhook_archive WHERE connection_id = ?').get(connectionId).at;
  const counts = Object.fromEntries(db.prepare(`
    SELECT outcome, COUNT(*) AS n FROM acc_webhook_archive WHERE connection_id = ? AND received_at >= ? GROUP BY outcome
  `).all(connectionId, iso(now - 86_400_000)).map((r) => [r.outcome, r.n]));

  // Failures in a row: rejected rows after the last row Morning saw as a success, plus 403/429 answers.
  const lastOkId = db.prepare("SELECT MAX(id) AS id FROM acc_webhook_archive WHERE connection_id = ? AND outcome <> 'rejected'").get(connectionId).id ?? 0;
  const lastRejection = db.prepare("SELECT rejection_reason FROM acc_webhook_archive WHERE connection_id = ? AND outcome = 'rejected' ORDER BY id DESC LIMIT 1").get(connectionId);
  const failureStreak = db.prepare("SELECT COUNT(*) AS n FROM acc_webhook_archive WHERE connection_id = ? AND id > ? AND outcome = 'rejected'").get(connectionId, lastOkId).n
    + (unarchivedFailures.get(connectionId) ?? 0);

  let missed = 0;
  const since = [view.activatedAt, flagOnSince()].filter(Boolean).sort().at(-1);
  if (enabled && configured && since) {
    missed = db.prepare(`
      SELECT COUNT(*) AS n FROM acc_customer_records r
      WHERE r.connection_id = ? AND r.source_created_at > ? AND r.first_seen_at >= ?
        AND (julianday(r.first_seen_at) - julianday(r.source_created_at)) * 1440 > ?
        AND NOT EXISTS (
          SELECT 1 FROM acc_jobs j WHERE j.connection_id = r.connection_id AND j.type = 'fetch_customer'
            AND j.source = 'webhook' AND json_extract(j.payload, '$.externalId') = r.external_id
        )
    `).get(connectionId, since, iso(now - MISSED_LOOKBACK_HOURS * 3_600_000), MISSED_AFTER_MINUTES).n;
  }

  const warnings = [];
  if (!configured) warnings.push({ level: 'info', code: 'not_configured', text: 'עדיין לא נוצרו כתובת וסוד ל-Webhook.' });
  else if (!view.publicUrlSet) warnings.push({ level: 'info', code: 'no_public_url', text: 'לא הוגדרה הכתובת הציבורית של המנהרה (WEBHOOK_PUBLIC_URL בקובץ backend\\.env).' });
  if (configured && !enabled) warnings.push({ level: 'info', code: 'flag_off', text: 'ה-Webhooks כבויים במתגים. אירועים מאומתים נרשמים ולא מעובדים, והסנכרון התקופתי ממשיך כרגיל.' });
  if (failureStreak >= FAILURE_STREAK_WARNING) {
    warnings.push({
      level: 'error', code: 'failing',
      text: `${failureStreak} שליחות ברצף נדחו${lastRejection?.rejection_reason ? ` (סיבה אחרונה: ${lastRejection.rejection_reason})` : ''}. Morning משביתה Webhook אחרי ${MORNING_DISABLES_AFTER} כישלונות.`,
    });
  }
  if (missed > 0) {
    warnings.push({
      level: 'error', code: 'missed',
      text: `${missed} לקוחות חדשים הגיעו רק מהסנכרון התקופתי, בלי Webhook. ייתכן ש-Morning השביתה את ה-Webhook: בדקו ב-Morning, בכלי מפתחים ← Webhooks, והפעילו אותו מחדש.`,
    });
  }
  if (enabled && configured && since && Date.parse(since) < now - QUIET_DAYS * 86_400_000
    && (!lastAccepted || Date.parse(lastAccepted) < now - QUIET_DAYS * 86_400_000)) {
    warnings.push({ level: 'warning', code: 'quiet', text: `לא התקבל אף אירוע ב-${QUIET_DAYS} הימים האחרונים.` });
  }

  const status = !configured ? 'not_configured' : !enabled ? 'off'
    : warnings.some((w) => w.level === 'error') ? 'error' : warnings.some((w) => w.level === 'warning') ? 'warning' : 'ok';
  return { status, enabled, configured, lastAcceptedAt: lastAccepted, lastDeliveryAt: lastAny, last24h: counts, failureStreak, missed, warnings };
}

// Console alert when a connection's webhook health turns to error (checked every minute).
const lastStatus = new Map();
export function alertOnChange(now = Date.now()) {
  const alerts = [];
  for (const { id, label, provider } of db.prepare('SELECT id, label, provider FROM acc_connections WHERE enabled = 1').all()) {
    if (!getProvider(provider).capabilities.webhooks) continue;
    const h = webhookHealth(id, now);
    if (h.status === 'error' && lastStatus.get(id) !== 'error') {
      const text = `[accounting] webhook problem on "${label}": ${h.warnings.filter((w) => w.level === 'error').map((w) => w.code).join(', ')}`;
      console.warn(text);
      alerts.push({ connectionId: id, warnings: h.warnings });
    }
    lastStatus.set(id, h.status);
  }
  return alerts;
}

/** Delivery log for the screen: metadata only. */
export function listDeliveries({ connectionId, outcome, page = 1, pageSize = 20 } = {}) {
  const where = [];
  const args = [];
  if (connectionId) { where.push('connection_id = ?'); args.push(Number(connectionId)); }
  if (outcome) { where.push('outcome = ?'); args.push(outcome); }
  const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const size = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
  const current = Math.max(Number(page) || 1, 1);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM acc_webhook_archive ${sqlWhere}`).get(...args).n;
  const items = db.prepare(`
    SELECT id, connection_id, received_at, delivery_id, topic, event_timestamp, body_size, signature_valid, outcome, rejection_reason, job_id
    FROM acc_webhook_archive ${sqlWhere} ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(...args, size, (current - 1) * size);
  return { items, total, page: current, pageSize: size };
}

export const getDelivery = (id) => db.prepare('SELECT id, connection_id, outcome, job_id FROM acc_webhook_archive WHERE id = ?').get(id) ?? null;
