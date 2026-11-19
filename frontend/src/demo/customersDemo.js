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
