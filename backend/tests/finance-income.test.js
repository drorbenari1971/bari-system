// "כספים ותזרים" reads its income from the synced Morning documents too: counted like the customers
// screen, never copied into the finance table, and read-only. Data is fictional.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { isolate } from './helpers.js';

const cleanup = isolate();
const { db } = await import('../db.js');
const connections = await import('../accounting/connections.js');
const { upsertDocument } = await import('../accounting/documentStore.js');
const { toCanonicalDocument } = await import('../accounting/providers/morning/mapper.js');
const { providerIncome } = await import('../accounting/financeIncome.js');
const router = (await import('../routes/finance.js')).default;

const app = express();
app.use(express.json());
app.use('/api/finance', router);
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}/api/finance`;
after(async () => { await new Promise((r) => server.close(r)); await cleanup(); });

const conn = connections.createConnection({ provider: 'morning', environment: 'sandbox', credentials: { clientId: 'id', clientSecret: 's' } });
const doc = (id, { type = 400, status = 0, date = '2026-10-05', amount = 100, description = '', name = 'לקוחת בדיקה' } = {}) => upsertDocument(conn.id, toCanonicalDocument({
  id, type, number: id.replace(/\D/g, ''), status, documentDate: date, creationDate: 1759300000, currency: 'ILS',
  amountLocal: amount, vatLocal: 0, description, client: { name }, income: [], payment: [{ type: 1, price: amount }],
}), { source: 'polling' });

doc('d-1', { amount: 120, description: 'ציר' });
doc('d-2', { amount: 80, description: 'ציר וגהי', date: '2026-10-20' });
doc('d-3', { amount: 50 }); // no description
doc('d-4', { amount: 70, description: 'משלוח' });
doc('d-5', { amount: 999, description: 'ציר', status: 4 }); // cancelled
doc('d-6', { amount: 300, type: 305, description: 'ציר' }); // invoice: not income yet
doc('d-7', { amount: 30, type: 330, description: 'החזר' }); // credit note
doc('d-8', { amount: 40, description: 'גהי', date: '2026-09-30' });

test('counts receipts, subtracts credit notes, skips cancelled documents and invoices', () => {
  const rows = providerIncome({ from: '2026-10-01', to: '2026-10-31' });
  assert.equal(rows.length, 5);
  assert.equal(rows.reduce((s, r) => s + r.amount_agorot, 0), (120 + 80 + 50 + 70 - 30) * 100);
  assert.ok(rows.every((r) => r.kind === 'income' && r.source === 'morning' && !r.is_demo));
  const byCategory = Object.fromEntries(rows.map((r) => [r.subcategory.split(' · ')[0], r.category]));
  assert.deepEqual(byCategory, {
    'קבלה 1': 'ציר',
    'קבלה 2': 'ציר + גהי',
    'קבלה 3': 'קבלות Morning (ללא תיאור)',
    'קבלה 4': 'קבלות Morning (לא מפורט)',
    'חשבונית זיכוי 7': 'חשבונית זיכוי',
  });
  assert.equal(rows.find((r) => r.id.startsWith('morning-')).subcategory.endsWith('לקוחת בדיקה'), true);
});

test('the finance list merges manual rows with Morning income; nothing is copied', async () => {
  const add = await fetch(`${base}/transactions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'expense', date: '2026-10-10', category: 'אריזות', amount_agorot: 2500 }) });
  assert.equal(add.status, 200);
  const rows = await (await fetch(`${base}/transactions?from=2026-10-01&to=2026-10-31`)).json();
  assert.equal(rows.length, 6);
  assert.equal(rows.filter((r) => r.source === 'manual').length, 1);
  assert.deepEqual(rows.map((r) => r.date), [...rows.map((r) => r.date)].sort().reverse(), 'newest first');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n, 1, 'Morning income is not copied');

  const expenses = await (await fetch(`${base}/transactions?kind=expense`)).json();
  assert.deepEqual(expenses.map((r) => r.source), ['manual']);
  const all = await (await fetch(`${base}/transactions`)).json();
  assert.equal(all.filter((r) => r.source === 'morning').length, 6, 'no date filter: September too');
});
