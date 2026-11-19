// Business dashboard calculations over fictional receipts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { isolate } from './helpers.js';

const cleanup = isolate();
const connections = await import('../accounting/connections.js');
const { upsertDocument } = await import('../accounting/documentStore.js');
const { toCanonicalDocument } = await import('../accounting/providers/morning/mapper.js');
const bi = await import('../accounting/bi.js');
const flags = await import('../accounting/flags.js');
const router = (await import('../routes/accounting.js')).default;

const conn = connections.createConnection({ provider: 'morning', environment: 'sandbox', credentials: { clientId: 'id', clientSecret: 's' } });
let n = 0;
const receipt = (name, date, amount, { type = 400, status = 0, description = 'ציר', pay = { type: 10, description: 'bit' } } = {}) => upsertDocument(conn.id, toCanonicalDocument({
  id: `d-${++n}`, type, status, number: String(n), documentDate: date, creationDate: 1_800_000_000, currency: 'ILS', amountLocal: amount, vatLocal: 0,
  description, client: { name }, income: [], payment: [{ ...pay, price: amount }],
}), { source: 'manual' });

// A: 3 purchases (Jul 5, Jul 20, Sep 1). B: 1 purchase (Jul 10) + a credit note. C: Sep 2, Sep 30.
receipt('לקוח א', '2026-07-05', 100, { description: 'ציר וגהי' });
receipt('לקוח ב', '2026-07-10', 200, { description: 'ערכה שבועית', pay: { type: 4, description: 'בנק' } });
receipt('לקוח א', '2026-07-20', 100, { description: 'בריא' });
receipt('לקוח א', '2026-09-01', 100, { description: '' });
receipt('לקוח ג', '2026-09-02', 300, { description: 'גהי', pay: { type: 10, description: 'PayBox' } });
receipt('לקוח ג', '2026-09-30', 300);
receipt('לקוח ב', '2026-07-12', 50, { type: 330 });                 // credit note: -50
receipt('לקוח ד', '2026-08-01', 999, { status: 4 });                // cancelled: ignored
receipt('לקוח ה', '2026-08-02', 700, { type: 305 });                // tax invoice: not a purchase

const app = express();
app.use('/api/accounting', router);
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}/api/accounting`;
after(async () => { await new Promise((r) => server.close(r)); await cleanup(); });

test('products are read from the description; two products count for both; empty and brand-only are separate', () => {
  assert.deepEqual(bi.productsOf('ציר וגהי'), ['broth', 'ghee']);
  assert.deepEqual(bi.productsOf('2 ערכות ציר'), ['broth', 'kit']);
  assert.deepEqual(bi.productsOf('בריא'), ['unspecified']);
  assert.deepEqual(bi.productsOf('  '), ['none']);
});

test('all time: totals, first vs repeat purchases, credit notes reduce, invoices and cancelled ignored', () => {
  const d = bi.dashboard();
  assert.deepEqual(d.dataRange, { first: '2026-07-05', last: '2026-09-30' });
  assert.equal(d.summary.purchases, 6);
  assert.equal(d.summary.revenue, (100 + 200 + 100 + 100 + 300 + 300 - 50) * 100);
  assert.equal(d.summary.buyers, 3);
  assert.equal(d.summary.newCustomers, 3);
  assert.equal(d.summary.repeatPurchases, 3);
  assert.equal(d.summary.repeatShare, 50);
  assert.equal(d.previous, null);
});

test('monthly timeline fills empty months; weekly buckets start on Sunday', () => {
  const m = bi.dashboard().timeline;
  assert.deepEqual(m.map((b) => [b.start, b.purchases, b.firstPurchases, b.repeatPurchases]), [
    ['2026-07-01', 3, 2, 1], ['2026-08-01', 0, 0, 0], ['2026-09-01', 3, 1, 2],
  ]);
  assert.equal(m[0].revenue, (100 + 200 + 100 - 50) * 100);
  const w = bi.dashboard({ from: '2026-07-01', to: '2026-07-31', granularity: 'week' }).timeline;
  assert.equal(w[0].start, '2026-06-28', '1 Jul 2026 is a Wednesday; its week starts Sunday 28 Jun');
  assert.ok(w.every((b) => new Date(`${b.start}T00:00:00Z`).getUTCDay() === 0));
  assert.equal(w.reduce((n, b) => n + b.purchases, 0), 3);
});

test('a period compares with the same length right before it', () => {
  const d = bi.dashboard({ from: '2026-09-01', to: '2026-09-30' });
  assert.equal(d.summary.purchases, 3);
  assert.equal(d.summary.newCustomers, 1, 'only C is new in September; A bought before');
  assert.deepEqual([d.previous.from, d.previous.to], ['2026-08-02', '2026-08-31']);
  assert.equal(d.previous.purchases, 0);
  assert.equal(d.change.revenue, null, 'no growth figure against an empty period');
  const j = bi.dashboard({ from: '2026-07-16', to: '2026-09-30' });
  assert.equal(j.previous.purchases, 2);
  assert.equal(j.change.purchases, Math.round(((4 - 2) / 2) * 100));
});

test('payment methods, products, weekdays and top customers', () => {
  const d = bi.dashboard();
  assert.deepEqual(d.methods.map((m) => [m.key, m.count, m.amount]), [['Bit', 4, 60000], ['PayBox', 1, 30000], ['bank_transfer', 1, 20000]]);
  const p = Object.fromEntries(d.products.map((x) => [x.id, [x.purchases, x.customers]]));
  assert.deepEqual(p, { broth: [2, 2], ghee: [2, 2], kit: [1, 1], unspecified: [1, 1], none: [1, 1] });
  assert.equal(d.products.at(-1).id === 'none' || d.products.at(-1).id === 'unspecified', true, 'unknowns listed last');
  assert.equal(d.weekdays.reduce((s, w) => s + w.purchases, 0), 6);
  assert.equal(d.weekdays[0].purchases, 1, '5 Jul 2026 is a Sunday');
  assert.deepEqual(d.topCustomers.map((c) => [c.name, c.purchases, c.amount]), [['לקוח ג', 2, 60000], ['לקוח א', 3, 30000], ['לקוח ב', 1, 15000]]);
});

test('return rates count only customers who had time to come back; median gap between purchases', () => {
  const r = bi.dashboard().retention;
  // As of 30 Sep: A first 5 Jul (next 20 Jul, 15 days), B 10 Jul (never), C 2 Sep (next 30 Sep, 28 days, but only 28 days ago)
  assert.deepEqual(r.windows[0], { days: 30, eligible: 2, returned: 1, share: 50 });
  assert.deepEqual(r.windows[2], { days: 90, eligible: 0, returned: 0, share: null });
  assert.equal(r.medianGapDays, 28, 'gaps 15, 43, 28');
});

test('cache: same answer until the data changes; correct with the cache off too', () => {
  const before = bi.dashboard().summary.purchases;
  receipt('לקוח ו', '2026-09-15', 80);
  assert.equal(bi.dashboard().summary.purchases, before + 1, 'a new document invalidates the cache');
  flags.setFlag('biCache', false);
  assert.equal(bi.dashboard().summary.purchases, before + 1);
  flags.setFlag('biCache', true);
});

test('filters by product and payment method; first purchases stay first-ever; retention ignores filters', () => {
  const all = bi.dashboard();
  const ghee = bi.dashboard({ product: 'ghee' });
  assert.equal(ghee.summary.purchases, 2, 'A on 5 Jul (ציר וגהי) and C on 2 Sep (גהי)');
  assert.equal(ghee.summary.newCustomers, 2, 'both were those customers\' first purchases');
  assert.deepEqual(ghee.dataRange, all.dataRange);
  assert.deepEqual(ghee.retention, all.retention);
  const transfer = bi.dashboard({ method: 'bank_transfer' });
  assert.equal(transfer.summary.purchases, 1);
  assert.equal(transfer.summary.revenue, 20000, 'the credit note has no payment, so a method filter leaves it out');
  const paybox = bi.dashboard({ method: 'PayBox', product: 'broth' });
  assert.equal(paybox.summary.purchases, 0);
  assert.deepEqual(all.filterOptions.products.map((p) => p.id), ['broth', 'ghee', 'kit', 'unspecified', 'none']);
  assert.deepEqual(all.filterOptions.methods.map((m) => m.key).sort(), ['Bit', 'PayBox', 'bank_transfer'].sort());
  assert.throws(() => bi.dashboard({ product: 'pizza' }), /מוצר/);
});

test('validation and the route', async () => {
  assert.throws(() => bi.dashboard({ from: '2026/01/01' }), /תאריך/);
  assert.throws(() => bi.dashboard({ from: '2026-09-01', to: '2026-08-01' }), /אחרי/);
  assert.throws(() => bi.dashboard({ granularity: 'day' }), /חלוקה/);
  const ok = await fetch(`${base}/bi/dashboard?from=2026-07-01&to=2026-09-30&granularity=week`);
  assert.equal(ok.status, 200);
  assert.ok((await ok.json()).timeline.length >= 13);
  assert.equal((await fetch(`${base}/bi/dashboard?granularity=year`)).status, 400);
});
