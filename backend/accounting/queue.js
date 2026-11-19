// Persistent job queue in SQLite (docs/customers-module-design.md, section 7).
// Lifecycle: pending -> processing -> completed | retry -> processing ... | failed (manual retry -> pending).
import './schema.js'; // tables must exist before statements are prepared
import { db, nowIso } from '../db.js';

export const STATUSES = ['pending', 'processing', 'completed', 'failed', 'retry'];
export const PRIORITY = { webhook: 10, manual: 5, replay: 5, polling: 0, system: 0 };

// Waits between attempts: 10s, 30s, 2m, 10m, 30m, then hourly.
const BACKOFF_MS = [10_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000];
export const STALE_LOCK_MS = 5 * 60_000;
const KEEP_COMPLETED_DAYS = 30;

const isoIn = (ms) => new Date(Date.now() + ms).toISOString();
const parse = (j) => (j ? { ...j, payload: JSON.parse(j.payload), result: j.result ? JSON.parse(j.result) : null } : null);

/**
 * Adds a job. With a dedupe key, a job that is already waiting or running with the same key
 * is returned instead of adding a second one.
 * @returns {{ job: object, created: boolean }}
 */
export function enqueue({ type, source, connectionId = null, payload = {}, dedupeKey = null, maxAttempts = 8, priority }) {
  const prio = priority ?? PRIORITY[source] ?? 0;
  if (dedupeKey) {
    const existing = db.prepare("SELECT * FROM acc_jobs WHERE dedupe_key = ? AND status IN ('pending','processing','retry')").get(dedupeKey);
    if (existing) return { job: parse(existing), created: false };
  }
  const r = db.prepare(`
    INSERT INTO acc_jobs (connection_id, type, source, priority, payload, dedupe_key, max_attempts)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(connectionId, type, source, prio, JSON.stringify(payload), dedupeKey, maxAttempts);
  return { job: getJob(Number(r.lastInsertRowid)), created: true };
}

export const getJob = (id) => parse(db.prepare('SELECT * FROM acc_jobs WHERE id = ?').get(id));

/** Atomically takes the next ready job (highest priority, then oldest) and marks it processing. */
export function claim() {
  const now = nowIso();
  const r = db.prepare(`
    UPDATE acc_jobs SET status = 'processing', locked_at = ?, started_at = ?, attempts = attempts + 1
    WHERE id = (
      SELECT id FROM acc_jobs
      WHERE status IN ('pending', 'retry') AND next_attempt_at <= ?
      ORDER BY priority DESC, id ASC LIMIT 1
    )
    RETURNING *
  `).get(now, now, now);
  return parse(r);
}

export function complete(id, result = null) {
  const job = db.prepare('SELECT started_at FROM acc_jobs WHERE id = ?').get(id);
  const now = nowIso();
  db.prepare(`
    UPDATE acc_jobs SET status = 'completed', finished_at = ?, duration_ms = ?, locked_at = NULL, last_error = NULL, result = ?
    WHERE id = ?
  `).run(now, job?.started_at ? Date.parse(now) - Date.parse(job.started_at) : null, result ? JSON.stringify(result) : null, id);
}

/**
 * Records a failure. Temporary errors go to 'retry' with a growing delay (or the provider's own
 * retry-after); permanent errors, or running out of attempts, go to 'failed'.
 */
export function fail(id, error, { retryable = true, retryAfterMs } = {}) {
  const job = db.prepare('SELECT attempts, max_attempts, started_at FROM acc_jobs WHERE id = ?').get(id);
  if (!job) return;
  const now = nowIso();
  const giveUp = !retryable || job.attempts >= job.max_attempts;
  const delay = Math.max(retryAfterMs ?? 0, BACKOFF_MS[Math.min(job.attempts - 1, BACKOFF_MS.length - 1)] ?? BACKOFF_MS.at(-1));
  db.prepare(`
    UPDATE acc_jobs SET status = ?, next_attempt_at = ?, finished_at = ?, duration_ms = ?, locked_at = NULL, last_error = ?
    WHERE id = ?
  `).run(
    giveUp ? 'failed' : 'retry',
    giveUp ? now : isoIn(delay),
    now,
    job.started_at ? Date.parse(now) - Date.parse(job.started_at) : null,
    String(error?.message ?? error).slice(0, 2000),
    id,
  );
}

/** Manual "try again" for a failed job: back to pending with a fresh set of attempts. */
export function retryNow(id) {
  const r = db.prepare(`
    UPDATE acc_jobs SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL, finished_at = NULL
    WHERE id = ? AND status IN ('failed', 'retry')
  `).run(nowIso(), id);
  return r.changes > 0;
}

/** Jobs left 'processing' by a crash or restart go back to 'retry'. */
export function releaseStale(maxAgeMs = STALE_LOCK_MS) {
  return db.prepare(`
    UPDATE acc_jobs SET status = 'retry', locked_at = NULL, next_attempt_at = ?,
      last_error = COALESCE(last_error, 'העיבוד נעצר באמצע (השרת נסגר או נתקע)')
    WHERE status = 'processing' AND locked_at < ?
  `).run(nowIso(), new Date(Date.now() - maxAgeMs).toISOString()).changes;
}

/** Completed jobs are kept for 30 days; failed ones are kept until handled. */
export function cleanup(days = KEEP_COMPLETED_DAYS) {
  return db.prepare("DELETE FROM acc_jobs WHERE status = 'completed' AND finished_at < ?")
    .run(new Date(Date.now() - days * 86_400_000).toISOString()).changes;
}

export function counts() {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM acc_jobs GROUP BY status').all();
  return Object.fromEntries(STATUSES.map((s) => [s, rows.find((r) => r.status === s)?.n ?? 0]));
}

export function list({ status, type, page = 1, pageSize = 50 } = {}) {
  const where = [];
  const args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  if (type) { where.push('type = ?'); args.push(type); }
  const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const size = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
  const current = Math.max(Number(page) || 1, 1);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM acc_jobs ${sqlWhere}`).get(...args).n;
  const items = db.prepare(`SELECT * FROM acc_jobs ${sqlWhere} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...args, size, (current - 1) * size).map(parse);
  return { items, total, page: current, pageSize: size };
}
