// Customer sync against a fake Morning (fictional customers). Tests run in order and share state.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { isolate, fakeFetch, noSleep } from './helpers.js';

after(isolate());
const { db } = await import('../db.js');
const connections = await import('../accounting/connections.js');
const queue = await import('../accounting/queue.js');
const worker = await import('../accounting/worker.js');
const audit = await import('../accounting/audit.js');
const sync = await import('../accounting/sync.js');
const polling = await import('../accounting/polling.js');
const flags = await import('../accounting/flags.js');

// ---- fake Morning
const client = (i, extra = {}) => ({
  id: `c-${i}`, name: `לקוח ${i}`, phone: `050-000${String(i).padStart(4, '0')}`, emails: [`c${i}@example.com`],
  active: true, incomeAmount: 100.5, paymentAmount: 50, balanceAmount: -50.5,
  creationDate: 1_700_000_000, lastUpdateDate: 1_700_000_000 + i, bankName: 'בנק', bankAccount: '123456', ...extra,
});
let clients = Array.from({ length: 205 }, (_, i) => client(i + 1));
let failure = null; // null | { status } for every data request
const fetch = fakeFetch((c) => {
  if (c.url.includes('oauth')) return { body: { accessToken: 't', expiresAt: Math.floor(Date.now() / 1000) + 3600 } };
  if (failure) return { status: failure.status, body: { errorCode: failure.status } };
  if (c.url.endsWith('/clients/search')) {
    const { page, pageSize } = c.body;
    return { body: { total: clients.length, page, pageSize, pages: Math.max(1, Math.ceil(clients.length / pageSize)), items: clients.slice((page - 1) * pageSize, page * pageSize) } };
  }
  const id = decodeURIComponent(c.url.split('/clients/')[1] ?? '');
  const found = clients.find((x) => x.id === id);
  return found ? { body: found } : { status: 404, body: { errorCode: 404 } };
});
sync.setProviderDeps({ fetch, sleep: noSleep });

const conn = connections.createConnection({ provider: 'morning', environment: 'sandbox', credentials: { clientId: 'id', clientSecret: 'secret' } });
db.prepare("UPDATE acc_connections SET status = 'ok' WHERE id = ?").run(conn.id);

async function drain() {
  for (let i = 0; i < 200; i++) {
    worker.kick();
    await worker.idle();
    const c = queue.counts();
    if (!c.pending && !c.processing) return;
  }
  throw new Error('queue did not drain');
}
async function runSync() {
  sync.requestCustomerSync(conn.id, 'manual');
  await drain();
  return sync.latestCustomerRun(conn.id);
}
const auditCount = (action) => audit.list({ action, pageSize: 1 }).total;
const record = (externalId) => db.prepare('SELECT * FROM acc_customer_records WHERE external_id = ?').get(externalId);
const customerOf = (externalId) => db.prepare('SELECT * FROM customers WHERE id = ?').get(record(externalId).customer_id);

test('initial full sync reads every page and creates customers, without bank details', async () => {
  const run = await runSync();
  assert.equal(run.status, 'completed');
  assert.equal(run.pages, 3);
  assert.equal(run.fetched, 205);
  assert.equal(run.added, 205);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 205);
  assert.equal(auditCount('customer.created'), 205);

  const r = record('c-7');
  assert.equal(r.income_agorot, 10050);
  assert.equal(r.balance_agorot, -5050);
  assert.equal(r.source_updated_at, new Date((1_700_000_000 + 7) * 1000).toISOString());
  assert.ok(!r.raw.includes('123456') && !r.raw.includes('bankName'), 'bank details are not stored');
  const { display_name, phone, phone_norm, email } = customerOf('c-7');
  assert.deepEqual({ display_name, phone, phone_norm, email }, { display_name: 'לקוח 7', phone: '050-0000007', phone_norm: '0500000007', email: 'c7@example.com' });
  const [entry] = audit.list({ action: 'customer.created', pageSize: 1 }).items;
  assert.equal(entry.source, 'manual');
  assert.ok(entry.job_id);
  assert.ok(!JSON.stringify(entry).includes('incomeAgorot'), 'computed amounts are not audited');
});

test('a run with no changes writes nothing to the audit log', async () => {
  const before = audit.list({ pageSize: 1 }).total;
  const run = await runSync();
  assert.equal(run.unchanged, 205);
  assert.equal(run.added + run.updated, 0);
  assert.equal(audit.list({ pageSize: 1 }).total, before);
});

test('changes are saved and audited by field; amount-only changes are saved but not audited', async () => {
  clients[0] = { ...clients[0], name: 'לקוח אחד מעודכן', lastUpdateDate: 1_800_000_000 };
  clients[1] = { ...clients[1], active: false };
  clients[2] = { ...clients[2], incomeAmount: 999 };
  const run = await runSync();
  assert.equal(run.updated, 3);
  const [updated] = audit.list({ action: 'customer.updated' }).items;
  assert.equal(updated.external_id, 'c-1');
  assert.deepEqual(updated.changes, [{ field: 'name', from: 'לקוח 1', to: 'לקוח אחד מעודכן' }]);
  assert.equal(customerOf('c-1').display_name, 'לקוח אחד מעודכן');
  assert.equal(auditCount('customer.deactivated'), 1);
  assert.equal(audit.list({ action: 'customer.updated' }).total, 1, 'the amount change on c-3 is not audited');
  assert.equal(record('c-3').income_agorot, 99900);
});

test('a new record with a known phone joins that customer', async () => {
  clients.push(client(900, { name: 'לקוח 5 (כפול)', phone: '+972-50-000-0005', emails: [] }));
  const customersBefore = db.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
  await runSync();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customers').get().n, customersBefore);
  assert.equal(record('c-900').customer_id, record('c-5').customer_id);
  const [linked] = audit.list({ action: 'customer.identity_linked' }).items;
  assert.equal(linked.after.linkedBy, 'phone');
});

test('a customer is marked removed only after two complete runs without it, and restored when back', async () => {
  const removedClient = clients.find((c) => c.id === 'c-10');
  clients = clients.filter((c) => c.id !== 'c-10');
  let run = await runSync();
  assert.equal(run.removed, 0);
  assert.equal(record('c-10').missing_runs, 1);
  assert.equal(record('c-10').removed_at, null);

  run = await runSync();
  assert.equal(run.removed, 1);
  assert.ok(record('c-10').removed_at);
  assert.equal(auditCount('customer.removed_in_source'), 1);
  assert.equal(sync.knownCustomers(conn.id), 205);

  clients.push(removedClient);
  await runSync();
  assert.equal(record('c-10').removed_at, null);
  assert.equal(auditCount('customer.restored_in_source'), 1);
});

test('a run that returns far fewer customers than known marks nobody removed', async () => {
  const all = clients;
  clients = clients.slice(0, 20);
  await runSync();
  const run = await runSync();
  assert.equal(run.status, 'completed');
  assert.equal(run.removed, 0);
  assert.match(run.error, /דולג/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM acc_customer_records WHERE removed_at IS NOT NULL').get().n, 0);
  clients = all;
  await runSync();
});

test('a bad record is reported on the run; the rest are saved and no removals are marked', async () => {
  clients.push({ ...client(950), id: '' });
  clients.push(client(951));
  const run = await runSync();
  assert.equal(run.status, 'completed');
  assert.equal(run.failed, 1);
  assert.equal(run.item_errors.length, 1);
  assert.ok(record('c-951'));
  assert.match(run.error, /לא נשמרו/);
  clients = clients.filter((c) => c.id !== '');
});

test('server errors leave the run waiting for a retry; it then resumes and completes', async () => {
  failure = { status: 503 };
  sync.requestCustomerSync(conn.id, 'polling');
  await drain();
  let run = sync.latestCustomerRun(conn.id);
  assert.equal(run.status, 'running');
  const [page] = queue.list({ type: 'customers_page', status: 'retry' }).items;
  assert.ok(page, 'the page job waits for a retry');
  assert.equal(sync.requestCustomerSync(conn.id, 'manual').created, true);
  await drain();
  assert.equal(sync.latestCustomerRun(conn.id).id, run.id, 'no second run while one is still going');

  failure = null;
  db.prepare('UPDATE acc_jobs SET next_attempt_at = ? WHERE id = ?').run(new Date(Date.now() - 1).toISOString(), page.id);
  await drain();
  run = sync.latestCustomerRun(conn.id);
  assert.equal(run.status, 'completed');
  assert.equal(run.source, 'polling');
});

test('rejected credentials stop the run and mark the connection, which stops the schedule', async () => {
  failure = { status: 401 };
  const run = await runSync();
  assert.equal(run.status, 'failed');
  assert.match(run.error, /הרשאה/);
  assert.equal(connections.getConnectionView(conn.id).status, 'error');
  assert.deepEqual(polling.dueCustomerSyncs(Date.now() + 86_400_000), []);
  failure = null;
  db.prepare("UPDATE acc_connections SET status = 'ok' WHERE id = ?").run(conn.id);
  assert.equal((await runSync()).status, 'completed');
});

test('fetch_customer saves one customer, and reports one Morning no longer has', async () => {
  clients.push(client(777));
  queue.enqueue({ type: 'fetch_customer', source: 'webhook', connectionId: conn.id, payload: { externalId: 'c-777' } });
  queue.enqueue({ type: 'fetch_customer', source: 'webhook', connectionId: conn.id, payload: { externalId: 'missing' } });
  await drain();
  assert.ok(record('c-777'));
  const done = queue.list({ type: 'fetch_customer', status: 'completed' }).items;
  assert.deepEqual(done.map((j) => j.result).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), [{ notFound: true }, { result: 'added' }]);
});

test('a disabled connection cancels its run', async () => {
  failure = { status: 503 }; // keeps page 1 waiting for a retry
  sync.requestCustomerSync(conn.id, 'manual');
  await drain();
  failure = null;
  connections.updateConnection(conn.id, { enabled: false });
  db.prepare("UPDATE acc_jobs SET next_attempt_at = ? WHERE status = 'retry'").run(new Date(Date.now() - 1).toISOString());
  await drain();
  const run = sync.latestCustomerRun(conn.id);
  assert.equal(run.status, 'cancelled');
  connections.updateConnection(conn.id, { enabled: true });
});

test('schedule: first sync at once, then by the chosen interval, and only when the flags allow', () => {
  const other = connections.createConnection({ provider: 'morning', environment: 'sandbox', credentials: { clientId: 'id2', clientSecret: 's' } });
  assert.ok(!polling.dueCustomerSyncs().some((d) => d.connectionId === other.id), 'not before a successful check');
  db.prepare("UPDATE acc_connections SET status = 'ok' WHERE id = ?").run(other.id);
  assert.deepEqual(polling.dueCustomerSyncs().find((d) => d.connectionId === other.id), { connectionId: other.id, source: 'system' });
  connections.updateConnection(other.id, { enabled: false });

  const last = Date.parse(sync.latestCustomerRun(conn.id).started_at);
  assert.deepEqual(polling.dueCustomerSyncs(last + 59 * 60_000), []);
  assert.deepEqual(polling.dueCustomerSyncs(last + 60 * 60_000), [{ connectionId: conn.id, source: 'polling' }]);
  connections.updateConnection(conn.id, { settings: { customerSyncMinutes: 15 } });
  assert.equal(polling.dueCustomerSyncs(last + 15 * 60_000).length, 1);
  assert.equal(polling.customerSyncMinutes({ customerSyncMinutes: 7 }), 60);

  flags.setFlag('polling', false);
  assert.deepEqual(polling.dueCustomerSyncs(last + 86_400_000), []);
  flags.setFlag('polling', true);
  process.env.FEATURE_AUTO_SYNC = 'false';
  assert.deepEqual(polling.dueCustomerSyncs(last + 86_400_000), []);
  delete process.env.FEATURE_AUTO_SYNC;
});

test('flags: changes are audited; a value in .env locks the flag', () => {
  const [entry] = audit.list({ action: 'flag.changed' }).items;
  assert.deepEqual(entry.changes, [{ field: 'enabled', from: false, to: true }]);
  process.env.FEATURE_WEBHOOKS = 'false';
  assert.equal(flags.isEnabled('webhooks'), false);
  assert.equal(flags.listFlags().find((f) => f.key === 'webhooks').lockedByEnv, true);
  assert.throws(() => flags.setFlag('webhooks', true), /נעול/);
  delete process.env.FEATURE_WEBHOOKS;
  assert.equal(flags.isEnabled('webhooks'), true);
});

test('runs are listed newest first', () => {
  const runs = sync.listRuns({ connectionId: conn.id, pageSize: 2 });
  assert.equal(runs.items.length, 2);
  assert.ok(runs.items[0].id > runs.items[1].id);
  assert.ok(runs.total > 10);
});
