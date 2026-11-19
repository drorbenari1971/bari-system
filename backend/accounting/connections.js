// Connections to accounting providers. Credentials and webhook secrets are stored encrypted and
// never leave the server: the screen only sees which fields are set, and a masked hint.
import './schema.js'; // tables must exist before statements are prepared
import { db, nowIso } from '../db.js';
import { encrypt, decrypt, mask } from './crypto.js';
import { getProvider, hasProvider } from './providers/index.js';
import { AccountingError } from './errors.js';
import * as audit from './audit.js';

const row = (id) => db.prepare('SELECT * FROM acc_connections WHERE id = ?').get(id);

/** The connection as the screen may see it. */
function publicView(r) {
  const provider = getProvider(r.provider);
  const creds = decrypt(r.credentials_enc);
  return {
    id: r.id,
    provider: r.provider,
    providerLabel: provider.label,
    label: r.label,
    environment: r.environment,
    enabled: !!r.enabled,
    settings: JSON.parse(r.settings),
    credentials: Object.fromEntries(provider.credentialFields.map((f) => [f.key, {
      set: !!creds[f.key],
      hint: creds[f.key] && !f.secret ? mask(creds[f.key]) : null,
    }])),
    webhookSecretSet: !!r.webhook_secret_enc,
    status: r.status,
    lastCheckAt: r.last_check_at,
    lastOkAt: r.last_ok_at,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** For audit: what changed, without any secret value. */
const auditView = (r) => {
  const v = publicView(r);
  return { label: v.label, environment: v.environment, enabled: v.enabled, settings: v.settings, credentials: v.credentials, webhookSecretSet: v.webhookSecretSet };
};

/** For providers and jobs: the connection with decrypted credentials. */
export function getConnection(id) {
  const r = row(id);
  if (!r) return null;
  return { ...r, enabled: !!r.enabled, settings: JSON.parse(r.settings), credentials: decrypt(r.credentials_enc) };
}

export const listConnections = () => db.prepare('SELECT * FROM acc_connections ORDER BY id').all().map(publicView);
export const getConnectionView = (id) => { const r = row(id); return r ? publicView(r) : null; };

function validate(provider, { environment, credentials = {} }, { partial }) {
  if (environment !== undefined && !provider.environments[environment]) {
    throw new AccountingError('סביבה לא מוכרת', { code: 'validation' });
  }
  for (const f of provider.credentialFields) {
    const v = credentials[f.key];
    if (v !== undefined && typeof v !== 'string') throw new AccountingError(`${f.label}: ערך לא תקין`, { code: 'validation' });
    if (!partial && !String(v ?? '').trim()) throw new AccountingError(`חסר ${f.label}`, { code: 'validation' });
  }
}

export function createConnection({ provider: providerId, label = '', environment, credentials, webhookSecret }, source = 'manual') {
  if (!hasProvider(providerId)) throw new AccountingError('ספק לא מוכר', { code: 'validation' });
  const provider = getProvider(providerId);
  const env = environment ?? Object.keys(provider.environments)[0];
  validate(provider, { environment: env, credentials }, { partial: false });
  const clean = Object.fromEntries(provider.credentialFields.map((f) => [f.key, String(credentials[f.key]).trim()]));

  db.exec('BEGIN');
  try {
    const r = db.prepare(`
      INSERT INTO acc_connections (provider, label, environment, credentials_enc, webhook_secret_enc)
      VALUES (?, ?, ?, ?, ?)
    `).run(providerId, String(label).trim() || provider.label, env, encrypt(clean), webhookSecret ? encrypt(String(webhookSecret)) : null);
    const id = Number(r.lastInsertRowid);
    audit.record({ action: 'connection.created', source, entityType: 'connection', entityId: id, after: auditView(row(id)) });
    db.exec('COMMIT');
    return getConnectionView(id);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Empty or missing secret fields keep their current value. */
export function updateConnection(id, { label, environment, credentials = {}, webhookSecret, enabled, settings }, source = 'manual') {
  const current = row(id);
  if (!current) throw new AccountingError('החיבור לא נמצא', { code: 'not_found', status: 404 });
  const provider = getProvider(current.provider);
  validate(provider, { environment, credentials }, { partial: true });

  const creds = decrypt(current.credentials_enc);
  for (const f of provider.credentialFields) {
    const v = credentials[f.key];
    if (typeof v === 'string' && v.trim()) creds[f.key] = v.trim();
  }
  const credsChanged = JSON.stringify(creds) !== JSON.stringify(decrypt(current.credentials_enc));
  const before = auditView(current);

  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE acc_connections SET label = ?, environment = ?, credentials_enc = ?, webhook_secret_enc = ?,
        enabled = ?, settings = ?, status = ?, updated_at = ? WHERE id = ?
    `).run(
      label !== undefined ? String(label).trim() || provider.label : current.label,
      environment ?? current.environment,
      credsChanged ? encrypt(creds) : current.credentials_enc,
      typeof webhookSecret === 'string' && webhookSecret ? encrypt(webhookSecret) : current.webhook_secret_enc,
      enabled === undefined ? current.enabled : (enabled ? 1 : 0),
      settings === undefined ? current.settings : JSON.stringify({ ...JSON.parse(current.settings), ...settings }),
      // New credentials or environment: the last check no longer applies.
      credsChanged || (environment && environment !== current.environment) ? 'unchecked' : current.status,
      nowIso(), id,
    );
    const after = auditView(row(id));
    if (audit.diff(before, after).length) {
      audit.record({ action: 'connection.updated', source, entityType: 'connection', entityId: id, before, after });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return getConnectionView(id);
}

/** Removes a connection that has no synced documents or customers yet; otherwise it must be disabled instead. */
export function deleteConnection(id, source = 'manual') {
  const current = row(id);
  if (!current) throw new AccountingError('החיבור לא נמצא', { code: 'not_found', status: 404 });
  const docs = db.prepare('SELECT COUNT(*) AS n FROM acc_documents WHERE connection_id = ?').get(id).n;
  if (docs) throw new AccountingError(`לחיבור יש ${docs} מסמכים מסונכרנים. אפשר להשבית אותו במקום למחוק.`, { code: 'conflict', status: 409 });
  const customers = db.prepare('SELECT COUNT(*) AS n FROM acc_customer_records WHERE connection_id = ?').get(id).n;
  if (customers) throw new AccountingError(`לחיבור יש ${customers} לקוחות מסונכרנים. אפשר להשבית אותו במקום למחוק.`, { code: 'conflict', status: 409 });
  db.exec('BEGIN');
  try {
    audit.record({ action: 'connection.deleted', source, entityType: 'connection', entityId: id, before: auditView(current) });
    db.prepare('DELETE FROM acc_jobs WHERE connection_id = ?').run(id);
    db.prepare('DELETE FROM acc_sync_runs WHERE connection_id = ?').run(id);
    db.prepare('DELETE FROM acc_connections WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Runs the provider's connection test and stores the outcome on the connection. */
export async function testConnection(id, deps) {
  const conn = getConnection(id);
  if (!conn) throw new AccountingError('החיבור לא נמצא', { code: 'not_found', status: 404 });
  const at = nowIso();
  try {
    const result = await getProvider(conn.provider).testConnection(conn, deps);
    db.prepare("UPDATE acc_connections SET status = 'ok', last_check_at = ?, last_ok_at = ?, last_error = NULL WHERE id = ?").run(at, at, id);
    return { ok: true, details: result.details, connection: getConnectionView(id) };
  } catch (err) {
    db.prepare("UPDATE acc_connections SET status = 'error', last_check_at = ?, last_error = ? WHERE id = ?").run(at, err.message, id);
    return { ok: false, error: err.message, code: err.code ?? 'error', connection: getConnectionView(id) };
  }
}
