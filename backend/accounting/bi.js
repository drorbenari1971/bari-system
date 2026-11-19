// Business dashboard (stage 5): revenue over time, first vs repeat purchases, payment methods,
// products, weekdays, top customers and how often customers come back.
//
// Computed from the synced documents on request, with an in-memory cache keyed by a data version
// (any new or changed document, or a new customer, invalidates it). The incremental summary tables
// of the design (bi_daily...) are kept for stage 6, when the data volume calls for them.
//
// Purchases follow the customers screen: receipts and tax invoice/receipts that were not cancelled.
// Each purchase is either a customer's FIRST purchase ever, or a REPEAT purchase.
import './schema.js'; // tables must exist before statements are prepared
import { db } from '../db.js';
import { PURCHASE_KINDS } from './customersQuery.js';
import { normalizeName } from './model.js';
import { isEnabled } from './flags.js';
import { AccountingError } from './errors.js';

const KINDS_SQL = `('${PURCHASE_KINDS.join("', '")}')`;
const VALID_SQL = "status NOT IN ('cancelled', 'cancelling')";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/**
 * Products named in free text. The account's receipts have no item rows, only a description such
 * as "ציר" or "ציר וגהי", so product figures are an estimate: a receipt that names two products
 * counts for both, and its whole amount appears under each.
 */
export const PRODUCT_RULES = [
  { id: 'broth', label: 'ציר', words: ['ציר'] },
  { id: 'ghee', label: 'גהי', words: ['גהי', 'גהיי'] },
  { id: 'kit', label: 'ערכה', words: ['ערכה', 'ערכות'] },
  { id: 'tallow', label: 'טאלו', words: ['טאלו'] },
];
const UNSPECIFIED = { id: 'unspecified', label: 'לא מפורט' };
const NO_DESCRIPTION = { id: 'none', label: 'ללא תיאור' };

export function productsOf(text) {
  const t = normalizeName(text);
  if (!t) return [NO_DESCRIPTION.id];
  const found = PRODUCT_RULES.filter((p) => p.words.some((w) => t.includes(w))).map((p) => p.id);
  return found.length ? found : [UNSPECIFIED.id];
}

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (date, n) => iso(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
/** Week buckets start on Sunday (the Israeli work week). */
const weekStart = (date) => addDays(date, -new Date(`${date}T00:00:00Z`).getUTCDay());
const monthStart = (date) => `${date.slice(0, 7)}-01`;
const nextMonth = (m) => { const d = new Date(`${m}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); return iso(d.getTime()); };

/** Every purchase (and credit note) with its customer, ordered, and whether it was the customer's first. */
function loadFacts() {
  const rows = db.prepare(`
    SELECT d.id, d.customer_id, d.kind, d.doc_date AS date, d.gross, d.description, c.display_name AS name,
      (SELECT GROUP_CONCAT(l.description, ' ') FROM acc_document_lines l WHERE l.document_id = d.id) AS line_text
    FROM acc_documents d LEFT JOIN customers c ON c.id = d.customer_id
    WHERE (d.kind IN ${KINDS_SQL} OR d.kind = 'credit_note') AND d.${VALID_SQL}
    ORDER BY d.doc_date, d.id
  `).all();
  const payments = db.prepare(`
    SELECT p.document_id, p.method, p.app, p.amount FROM acc_document_payments p
    JOIN acc_documents d ON d.id = p.document_id WHERE d.kind IN ${KINDS_SQL} AND d.${VALID_SQL}
  `).all();
  const payBy = payments.reduce((m, p) => m.set(p.document_id, [...(m.get(p.document_id) ?? []), p]), new Map());
  const seen = new Set();
  return rows.map((r) => {
    const purchase = PURCHASE_KINDS.includes(r.kind);
    const first = purchase && r.customer_id !== null && !seen.has(r.customer_id);
    if (first) seen.add(r.customer_id);
    return { ...r, purchase, first, amount: purchase ? r.gross : -r.gross, payments: payBy.get(r.id) ?? [], products: purchase ? productsOf(r.line_text || r.description) : [] };
  });
}

function totals(facts) {
  const purchases = facts.filter((f) => f.purchase);
  const revenue = facts.reduce((n, f) => n + f.amount, 0);
  const buyers = new Set(purchases.map((f) => f.customer_id).filter((x) => x !== null)).size;
  const firsts = purchases.filter((f) => f.first);
  return {
    revenue,
    purchases: purchases.length,
    buyers,
    averagePurchase: purchases.length ? Math.round(revenue / purchases.length) : 0,
    newCustomers: firsts.length,
    repeatPurchases: purchases.length - firsts.length,
    repeatRevenue: purchases.filter((f) => !f.first).reduce((n, f) => n + f.amount, 0),
    repeatShare: purchases.length ? Math.round(((purchases.length - firsts.length) / purchases.length) * 100) : 0,
  };
}

const growth = (now, before) => (before ? Math.round(((now - before) / Math.abs(before)) * 100) : null);

function timeline(facts, from, to, granularity) {
  const bucketOf = granularity === 'week' ? weekStart : monthStart;
  const step = granularity === 'week' ? (d) => addDays(d, 7) : nextMonth;
  const buckets = new Map();
  if (from && to) for (let b = bucketOf(from); b <= to; b = step(b)) buckets.set(b, null);
  for (const f of facts) {
    const b = bucketOf(f.date);
    const cur = buckets.get(b) ?? { start: b, revenue: 0, purchases: 0, firstPurchases: 0, repeatPurchases: 0, firstRevenue: 0, repeatRevenue: 0 };
    cur.revenue += f.amount;
    if (f.purchase) {
      cur.purchases++;
      if (f.first) { cur.firstPurchases++; cur.firstRevenue += f.amount; } else { cur.repeatPurchases++; cur.repeatRevenue += f.amount; }
    }
    buckets.set(b, cur);
  }
  return [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([start, v]) => v ?? { start, revenue: 0, purchases: 0, firstPurchases: 0, repeatPurchases: 0, firstRevenue: 0, repeatRevenue: 0 });
}

function byMethod(facts) {
  const m = new Map();
  for (const f of facts.filter((x) => x.purchase)) {
    for (const p of f.payments) {
      const key = p.app || p.method;
      const cur = m.get(key) ?? { key, method: p.method, app: p.app, count: 0, amount: 0 };
      cur.count++;
      cur.amount += p.amount;
      m.set(key, cur);
    }
  }
  return [...m.values()].sort((a, b) => b.amount - a.amount);
}

function byProduct(facts) {
  const labels = Object.fromEntries([...PRODUCT_RULES, UNSPECIFIED, NO_DESCRIPTION].map((p) => [p.id, p.label]));
  const m = new Map();
  for (const f of facts.filter((x) => x.purchase)) {
    for (const id of f.products) {
      const cur = m.get(id) ?? { id, label: labels[id], purchases: 0, amount: 0, customers: new Set() };
      cur.purchases++;
      cur.amount += f.amount;
      if (f.customer_id !== null) cur.customers.add(f.customer_id);
      m.set(id, cur);
    }
  }
  const order = (p) => (p.id === UNSPECIFIED.id || p.id === NO_DESCRIPTION.id ? 1 : 0);
  return [...m.values()].map(({ customers, ...p }) => ({ ...p, customers: customers.size }))
    .sort((a, b) => order(a) - order(b) || b.purchases - a.purchases);
}

function byWeekday(facts) {
  const days = Array.from({ length: 7 }, (_, day) => ({ day, purchases: 0, amount: 0 }));
  for (const f of facts.filter((x) => x.purchase)) {
    const d = days[new Date(`${f.date}T00:00:00Z`).getUTCDay()];
    d.purchases++;
    d.amount += f.amount;
  }
  return days;
}

function topCustomers(facts, limit = 10) {
  const m = new Map();
  for (const f of facts) {
    if (f.customer_id === null) continue;
    const cur = m.get(f.customer_id) ?? { id: f.customer_id, name: f.name, purchases: 0, amount: 0, lastDate: null };
    cur.amount += f.amount;
    if (f.purchase) { cur.purchases++; cur.lastDate = f.date; }
    m.set(f.customer_id, cur);
  }
  return [...m.values()].sort((a, b) => b.amount - a.amount || b.purchases - a.purchases).slice(0, limit);
}

/**
 * How often customers come back, over the whole history: of the customers whose first purchase is at
 * least N days before the last known day, the share who bought again within N days; and the median
 * gap between consecutive purchases.
 */
function retention(allFacts, asOf) {
  const byCustomer = new Map();
  for (const f of allFacts.filter((x) => x.purchase && x.customer_id !== null)) {
    byCustomer.set(f.customer_id, [...(byCustomer.get(f.customer_id) ?? []), f.date]);
  }
  const windows = [30, 60, 90].map((days) => {
    let eligible = 0;
    let returned = 0;
    for (const dates of byCustomer.values()) {
      if (daysBetween(dates[0], asOf) < days) continue;
      eligible++;
      if (dates.length > 1 && daysBetween(dates[0], dates[1]) <= days) returned++;
    }
    return { days, eligible, returned, share: eligible ? Math.round((returned / eligible) * 100) : null };
  });
  const gaps = [...byCustomer.values()].flatMap((d) => d.slice(1).map((x, i) => daysBetween(d[i], x))).sort((a, b) => a - b);
  const median = gaps.length ? (gaps.length % 2 ? gaps[(gaps.length - 1) / 2] : Math.round((gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2)) : null;
  return { windows, medianGapDays: median, gaps: gaps.length };
}

const inRange = (from, to) => (f) => (!from || f.date >= from) && (!to || f.date <= to);

function compute({ from, to, granularity }) {
  const all = loadFacts();
  const purchasesAll = all.filter((f) => f.purchase);
  const dataRange = { first: purchasesAll[0]?.date ?? null, last: purchasesAll.at(-1)?.date ?? null };
  const facts = all.filter(inRange(from, to));
  const current = totals(facts);

  let previous = null;
  if (from && to) {
    const len = daysBetween(from, to) + 1;
    const prevTo = addDays(from, -1);
    const prevFrom = addDays(from, -len);
    previous = { from: prevFrom, to: prevTo, ...totals(all.filter(inRange(prevFrom, prevTo))) };
  }
  const span = { from: from ?? dataRange.first, to: to ?? dataRange.last };

  return {
    period: { from, to, granularity },
    dataRange,
    summary: current,
    previous,
    change: previous ? {
      revenue: growth(current.revenue, previous.revenue),
      purchases: growth(current.purchases, previous.purchases),
      buyers: growth(current.buyers, previous.buyers),
      newCustomers: growth(current.newCustomers, previous.newCustomers),
    } : null,
    timeline: span.from ? timeline(facts, span.from, span.to, granularity) : [],
    methods: byMethod(facts),
    products: byProduct(facts),
    productRules: PRODUCT_RULES.map(({ label, words }) => ({ label, words })),
    weekdays: byWeekday(facts),
    topCustomers: topCustomers(facts),
    retention: retention(all, dataRange.last ?? iso(Date.now())),
  };
}

// ---- cache: the same answer until the data changes
const cache = new Map();
const MAX_CACHED = 30;
const dataVersion = () => {
  const d = db.prepare('SELECT COUNT(*) AS n, MAX(changed_at) AS c, MAX(id) AS i FROM acc_documents').get();
  const c = db.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS u FROM customers').get();
  const i = db.prepare('SELECT COUNT(*) AS n FROM customer_identities').get();
  return `${d.n}|${d.c}|${d.i}|${c.n}|${c.u}|${i.n}`;
};

/** @param {{ from?: string, to?: string, granularity?: 'month'|'week' }} opts */
export function dashboard({ from = null, to = null, granularity = 'month' } = {}) {
  if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) throw new AccountingError('תאריך לא תקין', { code: 'validation' });
  if (from && to && from > to) throw new AccountingError('תאריך ההתחלה אחרי תאריך הסיום', { code: 'validation' });
  if (!['month', 'week'].includes(granularity)) throw new AccountingError('חלוקה לא מוכרת', { code: 'validation' });
  const opts = { from: from || null, to: to || null, granularity };
  if (!isEnabled('biCache')) return compute(opts);
  const key = `${opts.from}|${opts.to}|${granularity}|${dataVersion()}`;
  if (!cache.has(key)) {
    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value);
    cache.set(key, compute(opts));
  }
  return cache.get(key);
}
