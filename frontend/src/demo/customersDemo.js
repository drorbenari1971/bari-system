// Fictional customers and receipts for the browser demo of the customers screen. Same response
// shapes as backend/accounting/customersQuery.js. Nothing here is real data.
const PEOPLE = [
  ['נועה כרמי', '050-0000101', 'card'], ['איתי שגיא', '', 'name'], ['מאיה רוזן', '052-0000102', 'card'],
  ['עומר טל', '', 'document'], ['שירה אלון', '', 'name'], ['יונתן בר', '054-0000103', 'card'],
  ['ליה דגן', '', 'document'], ['אדם ניר', '', 'email'], ['תמר גל', '', 'document'],
  ['רועי שחר', '053-0000104', 'card'], ['הילה צור', '', 'document'], ['גיא מור', '', 'name'],
];
const DESCRIPTIONS = ['ציר עוף', 'ציר עצמות', 'ציר וגהי', 'ערכה שבועית', 'גהי'];
const AMOUNTS = [6000, 12000, 18000, 24000, 9000];
const APPS = ['Bit', 'Bit', 'Bit', 'PayBox', ''];

const day = (offset) => new Date(Date.UTC(2026, 10, 18) - offset * 86_400_000).toISOString().slice(0, 10);

const CUSTOMERS = PEOPLE.map(([name, phone, identifiedBy], i) => {
  const count = [7, 4, 3, 1, 2, 5, 1, 2, 1, 0, 1, 3][i];
  const documents = Array.from({ length: count }, (_, k) => {
    const app = APPS[(i + k) % APPS.length];
    const amount = AMOUNTS[(i * 2 + k) % AMOUNTS.length];
    return {
      id: i * 100 + k, externalId: `demo-${i}-${k}`, kind: 'receipt', status: 'open', number: String(80000 + i * 10 + k),
      date: day(k * (9 + i) + i), gross: amount, net: amount, vat: 0, description: DESCRIPTIONS[(i + k) % DESCRIPTIONS.length],
      customerMatch: identifiedBy === 'card' ? 'external_id' : k === 0 ? 'new' : identifiedBy, pdfUrl: '', counted: true,
      payments: [{ method: app ? 'app' : 'bank_transfer', label: app ? 'אפליקציית תשלום' : 'העברה בנקאית', app, amount }], lines: [],
    };
  });
  const dates = documents.map((d) => d.date).sort();
  const total = documents.reduce((n, d) => n + d.gross, 0);
  const last = documents[0];
  return {
    id: i + 1, name, phone, email: identifiedBy === 'email' ? 'adam@example.com' : '',
    purchases: count, total, average: count ? Math.round(total / count) : 0,
    firstDate: dates[0] ?? null, lastDate: dates.at(-1) ?? null,
    avgDaysBetween: count > 1 ? Math.round((Date.parse(dates.at(-1)) - Date.parse(dates[0])) / 86_400_000 / (count - 1)) : null,
    lastMethod: last ? last.payments[0].method : null, lastApp: last ? last.payments[0].app : '',
    identifiedBy, removed: false, documents,
  };
});

const SEGMENT = { all: () => true, buyers: (c) => c.purchases > 0, returning: (c) => c.purchases >= 2, one_time: (c) => c.purchases === 1, no_purchases: (c) => c.purchases === 0 };
const SORT = {
  last_purchase: (a, b) => (b.lastDate ?? '').localeCompare(a.lastDate ?? ''),
  total: (a, b) => b.total - a.total,
  purchases: (a, b) => b.purchases - a.purchases || b.total - a.total,
  first_purchase: (a, b) => (a.firstDate ?? '9').localeCompare(b.firstDate ?? '9'),
  name: (a, b) => a.name.localeCompare(b.name, 'he'),
};

export function demoCustomers(params) {
  const q = (params.get('q') ?? '').trim().toLowerCase();
  const segment = SEGMENT[params.get('segment')] ? params.get('segment') : 'all';
  const sort = SORT[params.get('sort')] ? params.get('sort') : 'last_purchase';
  const page = Math.max(Number(params.get('page')) || 1, 1);
  const pageSize = Math.min(Math.max(Number(params.get('pageSize')) || 50, 1), 200);
  const rows = CUSTOMERS
    .filter(SEGMENT[segment])
    .filter((c) => !q || c.name.toLowerCase().includes(q) || c.email.includes(q) || c.phone.replace(/\D/g, '').includes(q.replace(/\D/g, '') || '§'))
    .sort(SORT[sort]);
  const buyers = CUSTOMERS.filter((c) => c.purchases > 0);
  const returning = CUSTOMERS.filter((c) => c.purchases >= 2).length;
  const revenue = CUSTOMERS.reduce((n, c) => n + c.total, 0);
  return {
    items: rows.slice((page - 1) * pageSize, page * pageSize).map(({ documents, ...c }) => c),
    total: rows.length, page, pageSize,
    summary: {
      customers: CUSTOMERS.length, buyers: buyers.length, returning, revenue,
      purchases: CUSTOMERS.reduce((n, c) => n + c.purchases, 0),
      returningShare: Math.round((returning / buyers.length) * 100), averagePerBuyer: Math.round(revenue / buyers.length),
    },
  };
}

export function demoCustomerCard(id) {
  const c = CUSTOMERS.find((x) => x.id === Number(id));
  if (!c) return null;
  const methods = Object.values(c.documents.flatMap((d) => d.payments).reduce((m, p) => {
    const key = p.app || p.method;
    m[key] = { key, method: p.method, app: p.app, count: (m[key]?.count ?? 0) + 1, amount: (m[key]?.amount ?? 0) + p.amount };
    return m;
  }, {}));
  return {
    ...c,
    createdAt: '2026-07-01T09:00:00.000Z',
    cards: c.identifiedBy === 'card' ? [{ external_id: `demo-card-${c.id}`, name: c.name, phone: c.phone, mobile: '', emails: [], tax_id: '', address: '', city: 'תל אביב', contact_person: '', active: true, remarks: '', source_created_at: '2026-07-01T09:00:00.000Z', removed_at: null }] : [],
    identities: [{ kind: 'name', value: c.name }],
    methods,
    history: [{ at: '2026-11-19T12:00:00.000Z', action: 'customer.created', source: 'system', changes: [], linkedBy: null }],
  };
}

// ---- dashboard (same shape as backend/accounting/bi.js), from the fictional receipts above
const PRODUCT_WORDS = [['broth', 'ציר', ['ציר']], ['ghee', 'גהי', ['גהי']], ['kit', 'ערכה', ['ערכה']]];
const DAY = 86_400_000;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const gap = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

export function demoDashboard(params) {
  const from = params.get('from');
  const to = params.get('to');
  const granularity = params.get('granularity') === 'week' ? 'week' : 'month';
  const all = CUSTOMERS.flatMap((c) => c.documents.map((d) => ({ ...d, customerId: c.id, name: c.name })))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  const seen = new Set();
  for (const f of all) { f.first = !seen.has(f.customerId); seen.add(f.customerId); }
  const inRange = (f) => (!from || f.date >= from) && (!to || f.date <= to);
  const facts = all.filter(inRange);
  const sum = (list) => list.reduce((n, f) => n + f.gross, 0);
  const firsts = facts.filter((f) => f.first);
  const summary = {
    revenue: sum(facts), purchases: facts.length, buyers: new Set(facts.map((f) => f.customerId)).size,
    averagePurchase: facts.length ? Math.round(sum(facts) / facts.length) : 0, newCustomers: firsts.length,
    repeatPurchases: facts.length - firsts.length, repeatRevenue: sum(facts.filter((f) => !f.first)),
    repeatShare: facts.length ? Math.round(((facts.length - firsts.length) / facts.length) * 100) : 0,
  };
  const bucket = (d) => (granularity === 'week' ? isoDay(Date.parse(d) - new Date(d).getUTCDay() * DAY) : `${d.slice(0, 7)}-01`);
  const buckets = new Map();
  for (const f of facts) {
    const b = buckets.get(bucket(f.date)) ?? { start: bucket(f.date), revenue: 0, purchases: 0, firstPurchases: 0, repeatPurchases: 0, firstRevenue: 0, repeatRevenue: 0 };
    b.revenue += f.gross; b.purchases++;
    if (f.first) { b.firstPurchases++; b.firstRevenue += f.gross; } else { b.repeatPurchases++; b.repeatRevenue += f.gross; }
    buckets.set(b.start, b);
  }
  const group = (keyOf, make) => [...facts.reduce((m, f) => { for (const k of keyOf(f)) { const g = m.get(k) ?? make(k, f); g.count++; g.amount += f.gross; g.customers.add(f.customerId); m.set(k, g); } return m; }, new Map()).values()];
  const methods = group((f) => [f.payments[0].app || f.payments[0].method], (k, f) => ({ key: k, method: f.payments[0].method, app: f.payments[0].app, count: 0, amount: 0, customers: new Set() }))
    .map(({ customers, ...m }) => m).sort((a, b) => b.amount - a.amount);
  const products = group((f) => { const found = PRODUCT_WORDS.filter(([, , w]) => w.some((x) => f.description.includes(x))).map(([id]) => id); return found.length ? found : ['unspecified']; },
    (k) => ({ id: k, label: PRODUCT_WORDS.find(([id]) => id === k)?.[1] ?? 'לא מפורט', count: 0, amount: 0, customers: new Set() }))
    .map(({ customers, count, ...p }) => ({ ...p, purchases: count, customers: customers.size })).sort((a, b) => b.purchases - a.purchases);
  const weekdays = Array.from({ length: 7 }, (_, day) => ({ day, purchases: 0, amount: 0 }));
  for (const f of facts) { const w = weekdays[new Date(`${f.date}T00:00:00Z`).getUTCDay()]; w.purchases++; w.amount += f.gross; }
  const top = [...facts.reduce((m, f) => { const c = m.get(f.customerId) ?? { id: f.customerId, name: f.name, purchases: 0, amount: 0, lastDate: null }; c.purchases++; c.amount += f.gross; c.lastDate = f.date; return m.set(f.customerId, c); }, new Map()).values()]
    .sort((a, b) => b.amount - a.amount).slice(0, 10);
  const byCustomer = all.reduce((m, f) => m.set(f.customerId, [...(m.get(f.customerId) ?? []), f.date]), new Map());
  const last = all.at(-1)?.date ?? isoDay(Date.now());
  const windows = [30, 60, 90].map((days) => {
    const list = [...byCustomer.values()].filter((d) => gap(d[0], last) >= days);
    const returned = list.filter((d) => d.length > 1 && gap(d[0], d[1]) <= days).length;
    return { days, eligible: list.length, returned, share: list.length ? Math.round((returned / list.length) * 100) : null };
  });
  const gaps = [...byCustomer.values()].flatMap((d) => d.slice(1).map((x, i) => gap(d[i], x))).sort((a, b) => a - b);
  return {
    period: { from, to, granularity }, dataRange: { first: all[0]?.date ?? null, last },
    summary, previous: null, change: null,
    timeline: [...buckets.values()].sort((a, b) => a.start.localeCompare(b.start)),
    methods, products, productRules: [], weekdays, topCustomers: top,
    retention: { windows, medianGapDays: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null, gaps: gaps.length },
  };
}
