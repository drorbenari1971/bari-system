// "הזמנה חדשה": order validation, the Morning requests, and the steps that must never issue a
// receipt twice. A fake Morning records every call; data is fictional. Tests run in order.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { isolate, fakeFetch, noSleep } from './helpers.js';

const cleanup = isolate();
const { db } = await import('../db.js');
const connections = await import('../accounting/connections.js');
const orders = await import('../accounting/orders.js');
const sync = await import('../accounting/sync.js');
const audit = await import('../accounting/audit.js');
const { toMorningReceiptRequest, toMorningClientRequest } = await import('../accounting/providers/morning/mapper.js');
const { upsertDocument } = await import('../accounting/documentStore.js');
const { toCanonicalDocument } = await import('../accounting/providers/morning/mapper.js');
const router = (await import('../routes/accounting.js')).default;

// ---- fake Morning
const state = { clients: [], documents: [], failClient: null, failDoc: null, n: 0 };
const calls = () => api.calls.filter((c) => !c.url.includes('oauth'));
const posts = (path) => calls().filter((c) => c.method === 'POST' && c.url.endsWith(path));
const api = fakeFetch((c) => {
  if (c.url.includes('oauth')) return { body: { accessToken: 't', expiresAt: Math.floor(Date.now() / 1000) + 3600 } };
  const path = c.url.split('/api/v1')[1];
  if (path === '/items/search') return { body: { total: 2, pages: 1, items: [{ id: 'it-ghee', name: 'גהי', price: 80, currency: 'ILS' }, { id: 'it-broth', name: 'ציר עצמות 380 מ"ל', price: 60, currency: 'ILS' }] } };
  if (path === '/clients' && c.method === 'POST') {
    const f = state.failClient; state.failClient = null;
    const created = { id: `cl-${++state.n}`, ...c.body, emails: c.body.emails ?? [], creationDate: Math.floor(Date.now() / 1000), lastUpdateDate: Math.floor(Date.now() / 1000) };
    if (f === 'lost') { state.clients.push(created); return { status: 503, body: {} }; } // created, answer lost
    if (f) return { status: f, body: { errorCode: 2100, errorMessage: 'שגיאה' } };
    state.clients.push(created);
    return { status: 201, body: created };
  }
  if (path === '/clients/search') return { body: { total: state.clients.length, pages: 1, items: state.clients } };
  if (path === '/documents/preview') return { body: { file: Buffer.from('%PDF-1.4 preview').toString('base64') } };
  if (path === '/documents' && c.method === 'POST') {
    const f = state.failDoc; state.failDoc = null;
    const id = `doc-${++state.n}`;
    const doc = {
      id, type: 400, number: String(90000 + state.n), status: 0, documentDate: c.body.date, creationDate: Math.floor(Date.now() / 1000),
      currency: 'ILS', amountLocal: c.body.payment[0].price, vatLocal: 0, description: c.body.description ?? '',
      client: { id: c.body.client.id, name: c.body.client.name }, income: c.body.income.map((l) => ({ ...l, amountTotal: l.price * l.quantity })),
      payment: c.body.payment, url: { he: `https://example.test/${id}.pdf` },
    };
    if (f === 'lost') { state.documents.push(doc); return { status: 502, body: {} }; } // issued, answer lost
    if (f === 'network') throw new TypeError('fetch failed');
    if (f) return { status: f, body: { errorCode: 1100, errorMessage: 'שדה לא תקין' } };
    state.documents.push(doc);
    return { status: 201, body: { id, number: Number(doc.number), url: doc.url } };
  }
  if (path === '/documents/search') return { body: { total: state.documents.length, pages: 1, items: state.documents.filter((d) => !c.body.clientId || d.client.id === c.body.clientId) } };
  if (path.startsWith('/documents/')) {
    const d = state.documents.find((x) => x.id === decodeURIComponent(path.split('/')[2]));
    return d ? { body: d } : { status: 404, body: {} };
  }
  return { status: 404, body: {} };
});
orders.setOrderDeps({ fetch: api, sleep: noSleep });
sync.setProviderDeps({ fetch: api, sleep: noSleep });

const conn = connections.createConnection({ provider: 'morning', environment: 'sandbox', credentials: { clientId: 'id', clientSecret: 's' } });
db.prepare("UPDATE acc_connections SET status = 'ok' WHERE id = ?").run(conn.id);

const app = express();
app.use(express.json());
app.use('/api/accounting', router);
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}/api/accounting`;
after(async () => { await new Promise((r) => server.close(r)); await cleanup(); });

const today = new Date().toISOString().slice(0, 10);
let k = 0;
const key = () => `test-order-${++k}-abcdef`;
const order = (over = {}) => ({
  customer: { mode: 'new', name: 'נועה ברק', mobile: '050-1112233', email: 'noa@example.com', city: 'חיפה', ...over.customer },
  lines: over.lines ?? [{ description: 'גהי', quantity: 2, unitPrice: 8000, itemId: 'it-ghee' }, { description: 'ציר', quantity: 1, unitPrice: 6000 }],
  payment: { method: 'app', app: 'Bit', amount: 22000, date: today, reference: 'TX-1', ...over.payment },
  receipt: { date: today, description: 'הזמנה', remarks: '', sendEmail: false, ...over.receipt },
});
const orderRow = (id) => db.prepare('SELECT * FROM acc_orders WHERE id = ?').get(id);

test('validation: clear Hebrew errors; totals in agorot; payment must equal the order', () => {
  const v = (o, re) => assert.throws(() => orders.normalizeOrder(conn.id, o, today), re);
  v(order({ customer: { name: ' ' } }), /חסר שם/);
  v(order({ customer: { mobile: '123' } }), /נייד/);
  v(order({ customer: { email: 'not-an-email' } }), /מייל/);
  v(order({ customer: { taxId: '12ab' } }), /ח\.פ/);
  v({ ...order(), lines: [] }, /לפחות מוצר/);
  v(order({ lines: [{ description: 'x', quantity: 0, unitPrice: 100 }] }), /כמות/);
  v(order({ lines: [{ description: 'x', quantity: 1, unitPrice: 12.5 }] }), /מחיר/);
  v(order({ payment: { amount: 21999 } }), /שווה לסכום/);
  v(order({ payment: { app: 'Venmo' } }), /אפליקציית/);
  v(order({ payment: { date: '2999-01-01' } }), /עתידי/);
  v(order({ receipt: { date: '2026-02-30' } }), /לא תקין/);
  v(order({ customer: { email: '' }, receipt: { sendEmail: true } }), /מייל/);
  v({ ...order(), customer: { mode: 'other' } }, /לקוח קיים או לקוח חדש/);
  const ok = orders.normalizeOrder(conn.id, order(), today);
  assert.equal(ok.total, 22000);
  assert.equal(ok.customer.mobile, '0501112233');
});

test('Morning requests: receipt type 400, prices in shekels, catalog item ids, app payment, email only when asked', () => {
  const o = orders.normalizeOrder(conn.id, order(), today);
  o.customer.externalId = 'cl-x';
  const r = toMorningReceiptRequest(o);
  assert.equal(r.type, 400);
  assert.equal(r.vatType, 0);
  assert.deepEqual(r.income[0], { description: 'גהי', quantity: 2, price: 80, currency: 'ILS', vatType: 0, itemId: 'it-ghee' });
  assert.deepEqual(r.payment, [{ date: today, type: 10, price: 220, currency: 'ILS', appType: 1, transactionId: 'TX-1' }]);
  assert.deepEqual(r.client, { id: 'cl-x', name: 'נועה ברק', emails: [] });
  assert.deepEqual(toMorningReceiptRequest({ ...o, receipt: { ...o.receipt, sendEmail: true } }).client.emails, ['noa@example.com']);
  const transfer = toMorningReceiptRequest({ ...o, payment: { ...o.payment, method: 'bank_transfer', app: '' } }).payment[0];
  assert.equal(transfer.type, 4);
  assert.ok(!('transactionId' in transfer) && !('bankAccount' in transfer));
  const client = toMorningClientRequest(o.customer);
  assert.equal(client.send, false, 'Morning does not email this client automatically');
  assert.deepEqual(client.emails, ['noa@example.com']);
  assert.ok(!('bankAccount' in client));
});

test('catalog and preview: nothing is created', async () => {
  const items = await orders.catalog(conn.id);
  assert.deepEqual(items.map((i) => [i.name, i.price]), [['גהי', 8000], ['ציר עצמות 380 מ"ל', 6000]]);
  await orders.catalog(conn.id);
  assert.equal(posts('/items/search').length, 1, 'cached');
  const p = await orders.previewOrder(conn.id, order());
  assert.equal(Buffer.from(p.pdfBase64, 'base64').toString(), '%PDF-1.4 preview');
  assert.equal(posts('/clients').length + posts('/documents').length, 0);
});

test('new customer: one client card, one receipt, saved locally with its rows, all audited', async () => {
  const r = await orders.submitOrder(conn.id, 'order-new-customer-1', order());
  assert.equal(r.status, 'issued');
  assert.match(r.documentNumber, /^9000\d$/);
  assert.equal(posts('/clients').length, 1);
  assert.equal(posts('/documents').length, 1);
  const doc = db.prepare('SELECT * FROM acc_documents WHERE external_id = ?').get(orderRow(r.id).document_external_id);
  assert.equal(doc.customer_match, 'external_id', 'the receipt is linked to the new card, not by name');
  assert.equal(doc.customer_id, r.customerId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM acc_document_lines WHERE document_id = ?').get(doc.id).n, 2);
  const actions = audit.list({ entityType: 'order', entityId: r.id }).items.map((a) => a.action).reverse();
  assert.deepEqual(actions, ['order.created', 'order.client_created', 'order.issued']);
  assert.equal(audit.list({ action: 'document.created' }).total, 1);
});

test('the same order key never issues a second receipt', async () => {
  const before = posts('/documents').length;
  const r = await orders.submitOrder(conn.id, 'order-new-customer-1', order());
  assert.equal(r.status, 'issued');
  assert.equal(posts('/documents').length, before);
  assert.equal(posts('/clients').length, 1);
});

test('lost answer when issuing: one attempt only, the order is uncertain, and repeating does nothing', async () => {
  state.failDoc = 'lost';
  const k1 = key();
  const docsBefore = posts('/documents').length;
  const r = await orders.submitOrder(conn.id, k1, order({ customer: { name: 'עומר טל', mobile: '050-2223344', email: '' } }));
  assert.equal(r.status, 'uncertain');
  assert.match(r.error, /בדיקה/);
  assert.equal(posts('/documents').length, docsBefore + 1, 'no automatic retry of a create call');
  const again = await orders.submitOrder(conn.id, k1, order({ customer: { name: 'עומר טל', mobile: '050-2223344', email: '' } }));
  assert.equal(again.status, 'uncertain');
  assert.equal(posts('/documents').length, docsBefore + 1);
  // The check finds the receipt Morning did create.
  const checked = await orders.reconcileOrder(r.id);
  assert.equal(checked.status, 'issued');
  assert.equal(checked.documentNumber, state.documents.at(-1).number);
  assert.ok(db.prepare('SELECT 1 FROM acc_documents WHERE external_id = ?').get(state.documents.at(-1).id));
});

test('network failure when issuing: uncertain; the check finds nothing, so a retry may issue it', async () => {
  state.failDoc = 'network';
  const k2 = key();
  const input = order({ customer: { name: 'ליה דגן', mobile: '050-3334455', email: '' }, lines: [{ description: 'טאלו', quantity: 1, unitPrice: 6000 }], payment: { amount: 6000 } });
  const r = await orders.submitOrder(conn.id, k2, input);
  assert.equal(r.status, 'uncertain');
  const checked = await orders.reconcileOrder(r.id);
  assert.equal(checked.status, 'failed');
  const clientsBefore = posts('/clients').length;
  const retried = await orders.submitOrder(conn.id, k2, input);
  assert.equal(retried.status, 'issued');
  assert.equal(posts('/clients').length, clientsBefore, 'the client created before is reused');
});

test('a clear rejection (400) fails the order without uncertainty; fixing and resubmitting issues it', async () => {
  state.failDoc = 400;
  const k3 = key();
  const r = await orders.submitOrder(conn.id, k3, order({ customer: { name: 'גיא מור', mobile: '050-4445566', email: '' } }));
  assert.equal(r.status, 'failed');
  assert.match(r.error, /1100/);
  const fixed = await orders.submitOrder(conn.id, k3, order({ customer: { name: 'גיא מור', mobile: '050-4445566', email: '' }, receipt: { description: 'מתוקן' } }));
  assert.equal(fixed.status, 'issued');
});

test('lost answer when creating the client: the retry finds that client instead of creating another', async () => {
  state.failClient = 'lost';
  const k4 = key();
  const input = order({ customer: { name: 'תמר גל', mobile: '050-5556677', email: '' } });
  const r = await orders.submitOrder(conn.id, k4, input);
  assert.equal(r.status, 'failed');
  assert.equal(orderRow(r.id).client_uncertain, 1);
  const clientsBefore = posts('/clients').length;
  const retried = await orders.submitOrder(conn.id, k4, input);
  assert.equal(retried.status, 'issued');
  assert.equal(posts('/clients').length, clientsBefore, 'found the client created before');
  assert.equal(state.clients.filter((c) => c.name === 'תמר גל').length, 1);
});

test('a customer known only from receipts gets a card and keeps one history', async () => {
  upsertDocument(conn.id, toCanonicalDocument({ id: 'old-1', type: 400, number: '1', status: 0, documentDate: '2026-09-01', creationDate: 1_800_000_000, amountLocal: 100, vatLocal: 0, client: { name: 'שירה אלון' }, income: [], payment: [] }), { source: 'manual' });
  const customerId = db.prepare("SELECT customer_id FROM acc_documents WHERE external_id = 'old-1'").get().customer_id;
  const customersBefore = db.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
  const r = await orders.submitOrder(conn.id, key(), order({ customer: { mode: 'existing', customerId } }));
  assert.equal(r.status, 'issued');
  assert.equal(r.customerId, customerId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customers').get().n, customersBefore, 'no second customer');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM acc_documents WHERE customer_id = ?').get(customerId).n, 2);
});

test('an existing customer with a card: no client is created', async () => {
  const cardCustomer = db.prepare("SELECT customer_id FROM customer_identities WHERE kind = 'external_id' LIMIT 1").get().customer_id;
  const before = posts('/clients').length;
  const r = await orders.submitOrder(conn.id, key(), order({ customer: { mode: 'existing', customerId: cardCustomer } }));
  assert.equal(r.status, 'issued');
  assert.equal(posts('/clients').length, before);
});

test('routes: catalog, preview, submit, list uncertain, bad input, disabled connection', async () => {
  const get = (p) => fetch(`${base}${p}`).then(async (res) => ({ status: res.status, body: await res.json() }));
  const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (res) => ({ status: res.status, body: await res.json() }));
  assert.equal((await get(`/orders/catalog?connectionId=${conn.id}`)).body.length, 2);
  assert.equal((await post('/orders/preview', { connectionId: conn.id, order: order() })).status, 200);
  assert.equal((await post('/orders', { connectionId: conn.id, orderKey: 'bad key!', order: order() })).status, 400);
  assert.equal((await post('/orders', { connectionId: conn.id, orderKey: key(), order: order({ payment: { amount: 1 } }) })).status, 400);
  const ok = await post('/orders', { connectionId: conn.id, orderKey: key(), order: order({ customer: { name: 'דרך הנתיב', mobile: '050-6667788', email: '' } }) });
  assert.equal(ok.body.status, 'issued');
  assert.equal((await get(`/orders/${ok.body.id}`)).body.documentNumber, ok.body.documentNumber);
  assert.equal((await get('/orders?status=issued')).body.total >= 1, true);
  assert.equal((await post(`/orders/${ok.body.id}/reconcile`, {})).status, 409, 'only uncertain orders are checked');
  connections.updateConnection(conn.id, { enabled: false });
  assert.equal((await post('/orders', { connectionId: conn.id, orderKey: key(), order: order() })).status, 409);
  connections.updateConnection(conn.id, { enabled: true });
});
