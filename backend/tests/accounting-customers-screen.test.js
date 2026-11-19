// Customers screen queries and routes, over fictional customers and documents.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { isolate } from './helpers.js';

const cleanup = isolate();
const { db } = await import('../db.js');
const connections = await import('../accounting/connections.js');
const { upsertCustomerRecord } = await import('../accounting/customerStore.js');
const { upsertDocument } = await import('../accounting/documentStore.js');
const { toCanonicalCustomer, toCanonicalDocument } = await import('../accounting/providers/morning/mapper.js');
const q = await import('../accounting/customersQuery.js');
const router = (await import('../routes/accounting.js')).default;

const conn = connections.createConnection({ provider: 'morning', environment: 'sandbox', credentials: { clientId: 'id', clientSecret: 's' } });
const ctx = { source: 'manual' };
upsertCustomerRecord(conn.id, toCanonicalCustomer({ id: 'c-1', name: 'דנה כהן', phone: '050-1234567', emails: ['dana@example.com'] }), ctx);
upsertCustomerRecord(conn.id, toCanonicalCustomer({ id: 'c-2', name: '=HYPERLINK("x")', phone: '052-7654321' }), ctx); // formula-looking name
upsertCustomerRecord(conn.id, toCanonicalCustomer({ id: 'c-3', name: 'בלי רכישות', phone: '053-1111111' }), ctx);

let n = 0;
const doc = (client, { type = 400, status = 0, date = '2026-10-01', amount = 100, pay = { type: 10, description: 'bit' } } = {}) => upsertDocument(conn.id, toCanonicalDocument({
  id: `d-${++n}`, type, status, number: String(80000 + n), documentDate: date, creationDate: 1_800_000_000, currency: 'ILS',
  amountLocal: amount, vatLocal: 0, description: 'ציר', client, income: [], payment: [{ ...pay, price: amount }], url: { he: `https://example.test/${n}.pdf` },
}), ctx);
doc({ id: 'c-1', name: 'דנה כהן' }, { date: '2026-09-01', amount: 120 });
doc({ name: 'דנה כהן' }, { date: '2026-09-11', amount: 60 });                         // by name, same customer
doc({ id: 'c-1', name: 'דנה כהן' }, { date: '2026-10-01', amount: 240, pay: { type: 4, description: 'בנק 1' } });
doc({ id: 'c-1', name: 'דנה כהן' }, { type: 305, date: '2026-10-02', amount: 500 });     // tax invoice: shown, not counted
doc({ id: 'c-1', name: 'דנה כהן' }, { status: 4, date: '2026-10-03', amount: 999 });     // cancelled: not counted
doc({ id: 'c-1', name: 'דנה כהן' }, { type: 330, date: '2026-10-04', amount: 20 });      // credit note: reduces the total
doc({ id: 'c-2', name: '=HYPERLINK("x")' }, { date: '2026-08-01', amount: 80 });
doc({ name: 'מיכל לוי', emails: ['michal@example.com'] }, { date: '2026-11-01', amount: 300 });
doc({ name: 'מיכל ל.', emails: ['MICHAL@example.com'] }, { date: '2026-11-15', amount: 150, pay: { type: 10, description: 'PayBox' } });

const app = express();
app.use('/api/accounting', router);
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}/api/accounting`;
after(async () => { await new Promise((r) => server.close(r)); await cleanup(); });

const byName = (name) => q.listCustomers({ pageSize: 200 }).items.find((c) => c.name === name);

test('purchases count receipts only; invoices are shown but not counted; credit notes reduce; cancelled ignored', () => {
  const dana = byName('דנה כהן');
  assert.equal(dana.purchases, 3);
  assert.equal(dana.total, 12000 + 6000 + 24000 - 2000);
  assert.equal(dana.average, Math.round(40000 / 3));
  assert.equal(dana.firstDate, '2026-09-01');
  assert.equal(dana.lastDate, '2026-10-01');
  assert.equal(dana.avgDaysBetween, 15);
  assert.equal(dana.identifiedBy, 'card');
  assert.equal(dana.lastMethod, 'bank_transfer');
  const michal = byName('מיכל לוי');
  assert.equal(michal.purchases, 2, 'two receipts joined by email');
  assert.equal(michal.identifiedBy, 'email');
  assert.equal(michal.lastApp, 'PayBox');
});

test('summary: customers, buyers, returning, revenue', () => {
  assert.deepEqual(q.customersSummary(), {
    customers: 4, buyers: 3, returning: 2, revenue: 40000 + 8000 + 45000, purchases: 6, returningShare: 67, averagePerBuyer: Math.round(93000 / 3),
  });
});

test('segments, search by name, phone (any format) or email, and sorting', () => {
  const total = (o) => q.listCustomers(o).total;
  assert.equal(total({ segment: 'returning' }), 2);
  assert.equal(total({ segment: 'one_time' }), 1);
  assert.equal(total({ segment: 'no_purchases' }), 1);
  assert.equal(total({ segment: 'buyers' }), 3);
  assert.equal(total({ q: 'דנה' }), 1);
  assert.equal(total({ q: '0501234567' }), 1);
  assert.equal(total({ q: '+972-50-123' }), 1);
  assert.equal(total({ q: 'MICHAL@' }), 1);
  assert.equal(total({ q: 'לא קיים' }), 0);
  assert.deepEqual(q.listCustomers({ sort: 'total' }).items.map((c) => c.name).slice(0, 2), ['מיכל לוי', 'דנה כהן']);
  assert.equal(q.listCustomers({ sort: 'last_purchase' }).items.at(-1).name, 'בלי רכישות', 'no purchases last');
  assert.deepEqual(q.listCustomers({ pageSize: 2, page: 2 }).items.length, 2);
  assert.throws(() => q.listCustomers({ segment: 'x' }), /סינון/);
  assert.throws(() => q.listCustomers({ sort: 'x; DROP TABLE customers' }), /מיון/);
});

test('customer card: documents (counted or not), payments by method, Morning card, identities, history', () => {
  const card = q.getCustomerCard(byName('דנה כהן').id);
  assert.equal(card.documents.length, 6);
  const counted = Object.fromEntries(card.documents.map((d) => [d.kind + (d.status === 'cancelled' ? '-cancelled' : ''), d.counted]));
  assert.deepEqual(counted, { receipt: true, 'receipt-cancelled': false, invoice: false, credit_note: false });
  assert.ok(card.documents.some((d) => d.customerMatch === 'name'));
  assert.deepEqual(card.methods.map((m) => m.key).sort(), ['Bit', 'bank_transfer'].sort());
  assert.equal(card.cards[0].name, 'דנה כהן');
  assert.ok(card.identities.some((i) => i.kind === 'name'));
  assert.ok(card.history.some((h) => h.action === 'customer.created'));
  assert.ok(!JSON.stringify(card).includes('בנק 1'), 'bank text from a transfer description is not stored');
  assert.throws(() => q.getCustomerCard(9999), /לא נמצא/);
});

test('CSV export opens in Excel (BOM), quotes every cell, and neutralises formula-looking text', () => {
  const csv = q.exportCustomersCsv({ sort: 'name' });
  assert.equal(csv.charCodeAt(0), 0xfeff);
  const lines = csv.slice(1).trim().split('\r\n');
  assert.equal(lines.length, 1 + 4);
  assert.match(lines[0], /^"שם","טלפון"/);
  assert.ok(csv.includes('"\'=HYPERLINK(""x"")"'), 'formula is prefixed and quotes doubled');
  assert.equal(q.exportCustomersCsv({ segment: 'returning' }).slice(1).trim().split('\r\n').length, 1 + 2);
});

test('routes: list with summary, card, 404, bad filter, and the export download', async () => {
  const list = await (await fetch(`${base}/customers?segment=returning&sort=purchases`)).json();
  assert.equal(list.total, 2);
  assert.equal(list.summary.customers, 4);
  assert.equal((await fetch(`${base}/customers?segment=nope`)).status, 400);
  const card = await fetch(`${base}/customers/${list.items[0].id}`);
  assert.equal(card.status, 200);
  assert.equal((await fetch(`${base}/customers/9999`)).status, 404);
  const exp = await fetch(`${base}/customers/export.csv?segment=buyers`);
  assert.equal(exp.status, 200);
  assert.match(exp.headers.get('content-type'), /text\/csv/);
  assert.match(exp.headers.get('content-disposition'), /attachment; filename="customers-\d{4}-\d{2}-\d{2}\.csv"/);
  assert.equal((await exp.text()).trim().split('\r\n').length, 1 + 3);
});
