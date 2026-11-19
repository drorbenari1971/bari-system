// "מחיקת לקוח": Morning card first (only when Morning allows it), then everything local, and the
// next sync must not bring the customer or its receipts back. A fake Morning; data is fictional.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { isolate, fakeFetch, noSleep } from './helpers.js';

const cleanup = isolate();
const { db } = await import('../db.js');
const connections = await import('../accounting/connections.js');
const customerDelete = await import('../accounting/customerDelete.js');
const { upsertCustomerRecord } = await import('../accounting/customerStore.js');
const { upsertDocument } = await import('../accounting/documentStore.js');
const { toCanonicalCustomer, toCanonicalDocument } = await import('../accounting/providers/morning/mapper.js');
const router = (await import('../routes/accounting.js')).default;

// ---- fake Morning: clients with active flags; a client with documents cannot be deleted
const state = { clients: new Map(), withDocs: new Set(), down: false };
const api = fakeFetch((c) => {
  if (c.url.includes('oauth')) return { body: { accessToken: 't', expiresAt: Math.floor(Date.now() / 1000) + 3600 } };
  if (state.down) throw new TypeError('fetch failed');
  const [, , id] = c.url.split('/api/v1')[1].split('/');
  const client = state.clients.get(decodeURIComponent(id ?? ''));
  if (!client) return { status: 404, body: { errorCode: 404, errorMessage: 'לא נמצא' } };
  if (c.method === 'PUT') { Object.assign(client, c.body); return { body: client }; }
  if (c.method === 'DELETE') {
    if (client.active || state.withDocs.has(client.id)) return { status: 400, body: { errorCode: 2403, errorMessage: 'לא ניתן למחוק לקוח' } };
    state.clients.delete(client.id);
    return { status: 200 }; // empty body, as in the spec
  }
  return { status: 404, body: {} };
});
customerDelete.setDeleteDeps({ fetch: api, sleep: noSleep });
const morningCalls = () => api.calls.filter((c) => !c.url.includes('oauth')).map((c) => `${c.method} ${c.url.split('/api/v1')[1]}${c.body ? ` ${JSON.stringify(c.body)}` : ''}`);

const conn = connections.createConnection({ provider: 'morning', environment: 'sandbox', credentials: { clientId: 'id', clientSecret: 's' } });

const app = express();
app.use(express.json());
app.use('/api/accounting', router);
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}/api/accounting`;
after(async () => { await new Promise((r) => server.close(r)); await cleanup(); });

const ctx = { source: 'polling' };
const morningClient = (id, name, active = true) => {
  state.clients.set(id, { id, name, active });
  return toCanonicalCustomer({ id, name, active, phone: '', mobile: '', emails: [], creationDate: 1700000000, lastUpdateDate: 1700000000 });
};
const receipt = (id, client, amount) => toCanonicalDocument({
  id, type: 400, number: id.replace(/\D/g, ''), status: 0, documentDate: '2026-10-01', creationDate: 1759300000,
  currency: 'ILS', amountLocal: amount, vatLocal: 0, description: 'גהי', client, income: [], payment: [{ type: 10, price: amount, appType: 1 }],
});
const customerOf = (externalId) => db.prepare("SELECT customer_id FROM customer_identities WHERE kind = 'external_id' AND value = ?").get(externalId)?.customer_id;
const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const del = (id) => fetch(`${base}/customers/${id}`, { method: 'DELETE' }).then(async (r) => ({ status: r.status, body: await r.json() }));

test('a card with no documents is deactivated and deleted in Morning, then locally', async () => {
  upsertCustomerRecord(conn.id, morningClient('cl-a', 'לקוח בדיקה א'), ctx);
  const id = customerOf('cl-a');
  const plan = await (await fetch(`${base}/customers/${id}/delete-plan`)).json();
  assert.deepEqual(plan.cards.map((c) => c.morning), ['delete']);
  assert.equal(plan.documents, 0);

  const r = await del(id);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.cards, [{ externalId: 'cl-a', morning: 'delete' }]);
  assert.deepEqual(morningCalls(), ['PUT /clients/cl-a {"active":false}', 'DELETE /clients/cl-a']);
  assert.equal(state.clients.has('cl-a'), false);
  assert.equal(db.prepare('SELECT 1 FROM customers WHERE id = ?').get(id), undefined);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM customer_identities WHERE customer_id = ?").get(id).n, 0);
  const entry = db.prepare("SELECT * FROM acc_audit_log WHERE action = 'customer.deleted'").get();
  assert.equal(entry.entity_id, String(id));
});

test('a customer with receipts: the card stays in Morning, receipts are deleted here only, and sync does not bring them back', async () => {
  api.calls.length = 0;
  upsertCustomerRecord(conn.id, morningClient('cl-b', 'לקוח בדיקה ב'), ctx);
  state.withDocs.add('cl-b');
  const r1 = receipt('doc-101', { id: 'cl-b', name: 'לקוח בדיקה ב' }, 120);
  const r2 = receipt('doc-102', { name: 'לקוח בדיקה ב' }, 80); // matched by name
  upsertDocument(conn.id, r1, ctx);
  upsertDocument(conn.id, r2, ctx);
  const id = customerOf('cl-b');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM acc_documents WHERE customer_id = ?').get(id).n, 2);

  const r = await del(id);
  assert.equal(r.status, 200);
  assert.equal(r.body.documents, 2);
  assert.deepEqual(r.body.cards, [{ externalId: 'cl-b', morning: 'has_documents' }]);
  assert.deepEqual(morningCalls(), [], 'Morning is not called for a card with documents');
  assert.equal(state.clients.get('cl-b').active, true, 'nothing changed in Morning');
  assert.equal(count('acc_documents'), 0);
  assert.equal(count('acc_document_payments'), 0);

  // The next sync returns the same card and receipts: all skipped.
  assert.equal(upsertCustomerRecord(conn.id, morningClient('cl-b', 'לקוח בדיקה ב'), ctx), 'unchanged');
  assert.equal(upsertDocument(conn.id, r1, ctx), 'unchanged');
  assert.equal(upsertDocument(conn.id, r2, ctx), 'unchanged');
  assert.equal(count('acc_documents'), 0);
  assert.equal(customerOf('cl-b'), undefined);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM customers WHERE display_name = 'לקוח בדיקה ב'").get().n, 0);
});

test('Morning refuses: the card is reactivated and nothing is deleted locally', async () => {
  api.calls.length = 0;
  upsertCustomerRecord(conn.id, morningClient('cl-c', 'לקוח בדיקה ג'), ctx);
  state.withDocs.add('cl-c'); // Morning has documents this system does not know about
  const id = customerOf('cl-c');
  const r = await del(id);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Morning לא אישרה/);
  assert.match(r.body.error, /הלקוח לא נמחק/);
  assert.deepEqual(morningCalls(), ['PUT /clients/cl-c {"active":false}', 'DELETE /clients/cl-c', 'PUT /clients/cl-c {"active":true}']);
  assert.equal(state.clients.get('cl-c').active, true);
  assert.ok(db.prepare('SELECT 1 FROM customers WHERE id = ?').get(id));
});

test('no connection to Morning: nothing is deleted', async () => {
  upsertCustomerRecord(conn.id, morningClient('cl-d', 'לקוח בדיקה ד', false), ctx);
  const id = customerOf('cl-d');
  state.down = true;
  const r = await del(id);
  state.down = false;
  assert.notEqual(r.status, 200);
  assert.ok(db.prepare('SELECT 1 FROM customers WHERE id = ?').get(id));
});

test('an inactive card is deleted without a deactivate call; a card already gone counts as removed', async () => {
  api.calls.length = 0;
  const id = customerOf('cl-d');
  assert.equal((await del(id)).status, 200);
  assert.deepEqual(morningCalls(), ['DELETE /clients/cl-d']);

  upsertCustomerRecord(conn.id, morningClient('cl-e', 'לקוח בדיקה ה'), ctx);
  state.clients.delete('cl-e'); // deleted in Morning meanwhile
  const r = await del(customerOf('cl-e'));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.cards, [{ externalId: 'cl-e', morning: 'already_removed' }]);
});

test('a customer without a card (from receipts only) is deleted without calling Morning', async () => {
  api.calls.length = 0;
  upsertDocument(conn.id, receipt('doc-201', { name: 'לקוחה מקבלות' }, 50), ctx);
  const id = db.prepare("SELECT id FROM customers WHERE display_name = 'לקוחה מקבלות'").get().id;
  const r = await del(id);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.cards, []);
  assert.deepEqual(morningCalls(), []);
  assert.equal((await del(id)).status, 404);
});
