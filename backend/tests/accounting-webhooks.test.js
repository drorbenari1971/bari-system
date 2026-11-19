// Webhook receiver: real HTTP requests to the receiver on a random port, a fake Morning API for the
// fetch that follows, and fictional data. Tests run in order and share state.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { isolate, fakeFetch, noSleep } from './helpers.js';

const cleanup = isolate();
const { db } = await import('../db.js');
const connections = await import('../accounting/connections.js');
const queue = await import('../accounting/queue.js');
const worker = await import('../accounting/worker.js');
const audit = await import('../accounting/audit.js');
const sync = await import('../accounting/sync.js');
const flags = await import('../accounting/flags.js');
const config = await import('../accounting/webhookConfig.js');
const receiver = await import('../accounting/webhookReceiver.js');
const health = await import('../accounting/webhookHealth.js');
const { upsertCustomerRecord } = await import('../accounting/customerStore.js');
const { toCanonicalCustomer } = await import('../accounting/providers/morning/mapper.js');
const morning = (await import('../accounting/providers/morning/index.js')).default;
const router = (await import('../routes/accounting.js')).default;

// ---- fake Morning API (the source of truth the jobs read from)
const apiClients = new Map([['c-1', { id: 'c-1', name: 'שם מה-API', phone: '050-1111111', emails: [], lastUpdateDate: 1_800_000_000 }]]);
let apiDown = false;
const api = fakeFetch((c) => {
  if (c.url.includes('oauth')) return { body: { accessToken: 't', expiresAt: Math.floor(Date.now() / 1000) + 3600 } };
  if (apiDown) return { status: 503, body: {} };
  const found = apiClients.get(decodeURIComponent(c.url.split('/clients/')[1]));
  return found ? { body: found } : { status: 404, body: {} };
});
sync.setProviderDeps({ fetch: api, sleep: noSleep });

const conn = connections.createConnection({ provider: 'morning', environment: 'sandbox', credentials: { clientId: 'id', clientSecret: 's' } });
db.prepare("UPDATE acc_connections SET status = 'ok' WHERE id = ?").run(conn.id);
let { secret, path } = config.createSecret(conn.id);

const server = receiver.createReceiver();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const app = express();
app.use(express.json());
app.use('/api/accounting', router);
const appServer = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const appBase = `http://127.0.0.1:${appServer.address().port}/api/accounting`;
const call = async (method, p, body) => {
  const res = await fetch(`${appBase}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => appServer.close(r));
  await cleanup();
});

const sign = (key, raw) => crypto.createHmac('sha256', key).update(raw).digest('hex');
let n = 0;
async function deliver({ body = { id: 'c-1', name: 'שם מה-Webhook' }, raw, topic = 'client/created', deliveryId = `d-${++n}`, key = secret, signature, to = path, method = 'POST', ip = '203.0.113.5', contentType = 'application/json' } = {}) {
  const rawBody = raw ?? Buffer.from(JSON.stringify(body));
  const headers = {
    'content-type': contentType, 'x-webhook-topic': topic, 'x-webhook-delivery-id': deliveryId, 'x-webhook-id': 'wh-1',
    'x-webhook-timestamp': new Date().toISOString(), 'user-agent': 'morning webhooks 2.1', 'x-forwarded-for': ip,
    'x-webhook-signature': signature ?? sign(key, rawBody), cookie: 'must-not-be-kept=1',
  };
  const res = await fetch(`${base}${to}`, { method, headers, body: method === 'POST' ? rawBody : undefined });
  return res.status;
}
const lastDelivery = () => db.prepare('SELECT * FROM acc_webhook_archive ORDER BY id DESC LIMIT 1').get();
const webhookJobs = () => db.prepare("SELECT * FROM acc_jobs WHERE source = 'webhook'").all();
async function drain() {
  for (let i = 0; i < 100; i++) {
    worker.kick();
    await worker.idle();
    const c = queue.counts();
    if (!c.pending && !c.processing) return;
  }
}
const ago = (ms) => new Date(Date.now() - ms).toISOString();

test('address token and HMAC secret are separate, random, and the secret is never shown again', async () => {
  assert.match(secret, /^[A-Za-z0-9]{32}$/);
  assert.match(path, /^\/morning\/[A-Za-z0-9_-]{32}$/);
  const stored = db.prepare('SELECT webhook_secret_enc, settings FROM acc_connections WHERE id = ?').get(conn.id);
  assert.ok(!stored.webhook_secret_enc.includes(secret), 'secret stored encrypted');
  assert.ok(!path.includes(secret) && !secret.includes(path.split('/').pop()));
  const view = await call('GET', `/connections/${conn.id}/webhook`);
  assert.equal(view.body.secretSet, true);
  assert.ok(!JSON.stringify(view.body).includes(secret), 'the webhook view never contains the secret');
  const list = await call('GET', '/connections');
  assert.ok(!JSON.stringify(list.body).includes(secret) && !JSON.stringify(list.body).includes(path.split('/').pop()), 'connections list has neither');
  assert.ok(!JSON.stringify(audit.list({ pageSize: 200 })).includes(secret), 'audit never contains the secret');
  assert.equal(audit.list({ action: 'connection.webhook_secret_created' }).total, 1);
  const put = await call('PUT', `/connections/${conn.id}`, { settings: { webhook: { pathToken: 'x'.repeat(32) } } });
  assert.equal(put.status, 400, 'the setup cannot be overwritten through settings');
});

test('WEBHOOKS_ENABLED is off by default: genuine deliveries are acknowledged but create no work', async () => {
  assert.equal(flags.isEnabled('webhooks'), false);
  assert.equal(await deliver(), 200);
  assert.equal(lastDelivery().outcome, 'disabled');
  assert.equal(lastDelivery().rejection_reason, 'flag_off');
  assert.equal(webhookJobs().length, 0);
});

test('client/created queues a fetch; the data comes from the API, not from the delivery', async () => {
  flags.setFlag('webhooks', true);
  const before = api.calls.length;
  const status = await deliver();
  assert.equal(status, 200);
  const d = lastDelivery();
  assert.equal(d.outcome, 'accepted');
  assert.equal(d.signature_valid, 1);
  const [job] = webhookJobs();
  assert.equal(job.type, 'fetch_customer');
  assert.deepEqual(JSON.parse(job.payload), { externalId: 'c-1' });
  assert.equal(d.job_id, job.id);
  await drain();
  assert.ok(api.calls.length > before);
  const rec = db.prepare("SELECT * FROM acc_customer_records WHERE external_id = 'c-1'").get();
  assert.equal(rec.name, 'שם מה-API');
  const [created] = audit.list({ action: 'customer.created' }).items;
  assert.equal(created.source, 'webhook');
});

test('no payload is kept: only chosen headers, hash and size', () => {
  const d = lastDelivery();
  assert.equal(d.body, null);
  const raw = Buffer.from(JSON.stringify({ id: 'c-1', name: 'שם מה-Webhook' }));
  assert.equal(d.body_sha256, crypto.createHash('sha256').update(raw).digest('hex'));
  assert.equal(d.body_size, raw.length);
  const kept = Object.keys(JSON.parse(d.headers));
  assert.ok(kept.every((h) => morning.webhooks.KEPT_HEADERS.includes(h)));
  assert.ok(!kept.includes('x-webhook-signature') && !kept.includes('cookie'));
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM acc_webhook_archive').all()).includes('שם מה-Webhook'), 'no customer data anywhere in the archive');
  assert.equal(d.topic, 'client/created');
  assert.ok(d.delivery_id && d.event_timestamp);
});

test('the same delivery twice is recorded as a duplicate and creates no job', async () => {
  const jobs = webhookJobs().length;
  assert.equal(await deliver({ deliveryId: 'same' }), 200);
  assert.equal(await deliver({ deliveryId: 'same' }), 200);
  assert.equal(lastDelivery().outcome, 'duplicate');
  assert.equal(webhookJobs().length, jobs + 1);
});

test('Morning API down: the receiver still answers 200 at once, and the queue retries (not the HTTP request)', async () => {
  apiDown = true;
  apiClients.set('c-2', { id: 'c-2', name: 'לקוח שתיים', phone: '050-2222222', emails: [] });
  const started = Date.now();
  assert.equal(await deliver({ body: { id: 'c-2' } }), 200);
  assert.ok(Date.now() - started < 1000, 'answered without waiting for the API');
  await drain();
  const [job] = queue.list({ type: 'fetch_customer', status: 'retry' }).items;
  assert.equal(job.source, 'webhook');
  // More deliveries for the same customer while it waits: still one job.
  assert.equal(await deliver({ body: { id: 'c-2' } }), 200);
  assert.equal(await deliver({ body: { id: 'c-2' } }), 200);
  assert.equal(webhookJobs().filter((j) => JSON.parse(j.payload).externalId === 'c-2').length, 1);
  apiDown = false;
  db.prepare('UPDATE acc_jobs SET next_attempt_at = ? WHERE id = ?').run(ago(1), job.id);
  await drain();
  assert.ok(db.prepare("SELECT 1 FROM acc_customer_records WHERE external_id = 'c-2'").get());
});

test('the receiver never calls Morning and never retries: ingest is synchronous, one archive row per request', () => {
  const rows = db.prepare('SELECT COUNT(*) AS n FROM acc_webhook_archive').get().n;
  const raw = Buffer.from(JSON.stringify({ id: 'c-1' }));
  const callsBefore = api.calls.length;
  worker.stopWorker();
  const result = receiver.ingest({
    connectionId: conn.id, provider: morning, remoteIp: 'x', rawBody: raw,
    headers: { 'x-webhook-topic': 'client/created', 'x-webhook-delivery-id': 'sync-check', 'x-webhook-signature': sign(secret, raw) },
  });
  assert.ok(!(result instanceof Promise));
  assert.equal(result.status, 200);
  assert.equal(api.calls.length, callsBefore, 'no API call while answering');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM acc_webhook_archive').get().n, rows + 1);
});

test('events arriving out of order end in the state the API has now', async () => {
  apiClients.set('c-3', { id: 'c-3', name: 'מצב נוכחי', phone: '050-3333333', emails: [], lastUpdateDate: 1_900_000_000 });
  await deliver({ body: { id: 'c-3', name: 'ישן' }, deliveryId: 'late-2' });
  await deliver({ body: { id: 'c-3', name: 'ישן יותר' }, deliveryId: 'late-1' });
  await drain();
  assert.equal(db.prepare("SELECT name FROM acc_customer_records WHERE external_id = 'c-3'").get().name, 'מצב נוכחי');
});

test('forged or broken signatures are rejected with 401 and create no work', async () => {
  const jobs = webhookJobs().length;
  const raw = Buffer.from(JSON.stringify({ id: 'c-9' }));
  const tampered = Buffer.from(JSON.stringify({ id: 'c-8' }));
  for (const [opts, label] of [
    [{ key: 'wrong-secret' }, 'wrong secret'],
    [{ raw: tampered, signature: sign(secret, raw) }, 'changed body'],
    [{ signature: '' }, 'missing'],
    [{ signature: 'zz'.repeat(32) }, 'not hex'],
    [{ signature: 'ab' }, 'wrong length'],
  ]) {
    assert.equal(await deliver({ ip: `198.51.100.${label.length}`, ...opts }), 401, label);
    assert.equal(lastDelivery().outcome, 'rejected');
    assert.equal(lastDelivery().rejection_reason, 'bad_signature');
  }
  assert.equal(webhookJobs().length, jobs);
  receiver.resetProtection();
});

test('wrong address, method, content type or size never reach processing', async () => {
  const rows = db.prepare('SELECT COUNT(*) AS n FROM acc_webhook_archive').get().n;
  assert.equal(await deliver({ to: `/morning/${'A'.repeat(32)}` }), 404);
  assert.equal(await deliver({ to: '/api/accounting/connections' }), 404);
  assert.equal(await deliver({ to: `/other/${path.split('/').pop()}` }), 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM acc_webhook_archive').get().n, rows, 'unknown addresses are not even recorded');
  assert.equal(await deliver({ method: 'GET' }), 405);
  assert.equal(await deliver({ contentType: 'text/plain' }), 415);
  assert.equal(lastDelivery().rejection_reason, 'content_type');
  assert.equal(await deliver({ raw: Buffer.alloc(receiver.LIMITS.maxBodyBytes + 10, 32) }), 413);
  assert.equal(lastDelivery().rejection_reason, 'too_large');
  receiver.resetProtection();
});

test('a connection without a secret rejects everything', async () => {
  const enc = db.prepare('SELECT webhook_secret_enc FROM acc_connections WHERE id = ?').get(conn.id).webhook_secret_enc;
  db.prepare('UPDATE acc_connections SET webhook_secret_enc = NULL WHERE id = ?').run(conn.id);
  assert.equal(await deliver(), 401);
  assert.equal(lastDelivery().rejection_reason, 'no_secret');
  db.prepare('UPDATE acc_connections SET webhook_secret_enc = ? WHERE id = ?').run(enc, conn.id);
});

test('document/created is not active yet; unknown topics and unreadable bodies are acknowledged without work', async () => {
  const jobs = webhookJobs().length;
  assert.equal(await deliver({ topic: 'document/created', body: { id: 'doc-1', recipient: { id: 'c-1' } } }), 200);
  assert.equal(lastDelivery().outcome, 'ignored');
  assert.equal(await deliver({ topic: 'expense/file-updated', body: { id: 'e-1' } }), 200);
  assert.equal(lastDelivery().outcome, 'ignored');
  assert.equal(await deliver({ raw: Buffer.from('{not json') }), 200);
  assert.equal(lastDelivery().outcome, 'unreadable');
  assert.equal(await deliver({ body: { name: 'בלי מזהה' } }), 200);
  assert.equal(lastDelivery().outcome, 'unreadable');
  assert.equal(webhookJobs().length, jobs);
  assert.deepEqual(morning.webhooks.supportedTopics(), ['client/created']);
});

test('a disabled connection acknowledges and does nothing', async () => {
  connections.updateConnection(conn.id, { enabled: false });
  assert.equal(await deliver(), 200);
  assert.equal(lastDelivery().rejection_reason, 'connection_disabled');
  connections.updateConnection(conn.id, { enabled: true });
});

test('rate limits per address, and blocks an address after repeated bad signatures', async () => {
  receiver.resetProtection();
  const statuses = [];
  for (let i = 0; i <= receiver.LIMITS.perIpPerMinute; i++) statuses.push(await deliver({ deliveryId: 'flood', ip: '192.0.2.1' }));
  assert.equal(statuses.at(-1), 429);
  assert.equal(statuses.filter((s) => s === 200).length, receiver.LIMITS.perIpPerMinute);
  assert.equal(await deliver({ ip: '192.0.2.2' }), 200, 'other addresses still pass');

  receiver.resetProtection();
  for (let i = 0; i < receiver.LIMITS.badSignaturesBeforeBlock; i++) await deliver({ key: 'guess', ip: '192.0.2.9' });
  assert.equal(await deliver({ ip: '192.0.2.9' }), 403, 'blocked even with a valid signature');
  assert.equal(await deliver({ ip: '192.0.2.10' }), 200);
  receiver.resetProtection();
});

test('monitoring: failures in a row raise an error before Morning would disable the webhook', async () => {
  for (let i = 0; i < 3; i++) await deliver({ key: 'misconfigured', ip: `192.0.2.${50 + i}` });
  let h = health.webhookHealth(conn.id);
  assert.equal(h.status, 'error');
  assert.equal(h.failureStreak, 3);
  assert.match(h.warnings.find((w) => w.code === 'failing').text, /15/);
  assert.equal(h.secretMismatch, 3, 'signed by Morning (its user agent) but with another secret');
  assert.match(h.warnings.find((w) => w.code === 'secret_mismatch').text, /החלף סוד/);
  assert.equal(await deliver({ ip: '192.0.2.60' }), 200);
  h = health.webhookHealth(conn.id);
  assert.equal(h.failureStreak, 0);
  assert.equal(h.status, 'ok');
  receiver.resetProtection();
});

test('monitoring: Morning stopped sending - a customer that only the periodic sync brought in raises an alert, once', () => {
  // Webhooks turned on two hours ago.
  const settings = JSON.parse(db.prepare('SELECT settings FROM acc_connections WHERE id = ?').get(conn.id).settings);
  settings.webhook.activatedAt = ago(2 * 3_600_000);
  db.prepare('UPDATE acc_connections SET settings = ? WHERE id = ?').run(JSON.stringify(settings), conn.id);
  db.prepare("UPDATE acc_audit_log SET at = ? WHERE action = 'flag.changed' AND entity_id = 'webhooks'").run(ago(2 * 3_600_000));

  // Created in Morning 30 minutes ago, saved now by the periodic sync, no webhook ever came.
  const missedClient = toCanonicalCustomer({ id: 'c-missed', name: 'הגיע רק בסנכרון', phone: '050-4444444', creationDate: Math.floor(Date.now() / 1000) - 1800 });
  upsertCustomerRecord(conn.id, missedClient, { source: 'polling' });
  // Created 30 minutes ago too, but a webhook did come for it (its job exists): not counted.
  queue.enqueue({ type: 'fetch_customer', source: 'webhook', connectionId: conn.id, payload: { externalId: 'c-came' } });
  upsertCustomerRecord(conn.id, toCanonicalCustomer({ id: 'c-came', name: 'הגיע ב-Webhook', phone: '050-5555555', creationDate: Math.floor(Date.now() / 1000) - 1800 }), { source: 'polling' });

  const h = health.webhookHealth(conn.id);
  assert.equal(h.missed, 1);
  assert.equal(h.status, 'error');
  assert.match(h.warnings.find((w) => w.code === 'missed').text, /הפעילו אותו מחדש/);
  const warn = console.warn;
  const logged = [];
  console.warn = (m) => logged.push(m);
  try {
    assert.equal(health.alertOnChange().length, 1);
    assert.equal(health.alertOnChange().length, 0, 'no repeat while the problem stays');
  } finally { console.warn = warn; }
  assert.equal(logged.length, 1);
  assert.match(logged[0], /missed/);
});

test('monitoring: turning webhooks off and on keeps an earlier miss; a customer created while off is not counted', () => {
  // Off 20 minutes ago, on again 5 minutes ago (c-missed was created 30 minutes ago, while on).
  flags.setFlag('webhooks', false);
  flags.setFlag('webhooks', true);
  const [on, off] = db.prepare("SELECT id FROM acc_audit_log WHERE action = 'flag.changed' AND entity_id = 'webhooks' ORDER BY id DESC LIMIT 2").all();
  db.prepare('UPDATE acc_audit_log SET at = ? WHERE id = ?').run(ago(20 * 60_000), off.id);
  db.prepare('UPDATE acc_audit_log SET at = ? WHERE id = ?').run(ago(5 * 60_000), on.id);
  assert.equal(health.webhookOnPeriods(null).length, 2);
  // Created 15 minutes ago, while webhooks were off; saved now by the periodic sync.
  upsertCustomerRecord(conn.id, toCanonicalCustomer({ id: 'c-off', name: 'נוצר כשהמתג כבוי', phone: '050-6666666', creationDate: Math.floor(Date.now() / 1000) - 900 }), { source: 'polling' });
  assert.equal(health.webhookHealth(conn.id).missed, 1, 'still the one missed while on; not the one created while off');
  db.prepare("DELETE FROM acc_customer_records WHERE external_id = 'c-off'").run();
});

test('monitoring: no delivery for 7 days is a warning', () => {
  db.prepare("DELETE FROM acc_customer_records WHERE external_id IN ('c-missed', 'c-came')").run();
  const h = health.webhookHealth(conn.id, Date.now() + 8 * 86_400_000);
  assert.ok(h.warnings.some((w) => w.code === 'quiet'));
});

test('new address keeps the secret; new secret keeps the address', async () => {
  const oldPath = path;
  const view = await call('POST', `/connections/${conn.id}/webhook/token`);
  path = view.body.path;
  assert.notEqual(path, oldPath);
  assert.equal(await deliver({ to: oldPath }), 404);
  assert.equal(await deliver(), 200, 'same secret works at the new address');

  const oldSecret = secret;
  const rotated = await call('POST', `/connections/${conn.id}/webhook/secret`);
  secret = rotated.body.secret;
  assert.notEqual(secret, oldSecret);
  assert.equal(rotated.body.path, path, 'address unchanged');
  assert.equal(await deliver({ key: oldSecret }), 401);
  assert.equal(await deliver(), 200);
  assert.equal(audit.list({ action: 'connection.webhook_secret_rotated' }).total, 1);
  assert.equal(audit.list({ action: 'connection.webhook_token_rotated' }).total, 1);
  receiver.resetProtection();
});

test('the screen API: health, delivery log without payloads, and replay of an accepted delivery', async () => {
  const view = await call('GET', `/connections/${conn.id}/webhook`);
  assert.equal(view.status, 200);
  assert.ok(view.body.deliveries.length > 0);
  assert.ok(view.body.deliveries.every((d) => !('body' in d) && !('headers' in d)));
  const accepted = view.body.deliveries.find((d) => d.outcome === 'accepted' && d.job_id);
  const replay = await call('POST', `/webhook-deliveries/${accepted.id}/replay`);
  assert.equal(replay.status, 202);
  assert.equal(queue.getJob(replay.body.jobId).source, 'replay');
  const rejected = view.body.deliveries.find((d) => d.outcome === 'rejected');
  assert.equal((await call('POST', `/webhook-deliveries/${rejected.id}/replay`)).status, 409);
  const h = await call('GET', '/health');
  assert.equal(h.body.webhooks[0].connectionId, conn.id);
});

test('archive rows are removed after 30 days', () => {
  db.prepare('UPDATE acc_webhook_archive SET received_at = ? WHERE id = (SELECT MIN(id) FROM acc_webhook_archive)').run(ago(31 * 86_400_000));
  assert.equal(receiver.cleanupArchive(), 1);
});
