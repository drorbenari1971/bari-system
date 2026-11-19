// "דשבורד": revenue over time, first vs repeat purchases, payment methods, products, weekdays,
// how often customers come back, and the top customers. Data: GET /accounting/bi/dashboard.
import { useEffect, useMemo, useState } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { Wallet, ShoppingBag, Users, UserPlus, Repeat, Receipt, Info } from 'lucide-react';
import { api } from '../../api.js';
import { useTheme } from '../../App.jsx';
import { fmtNum } from '../../constants.js';
import { fmtMoneyCompact, fmtMonth, toDateInput } from '../../financeSummary.js';
import { Card, Empty, ErrorNote, Spinner, StatCard } from '../../components/ui.jsx';
import { fmtMoney, fmtDay, methodLabel } from './customerFormat.js';

const PERIODS = [['30d', '30 יום'], ['90d', '90 יום'], ['6m', '6 חודשים'], ['year', 'השנה'], ['all', 'הכול']];
const WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

// Validated (colorblind separation, contrast) for the light and dark surfaces: revenue keeps the
// finance module's green; first vs repeat purchases use categorical slots 1 and 2.
const COLORS = {
  light: { revenue: '#1f8042', first: '#2a78d6', repeat: '#eb6834' },
  dark: { revenue: '#1f8042', first: '#3987e5', repeat: '#d95926' },
};

const cssColor = (name) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
  return `rgb(${v.split(/\s+/).join(',')})`;
};

function periodRange(period) {
  const today = new Date();
  const daysBack = (n) => toDateInput(new Date(today.getFullYear(), today.getMonth(), today.getDate() - n + 1));
  switch (period) {
    case '30d': return { from: daysBack(30), to: toDateInput(today) };
    case '90d': return { from: daysBack(90), to: toDateInput(today) };
    case '6m': return { from: toDateInput(new Date(today.getFullYear(), today.getMonth() - 5, 1)), to: toDateInput(today) };
    case 'year': return { from: `${today.getFullYear()}-01-01`, to: toDateInput(today) };
    default: return { from: null, to: null };
  }
}

const changeText = (pct) => (pct === null || pct === undefined ? null : `${pct > 0 ? '+' : ''}${fmtNum(pct)}% מהתקופה הקודמת`);
const bucketLabel = (start, granularity) => (granularity === 'week'
  ? new Date(`${start}T12:00:00`).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' })
  : fmtMonth(start.slice(0, 7)));

/** Horizontal bars with the value written next to each bar (identity is in the label, not the color). */
function BarList({ rows, color, valueText, emptyText }) {
  const max = Math.max(...rows.map((r) => r.value), 0);
  if (!rows.length || !max) return <p className="text-sm text-charcoal-500">{emptyText}</p>;
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.key} className="text-sm" title={r.title}>
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <span className="text-charcoal-700">{r.label}</span>
            <span className="text-xs text-charcoal-500">{valueText(r)}</span>
          </div>
          <div className="h-2.5 rounded-full bg-charcoal-100">
            <div className="h-2.5 rounded-full" style={{ width: `${Math.max(2, (r.value / max) * 100)}%`, background: color }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function BIDashboard({ onOpenCustomer }) {
  const [period, setPeriod] = useState('all');
  const [granularity, setGranularity] = useState('month');
  const [product, setProduct] = useState('');
  const [method, setMethod] = useState('');
  const [options, setOptions] = useState({ products: [], methods: [] });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const { from, to } = useMemo(() => periodRange(period), [period]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const params = new URLSearchParams({ granularity });
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (product) params.set('product', product);
    if (method) params.set('method', method);
    api.get(`/accounting/bi/dashboard?${params}`)
      .then((r) => { if (alive) { setData(r); setOptions(r.filterOptions ?? { products: [], methods: [] }); setError(null); } })
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [from, to, granularity, product, method]);

  useTheme(); // re-render on theme change, so the chart colors below are re-read
  const palette = document.documentElement.classList.contains('dark') ? COLORS.dark : COLORS.light;
  const ct = {
    grid: cssColor('charcoal-100'),
    tick: cssColor('charcoal-500'),
    surface: cssColor('surface'),
    tooltip: {
      borderRadius: 12, fontFamily: 'Heebo', direction: 'rtl', fontSize: 12,
      border: `1px solid ${cssColor('charcoal-200')}`, background: cssColor('surface'), color: cssColor('charcoal-900'),
    },
  };

  const filters = (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex flex-wrap rounded-xl border border-charcoal-200 bg-surface p-0.5 text-sm">
        {PERIODS.map(([id, label]) => (
          <button key={id} onClick={() => setPeriod(id)} className={`rounded-lg px-3 py-1.5 ${period === id ? 'bg-sage-600 text-white' : 'text-charcoal-600'}`}>{label}</button>
        ))}
      </div>
      <div className="flex rounded-xl border border-charcoal-200 bg-surface p-0.5 text-sm">
        {[['month', 'לפי חודש'], ['week', 'לפי שבוע']].map(([id, label]) => (
          <button key={id} onClick={() => setGranularity(id)} className={`rounded-lg px-3 py-1.5 ${granularity === id ? 'bg-sage-600 text-white' : 'text-charcoal-600'}`}>{label}</button>
        ))}
      </div>
      <select className="input w-auto py-1.5 text-sm" value={product} onChange={(e) => setProduct(e.target.value)} aria-label="סינון לפי מוצר">
        <option value="">כל המוצרים</option>
        {options.products.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
      <select className="input w-auto py-1.5 text-sm" value={method} onChange={(e) => setMethod(e.target.value)} aria-label="סינון לפי אמצעי תשלום">
        <option value="">כל אמצעי התשלום</option>
        {options.methods.map((m) => <option key={m.key} value={m.key}>{methodLabel(m.method, m.app)}</option>)}
      </select>
      {loading && data && <Spinner className="h-4 w-4 text-sage-500" />}
    </div>
  );

  if (!data) return <div className="space-y-6">{filters}{error ? <ErrorNote error={error} /> : <div className="grid h-40 place-items-center"><Spinner className="h-6 w-6 text-sage-500" /></div>}</div>;

  const s = data.summary;
  const ch = data.change ?? {};
  const series = data.timeline.map((b) => ({ ...b, label: bucketLabel(b.start, granularity) }));
  const noData = !s.purchases;

  return (
    <div className={`space-y-6 ${loading ? 'opacity-70' : ''}`}>
      {filters}
      <ErrorNote error={error} />
      <p className="text-xs text-charcoal-500">
        {data.period.from ? `${fmtDay(data.period.from)} – ${fmtDay(data.period.to)}` : `כל הנתונים: ${fmtDay(data.dataRange.first)} – ${fmtDay(data.dataRange.last)}`}
        {data.previous && ` · השוואה ל-${fmtDay(data.previous.from)} – ${fmtDay(data.previous.to)}`}
        {(product || method) && ' · מסונן לפי מוצר או אמצעי תשלום (השימור מחושב על כל הלקוחות)'}
      </p>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard icon={Wallet} label="הכנסות" value={fmtMoney(s.revenue)} sub={changeText(ch.revenue)} />
        <StatCard icon={ShoppingBag} label="רכישות" value={fmtNum(s.purchases)} sub={changeText(ch.purchases) ?? `ממוצע ${fmtMoney(s.averagePurchase)} לרכישה`} tone="honey" />
        <StatCard icon={Receipt} label="ממוצע לרכישה" value={fmtMoney(s.averagePurchase)} tone="charcoal" />
        <StatCard icon={Users} label="לקוחות שקנו" value={fmtNum(s.buyers)} sub={changeText(ch.buyers)} tone="sky" />
        <StatCard icon={UserPlus} label="לקוחות חדשים" value={fmtNum(s.newCustomers)} sub={changeText(ch.newCustomers) ?? 'רכישה ראשונה בתקופה'} tone="sky" />
        <StatCard icon={Repeat} label="רכישות חוזרות" value={`${fmtNum(s.repeatShare)}%`} sub={`${fmtNum(s.repeatPurchases)} רכישות · ${fmtMoney(s.repeatRevenue)}`} />
      </div>

      {noData ? <Card><Empty icon={Receipt} title="אין רכישות בתקופה הזו">בחרו תקופה אחרת</Empty></Card> : (
        <>
          <div className="grid gap-6 xl:grid-cols-2">
            <Card title="הכנסות">
              <div className="h-64" dir="ltr">
                <ResponsiveContainer>
                  <BarChart data={series} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                    <CartesianGrid stroke={ct.grid} vertical={false} />
                    <XAxis dataKey="label" reversed tick={{ fontSize: 11, fill: ct.tick }} />
                    <YAxis orientation="right" width={60} tickFormatter={fmtMoneyCompact} tick={{ fontSize: 11, fill: ct.tick }} />
                    <Tooltip contentStyle={ct.tooltip} cursor={{ fill: ct.grid }} formatter={(v, n, p) => [`${fmtMoney(v)} · ${fmtNum(p.payload.purchases)} רכישות`, 'הכנסות']} />
                    <Bar dataKey="revenue" name="הכנסות" fill={palette.revenue} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
            <Card title="רכישות: לקוחות חדשים מול רכישות חוזרות">
              <div className="h-64" dir="ltr">
                <ResponsiveContainer>
                  <BarChart data={series} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                    <CartesianGrid stroke={ct.grid} vertical={false} />
                    <XAxis dataKey="label" reversed tick={{ fontSize: 11, fill: ct.tick }} />
                    <YAxis orientation="right" width={40} allowDecimals={false} tick={{ fontSize: 11, fill: ct.tick }} />
                    <Tooltip contentStyle={ct.tooltip} cursor={{ fill: ct.grid }} formatter={(v, n) => [fmtNum(v), n]} />
                    <Legend wrapperStyle={{ fontFamily: 'Heebo', fontSize: 12 }} />
                    <Bar dataKey="firstPurchases" name="רכישה ראשונה" stackId="p" fill={palette.first} stroke={ct.surface} strokeWidth={2} />
                    <Bar dataKey="repeatPurchases" name="רכישה חוזרת" stackId="p" fill={palette.repeat} stroke={ct.surface} strokeWidth={2} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>
          <details className="text-sm">
            <summary className="cursor-pointer text-xs text-sage-700">הנתונים של שני הגרפים בטבלה</summary>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-right text-charcoal-500"><tr><th className="py-1 pl-3">תקופה</th><th className="pl-3">הכנסות</th><th className="pl-3">רכישות</th><th className="pl-3">ראשונה</th><th>חוזרת</th></tr></thead>
                <tbody>{series.map((b) => (
                  <tr key={b.start} className="border-t border-charcoal-100"><td className="py-1 pl-3">{b.label}</td><td className="pl-3">{fmtMoney(b.revenue)}</td><td className="pl-3">{fmtNum(b.purchases)}</td><td className="pl-3">{fmtNum(b.firstPurchases)}</td><td>{fmtNum(b.repeatPurchases)}</td></tr>
                ))}</tbody>
              </table>
            </div>
          </details>

          <div className="grid gap-6 lg:grid-cols-2 xl:grid-cols-3">
            <Card title="אמצעי תשלום">
              <BarList
                color={palette.revenue}
                rows={data.methods.map((m) => ({ key: m.key, label: methodLabel(m.method, m.app), value: m.amount, count: m.count }))}
                valueText={(r) => `${fmtMoney(r.value)} · ${fmtNum(r.count)} תשלומים · ${Math.round((r.value / Math.max(1, s.revenue)) * 100)}%`}
                emptyText="אין תשלומים בתקופה"
              />
            </Card>
            <Card title="מוצרים (לפי תיאור הקבלה)">
              <BarList
                color={palette.revenue}
                rows={data.products.map((p) => ({ key: p.id, label: p.label, value: p.purchases, amount: p.amount, customers: p.customers }))}
                valueText={(r) => `${fmtNum(r.value)} רכישות · ${fmtNum(r.customers)} לקוחות · ${fmtMoney(r.amount)}`}
                emptyText="אין רכישות בתקופה"
              />
              <p className="mt-3 flex gap-1.5 text-xs text-charcoal-500">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                הערכה: בקבלות אין שורות מוצרים, רק תיאור חופשי. קבלה שמזכירה שני מוצרים נספרת בשניהם.
              </p>
            </Card>
            <Card title="ימים בשבוע">
              <BarList
                color={palette.revenue}
                rows={data.weekdays.map((w) => ({ key: String(w.day), label: `יום ${WEEKDAYS[w.day]}`, value: w.purchases, amount: w.amount }))}
                valueText={(r) => `${fmtNum(r.value)} רכישות · ${fmtMoney(r.amount)}`}
                emptyText="אין רכישות בתקופה"
              />
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="כמה לקוחות חוזרים לקנות (כל התקופות)">
              <div className="grid grid-cols-3 gap-3">
                {data.retention.windows.map((w) => (
                  <div key={w.days} className="rounded-xl border border-charcoal-100 p-3 text-center">
                    <div className="text-xs text-charcoal-500">תוך {w.days} יום</div>
                    <div className="mt-1 text-2xl font-semibold text-charcoal-900">{w.share === null ? '—' : `${w.share}%`}</div>
                    <div className="text-xs text-charcoal-400">{fmtNum(w.returned)} מתוך {fmtNum(w.eligible)}</div>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-sm text-charcoal-600">
                {data.retention.medianGapDays === null ? 'עדיין אין לקוחות שקנו פעמיים.' : `לקוח חוזר קונה שוב בדרך כלל (חציון) אחרי ${fmtNum(data.retention.medianGapDays)} ימים.`}
              </p>
              <p className="mt-1 text-xs text-charcoal-400">נספרים רק לקוחות שהרכישה הראשונה שלהם הייתה לפני מספיק זמן כדי שיספיקו לחזור.</p>
            </Card>
            <Card title="10 הלקוחות המובילים בתקופה" bodyClass="">
              <table className="w-full text-sm">
                <thead className="bg-charcoal-50/60 text-right text-xs text-charcoal-500">
                  <tr><th className="px-5 py-2 font-medium">לקוח</th><th className="px-3 py-2 font-medium">רכישות</th><th className="px-3 py-2 font-medium">סה"כ</th><th className="hidden px-3 py-2 font-medium sm:table-cell">אחרונה</th></tr>
                </thead>
                <tbody className="divide-y divide-charcoal-100">
                  {data.topCustomers.map((c) => (
                    <tr key={c.id} onClick={() => onOpenCustomer(c.id)} className="cursor-pointer hover:bg-sage-50/40">
                      <td className="px-5 py-2" dir="auto">{c.name || 'ללא שם'}</td>
                      <td className="px-3 py-2">{fmtNum(c.purchases)}</td>
                      <td className="px-3 py-2 font-medium">{fmtMoney(c.amount)}</td>
                      <td className="hidden px-3 py-2 text-charcoal-600 sm:table-cell">{c.lastDate ? fmtDay(c.lastDate) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
