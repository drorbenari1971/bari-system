// Document sync against a fake Morning (fictional customers and receipts). Tests run in order.
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
const { toCanonicalDocument } = await import('../accounting/providers/morning/mapper.js');

// ---- fake Morning
const clients = [
  { id: 'c-1', name: 'דנה כהן', phone: '050-1110001', emails: [] },
  { id: 'c-2', name: 'שרה לוי', phone: '050-1110002', emails: [] },
  { id: 'c-3', name: 'שרה לוי', phone: '050-1110003', emails: [] }, // same name, different person
  { id: 'c-4', name: 'נועה ברק', phone: '050-1110004', emails: [] }, // a card with no receipts of its own
];
const receipt = (id, client, extra = {}) => ({
  id, type: 400, number: id.replace('d-', '8'), status: 0, documentDate: '2026-11-01', creationDate: 1_800_000_000,
  currency: 'ILS', amountLocal: 120, vatLocal: 0, description: 'ציר', client,
  income: [], payment: [{ type: 10, name: 'אפליקציית תשלום', description: 'bit', price: 120 }],
  url: { he: `https://example.test/${id}.pdf` }, ...extra,
});
let docs = [
  receipt('d-1', { id: 'c-1', name: 'דנה כהן' }),
  receipt('d-2', { name: '  דנה   כהן ' }),                                  // no card: same name as c-1
  receipt('d-3', { name: 'רון אבן', emails: ['Ron@Example.com'] }),           // new customer with email
  receipt('d-4', { name: 'ר. אבן', emails: ['ron@example.com'] }),            // same email, other name
  receipt('d-5', { name: 'מיכל' }),
  receipt('d-6', { name: 'מיכל' }),                                          // second receipt by name
  receipt('d-7', { name: 'אורי' }, { payment: [{ type: 4, name: 'העברה בנקאית', description: 'בנק 99 / סניף 111 / מס\' חשבון 123456', price: 120 }] }),
  receipt('d-8', { name: 'שרה לוי' }),                                       // two customers carry this name
  { ...receipt('d-9', { id: 'c-1', name: 'דנה כהן' }), type: 305, amountLocal: 117, vatLocal: 17,
    income: [{ catalogNum: 'BRT-1', itemId: 'it-1', description: 'ציר עצמות', quantity: 2, price: 50, amountTotal: 100 }] },
  receipt('d-10', { name: 'בלי תאריך' }, { documentDate: '' }),              // bad record
  receipt('d-12', { name: 'נועה ברק' }),                                     // first link of a card by name
];
let failDocs = false;
const fetch = fakeFetch((c) => {
  if (c.url.includes('oauth')) return { body: { accessToken: 't', expiresAt: Math.floor(Date.now() / 1000) + 3600 } };
  const page = (list) => {
    const { page: p, pageSize } = c.body;
    return { body: { total: list.length, page: p, pageSize, pages: Math.max(1, Math.ceil(list.length / pageSize)), items: list.slice((p - 1) * pageSize, p * pageSize) } };
  };
  if (c.url.endsWith('/clients/search')) return page(clients);
  if (c.url.endsWith('/documents/search')) return failDocs ? { status: 400, body: { errorCode: 1 } } : page(docs);
  const docId = c.url.split('/documents/')[1];
  if (docId) { const d = docs.find((x) => x.id === decodeURIComponent(docId)); return d ? { body: { ...d, linkedDocuments: [{ id: 'd-1' }] } } : { status: 404, body: {} }; }
  return { status: 404, body: {} };
});
sync.setProviderDeps({ fetch, sleep: noSleep });

const conn = connections.createConnection({ provider: 'morning', environment: 'sandbox', credentials: { clientId: 'id', clientSecret: 's' } });
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
async function syncAll() {
  sync.requestCustomerSync(conn.id, 'manual');
  await drain();
  return { customers: sync.latestRun(conn.id, 'customers'), documents: sync.latestRun(conn.id, 'documents') };
}
const doc = (id) => db.prepare('SELECT * FROM acc_documents WHERE external_id = ?').get(id);
const customerOfCard = (id) => db.prepare("SELECT customer_id FROM customer_identities WHERE kind = 'external_id' AND value = ?").get(id).customer_id;

test('mapping: kinds, statuses, money in agorot, apps, and no bank details from payment descriptions', () => {
  const d = toCanonicalDocument(docs[6]);
  assert.equal(d.kind, 'receipt');
  assert.equal(d.status, 'open');
  assert.deepEqual(d.totals, { gross: 12000, vat: 0, net: 12000 });
  assert.deepEqual(d.payments, [{ method: 'bank_transfer', label: 'העברה בנקאית', app: '', amount: 12000 }]);
  assert.ok(!JSON.stringify(d).includes('123456'), 'bank account number is not kept anywhere');
  assert.equal(toCanonicalDocument(docs[0]).payments[0].app, 'Bit');
  const inv = toCanonicalDocument({ ...docs[8], status: 4 });
  assert.equal(inv.kind, 'invoice');
  assert.equal(inv.status, 'cancelled');
  assert.deepEqual(inv.totals, { gross: 11700, vat: 1700, net: 10000 });
  assert.deepEqual(inv.lines, [{ sku: 'BRT-1', externalItemId: 'it-1', description: 'ציר עצמות', quantity: 2, unitPrice: 5000, total: 10000 }]);
  assert.equal(toCanonicalDocument({ ...docs[0], type: 999, status: 9 }).kind, 'other');
});

test('one sync runs customers first, then documents, and saves every valid document', async () => {
  const { customers, documents } = await syncAll();
  assert.equal(customers.status, 'completed');
  assert.equal(documents.status, 'completed');
  assert.equal(documents.source, 'manual');
  assert.equal(documents.fetched, 11);
  assert.equal(documents.added, 10);
  assert.equal(documents.failed, 1);
  assert.match(documents.item_errors[0].error, /תאריך/);
  assert.equal(sync.knownDocuments(conn.id), 10);
  assert.ok(Date.parse(documents.started_at) >= Date.parse(customers.started_at));
});

test('customer identification: card, then email, then exact name; a shared name is never guessed', () => {
  assert.equal(doc('d-1').customer_match, 'external_id');
  assert.equal(doc('d-1').customer_id, customerOfCard('c-1'));
  assert.equal(doc('d-2').customer_match, 'name', 'extra spaces ignored');
  assert.equal(doc('d-2').customer_id, customerOfCard('c-1'));
  assert.equal(doc('d-3').customer_match, 'new');
  assert.equal(doc('d-4').customer_match, 'email', 'email wins over a different name');
  assert.equal(doc('d-4').customer_id, doc('d-3').customer_id);
  assert.equal(doc('d-5').customer_match, 'new');
  assert.equal(doc('d-6').customer_match, 'name');
  assert.equal(doc('d-6').customer_id, doc('d-5').customer_id);
  assert.equal(doc('d-8').customer_match, 'new', 'two customers named שרה לוי: a new customer, not a guess');
  assert.notEqual(doc('d-8').customer_id, customerOfCard('c-2'));
  assert.notEqual(doc('d-8').customer_id, customerOfCard('c-3'));
});

test('audit: every document, every customer a document created, and every first name or email match', () => {
  assert.equal(audit.list({ action: 'document.created', pageSize: 1 }).total, 10);
  // A new link forms only when a name first attaches to an existing customer (d-12 -> card c-4).
  // Later receipts reuse it; every receipt's own entry says how its customer was identified.
  const links = audit.list({ action: 'customer.identity_linked', pageSize: 50 }).items;
  assert.deepEqual(links.map((a) => [a.after.linkedBy, a.after.name]), [['name', 'נועה ברק']]);
  assert.equal(doc('d-12').customer_id, customerOfCard('c-4'));
  const created = audit.list({ action: 'customer.created', pageSize: 50 }).items.filter((a) => a.after.origin === 'document');
  assert.deepEqual(created.map((a) => a.after.name).sort(), ['אורי', 'מיכל', 'רון אבן', 'שרה לוי'].sort());
  const [entry] = audit.list({ action: 'document.created', pageSize: 50 }).items.filter((a) => a.external_id === 'd-2');
  assert.equal(entry.after.customerMatch, 'name');
});

test('rows and payments are stored; the bank details are not', () => {
  const d9 = doc('d-9');
  assert.equal(d9.kind, 'invoice');
  assert.equal(d9.gross, 11700);
  const [line] = db.prepare('SELECT * FROM acc_document_lines WHERE document_id = ?').all(d9.id);
  assert.equal(line.product_key, 'sku:BRT-1');
  assert.equal(line.quantity, 2);
  const [pay] = db.prepare('SELECT * FROM acc_document_payments WHERE document_id = ?').all(doc('d-7').id);
  assert.deepEqual({ method: pay.method, app: pay.app, amount: pay.amount }, { method: 'bank_transfer', app: '', amount: 12000 });
  assert.equal(doc('d-1').primary_payment_method, 'app');
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM acc_documents').all()).includes('123456'));
  assert.ok(!JSON.stringify(audit.list({ pageSize: 200 })).includes('123456'));
});

test('a second sync with nothing new writes nothing', async () => {
  const before = audit.list({ pageSize: 1 }).total;
  const { documents } = await syncAll();
  assert.equal(documents.unchanged, 10);
  assert.equal(documents.added + documents.updated, 0);
  assert.equal(audit.list({ pageSize: 1 }).total, before);
});

test('a cancelled document is audited as such; other changes as updates with field diffs', async () => {
  docs = docs.map((d) => (d.id === 'd-1' ? { ...d, status: 4 } : d.id === 'd-5' ? { ...d, amountLocal: 150 } : d));
  const { documents } = await syncAll();
  assert.equal(documents.updated, 2);
  const [cancelled] = audit.list({ action: 'document.cancelled' }).items;
  assert.equal(cancelled.external_id, 'd-1');
  assert.deepEqual(cancelled.changes, [{ field: 'status', from: 'open', to: 'cancelled' }]);
  const [updated] = audit.list({ action: 'document.updated' }).items;
  assert.deepEqual(updated.changes.map((ch) => ch.field), ['gross', 'net']);
});

test('a document sync failure leaves customers intact and is reported on its own run', async () => {
  failDocs = true;
  const { customers, documents } = await syncAll();
  assert.equal(customers.status, 'completed');
  assert.equal(documents.status, 'failed');
  assert.match(documents.error, /Morning/);
  failDocs = false;
});

test('fetch_document saves one document (what a document webhook will queue later)', async () => {
  docs.push(receipt('d-11', { name: 'מיכל' }));
  queue.enqueue({ type: 'fetch_document', source: 'manual', connectionId: conn.id, payload: { externalId: 'd-11' } });
  await drain();
  assert.equal(doc('d-11').customer_id, doc('d-5').customer_id);
  assert.deepEqual(JSON.parse(doc('d-11').linked_ids), ['d-1']);
});
