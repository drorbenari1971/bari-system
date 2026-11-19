// Feature flags (docs/customers-module-design.md, section 18).
// - Defaults: on, except webhooks (WEBHOOKS_ENABLED), which is off until turned on in the settings screen.
// - backend/.env can lock a flag (e.g. FEATURE_AUTO_SYNC=false); the screen then shows it as locked.
//   A flag with offOnlyInEnv can only be locked OFF from .env: turning it on is possible only in the screen.
import './schema.js'; // tables must exist before statements are prepared
import { db, nowIso } from '../db.js';
import { env } from '../config.js';
import { AccountingError } from './errors.js';
import { tx } from './tx.js';
import * as audit from './audit.js';

export const FLAGS = {
  webhooks: { label: 'קבלת אירועים מ-Morning (Webhooks)', env: 'WEBHOOKS_ENABLED', default: false, offOnlyInEnv: true },
  polling: { label: 'סנכרון תקופתי', env: 'FEATURE_POLLING', default: true },
  autoSync: { label: 'כל התזמונים האוטומטיים', env: 'FEATURE_AUTO_SYNC', default: true },
  biCache: { label: 'סיכומי BI מוכנים מראש', env: 'FEATURE_BI_CACHE', default: true },
  liveDashboard: { label: 'עדכונים חיים במסכים', env: 'FEATURE_LIVE_DASHBOARD', default: true },
};

/** The value .env forces, or null. */
const fromEnv = (key) => {
  const v = String(env(FLAGS[key].env, '')).trim().toLowerCase();
  if (v === 'false') return false;
  if (v === 'true' && !FLAGS[key].offOnlyInEnv) return true;
  return null;
};
const stored = (key) => db.prepare('SELECT enabled FROM acc_feature_flags WHERE key = ?').get(key);

export function isEnabled(key) {
  if (!FLAGS[key]) throw new Error(`Unknown feature flag: ${key}`);
  const locked = fromEnv(key);
  if (locked !== null) return locked;
  const row = stored(key);
  return row ? !!row.enabled : FLAGS[key].default;
}

export const listFlags = () => Object.entries(FLAGS).map(([key, f]) => ({
  key, label: f.label, enabled: isEnabled(key), default: f.default, lockedByEnv: fromEnv(key) !== null, envName: f.env,
}));

export function setFlag(key, enabled, source = 'manual') {
  if (!FLAGS[key]) throw new AccountingError('מתג לא מוכר', { code: 'validation' });
  if (fromEnv(key) !== null) throw new AccountingError(`המתג נעול בקובץ ההגדרות (${FLAGS[key].env}).`, { code: 'conflict', status: 409 });
  const before = isEnabled(key);
  const value = !!enabled;
  if (before === value) return listFlags().find((f) => f.key === key);
  tx(() => {
    db.prepare(`
      INSERT INTO acc_feature_flags (key, enabled, updated_at, updated_by) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at, updated_by = excluded.updated_by
    `).run(key, value ? 1 : 0, nowIso(), source);
    audit.record({ action: 'flag.changed', source, entityType: 'flag', entityId: key, before: { enabled: before }, after: { enabled: value } });
  });
  return listFlags().find((f) => f.key === key);
}
