import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { isolate, fakeFetch } from './helpers.js';

after(isolate());
const { db } = await import('../db.js');
const connections = await import('../accounting/connections.js');
const audit = await import('../accounting/audit.js');
const { clearTokenCache } = await import('../accounting/providers/morning/client.js');

const input = { provider: 'morning', environment: 'sandbox', credentials: { clientId: 'a1b2c3d4-e5f6-4a7b-8c9d', clientSecret: 'super-secret-value' } };

test('creates a connection with encrypted credentials and a safe public view', () => {
  const c = connections.createConnection(input);
  assert.equal(c.provider, 'morning');
  assert.equal(c.label, 'Morning (חשבונית ירוקה)');
  assert.equal(c.status, 'unchecked');
  assert.deepEqual(c.credentials, { clientId: { set: true, hint: 'a1b2…8c9d' }, clientSecret: { set: true, hint: null } });
  const stored = db.prepare('SELECT credentials_enc FROM acc_connections WHERE id = ?').get(c.id).credentials_enc;
  assert.ok(!stored.includes('super-secret') && !stored.includes('a1b2c3d4'));
  assert.ok(!JSON.stringify(connections.listConnections()).includes('super-secret-value'));
  assert.equal(connections.getConnection(c.id).credentials.clientSecret, 'super-secret-value');
});

test('validates provider, environment and required fields', () => {
  assert.throws(() => connections.createConnection({ ...input, provider: 'nope' }), /ספק/);
  assert.throws(() => connections.createConnection({ ...input, environment: 'staging' }), /סביבה/);
  assert.throws(() => connections.createConnection({ ...input, credentials: { clientId: 'x', clientSecret: ' ' } }), /Client Secret/);
});

test('update keeps a secret left empty, and new credentials reset the status', () => {
  const c = connections.createConnection(input);
  db.prepare("UPDATE acc_connections SET status = 'ok' WHERE id = ?").run(c.id);
  let u = connections.updateConnection(c.id, { label: 'ראשי', credentials: { clientSecret: '' } });
  assert.equal(u.label, 'ראשי');
  assert.equal(u.status, 'ok', 'nothing secret changed');
  assert.equal(connections.getConnection(c.id).credentials.clientSecret, 'super-secret-value');
  u = connections.updateConnection(c.id, { credentials: { clientSecret: 'new-secret' } });
  assert.equal(u.status, 'unchecked');
  assert.equal(connections.getConnection(c.id).credentials.clientSecret, 'new-secret');
  u = connections.updateConnection(c.id, { enabled: false, settings: { pollMinutes: 5 } });
  assert.equal(u.enabled, false);
  assert.deepEqual(u.settings, { pollMinutes: 5 });
  assert.throws(() => connections.updateConnection(9999, {}), /לא נמצא/);
});

test('every change is in the audit log, without secret values', () => {
  const c = connections.createConnection(input);
  connections.updateConnection(c.id, { label: 'חדש' });
  connections.updateConnection(c.id, { label: 'חדש' }); // no change: no entry
  const log = audit.list({ entityType: 'connection', entityId: c.id });
  assert.deepEqual(log.items.map((a) => a.action), ['connection.updated', 'connection.created']);
  assert.deepEqual(log.items[0].changes, [{ field: 'label', from: 'Morning (חשבונית ירוקה)', to: 'חדש' }]);
  assert.equal(log.items[0].source, 'manual');
  assert.ok(!JSON.stringify(log).includes('super-secret-value'));
});

test('delete is refused once documents exist', () => {
  const c = connections.createConnection(input);
  db.prepare("INSERT INTO acc_documents (connection_id, external_id, kind, status, doc_date) VALUES (?, 'd1', 'invoice', 'open', '2026-01-01')").run(c.id);
  assert.throws(() => connections.deleteConnection(c.id), /מסמכים מסונכרנים/);
  const other = connections.createConnection(input);
  connections.deleteConnection(other.id);
  assert.equal(connections.getConnectionView(other.id), null);
  assert.equal(audit.list({ entityType: 'connection', entityId: other.id }).items[0].action, 'connection.deleted');
});

test('a connection test stores the outcome on the connection', async () => {
  const c = connections.createConnection(input);
  const ok = fakeFetch((r) => (r.url.includes('oauth') ? { body: { accessToken: 't', expiresAt: Math.floor(Date.now() / 1000) + 3600 } } : { body: { total: 7 } }));
  const good = await connections.testConnection(c.id, { fetch: ok });
  assert.equal(good.ok, true);
  assert.equal(good.connection.status, 'ok');
  assert.ok(good.connection.lastOkAt);

  clearTokenCache();
  const denied = fakeFetch(() => ({ status: 401, body: { error: 'invalid_client' } }));
  const bad = await connections.testConnection(c.id, { fetch: denied });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'auth_failed');
  assert.equal(bad.connection.status, 'error');
  assert.match(bad.connection.lastError, /שגויים/);
});
