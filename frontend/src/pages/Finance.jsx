import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine,
} from 'recharts';
import { TrendingUp, TrendingDown, Wallet, Percent, Plus, Pencil, Trash2, Receipt } from 'lucide-react';
import { api } from '../api.js';
import { useStatus, useTheme } from '../App.jsx';
import { PRODUCTS } from '../constants.js';
import {
  summarize, fmtMoney, fmtMoneyCompact, fmtMonth, fmtDay, toDateInput, parseAmount, amountToInput,
} from '../financeSummary.js';
import { Card, DemoBadge, Empty, ErrorNote, Modal, Notice, Spinner, StatCard } from '../components/ui.jsx';

const EXPENSE_TYPES = ['חשמל', 'מים', 'מערכות טכנולוגיות', 'מנויים', 'חומרי גלם', 'שליחויות', 'אריזות', 'שכירות', 'שיווק ופרסום', 'שכר', 'אחר'];
const INCOME_TYPES = [...PRODUCTS.map((p) => p.label), 'אחר'];
const KIND_LABEL = { income: 'הכנסה', expense: 'הוצאה' };
const PAGE_SIZE = 50;

// Fixed for every palette and mode, so income and expenses always keep their color.
// Validated for colorblind separation and contrast on the light and dark surfaces.
const SERIES = { income: '#1f8042', expenses: '#b56ec9' };

const cssColor = (name) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
  return `rgb(${v.split(/\s+/).join(',')})`;
};

function periodRange(period, custom) {
  const now = new Date();
  const monthsBack = (n) => toDateInput(new Date(now.getFullYear(), now.getMonth() - n, 1));
  const endOfMonth = toDateInput(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  switch (period) {
    case 'month': return { from: monthsBack(0), to: endOfMonth };
    case '3m': return { from: monthsBack(2), to: endOfMonth };
    case '6m': return { from: monthsBack(5), to: endOfMonth };
    case 'year': return { from: `${now.getFullYear()}-01-01`, to: endOfMonth };
    case 'custom': return { from: custom.from || null, to: custom.to || null };
    default: return { from: null, to: null };
  }
}

const PERIODS = [['month', 'החודש'], ['3m', '3 חודשים'], ['6m', '6 חודשים'], ['year', 'השנה'], ['all', 'הכל'], ['custom', 'טווח']];

export default function Finance() {
  const { refreshStatus } = useStatus();
  const [period, setPeriod] = useState('6m');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);
  const [kindFilter, setKindFilter] = useState('all');
  const [visible, setVisible] = useState(PAGE_SIZE);

  const { from, to } = useMemo(() => periodRange(period, custom), [period, custom]);

  const load = useCallback(async () => {
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    try {
      setRows(await api.get(`/finance/transactions?${q}`));
    } catch (e) { setError(e.message); }
  }, [from, to]);
  useEffect(() => { load(); }, [load]);

  const summary = useMemo(() => summarize(rows ?? [], from, to), [rows, from, to]);
  const hasDemo = rows?.some((r) => r.is_demo);
  const shown = useMemo(() => (rows ?? []).filter((r) => kindFilter === 'all' || r.kind === kindFilter), [rows, kindFilter]);

  useTheme(); // re-render on theme or palette change, so the chart colors below are re-read
  const ct = {
    line: cssColor('charcoal-700'),
    grid: cssColor('charcoal-100'),
    tick: cssColor('charcoal-500'),
    zero: cssColor('charcoal-300'),
    tooltip: {
      borderRadius: 12, fontFamily: 'Heebo', direction: 'rtl', fontSize: 12,
      border: `1px solid ${cssColor('charcoal-200')}`,
      background: cssColor('surface'),
      color: cssColor('charcoal-900'),
    },
  };
  const chartData = summary.months.map((m) => ({ ...m, label: fmtMonth(m.month) }));

  const remove = async (row) => {
    if (!confirm(`למחוק את הרשומה "${row.category}" על סך ${fmtMoney(row.amount_agorot)}?`)) return;
    setError(null);
    try { await api.del(`/finance/transactions/${row.id}`); await load(); } catch (e) { setError(e.message); }
  };

  const clearDemo = async () => {
    if (!confirm('למחוק את נתוני הדוגמה של הכספים? רשומות שהזנת בעצמך יישארו.')) return;
    setError(null);
    try { await api.del('/finance/demo'); await load(); refreshStatus(); } catch (e) { setError(e.message); }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">כספים ותזרים</h1>
        <p className="page-sub">הכנסות, הוצאות ורווחיות לפי תאריך, על בסיס הרשומות שהוזנו</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap rounded-xl border border-charcoal-200 bg-surface p-0.5 text-sm">
          {PERIODS.map(([id, label]) => (
            <button key={id} onClick={() => { setPeriod(id); setVisible(PAGE_SIZE); }} className={`rounded-lg px-3 py-1.5 ${period === id ? 'bg-sage-600 text-white' : 'text-charcoal-600'}`}>{label}</button>
          ))}
        </div>
        {period === 'custom' && (
          <div className="flex flex-wrap items-center gap-2 text-sm text-charcoal-600">
            <label className="flex items-center gap-1.5">מתאריך
              <input type="date" className="input w-auto" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
            </label>
            <label className="flex items-center gap-1.5">עד
              <input type="date" className="input w-auto" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
            </label>
          </div>
        )}
      </div>

      <ErrorNote error={error} />
      {hasDemo && (
        <Notice>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>המספרים כאן כוללים נתוני דוגמה. מחקו אותם לפני שמזינים נתונים אמיתיים, כדי שלא יתערבבו בסיכומים.</span>
            <button className="btn-secondary px-3 py-1" onClick={clearDemo}><Trash2 className="h-3.5 w-3.5" /> מחק נתוני דוגמה</button>
          </div>
        </Notice>
      )}

      {!rows && !error ? (
        <div className="grid h-40 place-items-center"><Spinner className="h-6 w-6 text-sage-500" /></div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard icon={TrendingUp} label="הכנסות" value={<Money value={summary.income} />} />
            <StatCard icon={TrendingDown} label="הוצאות" value={<Money value={summary.expenses} />} tone="honey" />
            <StatCard icon={Wallet} label={summary.net < 0 ? 'הפסד' : 'רווח'} value={<Money value={summary.net} />} sub="הכנסות פחות הוצאות" tone="charcoal" />
            <StatCard icon={Percent} label="רווחיות" value={summary.margin === null ? '—' : `${(summary.margin * 100).toFixed(1)}%`} sub="הרווח מתוך ההכנסות" tone="sky" />
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            <Card title="הכנסות מול הוצאות לפי חודש">
              {summary.months.length ? (
                <div dir="ltr" className="h-[300px]">
                  <ResponsiveContainer>
                    <BarChart data={chartData} barGap={2} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                      <CartesianGrid stroke={ct.grid} vertical={false} />
                      <XAxis dataKey="label" reversed tick={{ fontSize: 11, fill: ct.tick }} />
                      <YAxis orientation="right" width={60} tickFormatter={fmtMoneyCompact} tick={{ fontSize: 11, fill: ct.tick }} />
                      <Tooltip contentStyle={ct.tooltip} cursor={{ fill: ct.grid }} formatter={(v) => fmtMoney(v)} />
                      <Legend wrapperStyle={{ fontFamily: 'Heebo', fontSize: 12 }} />
                      <Bar dataKey="income" name="הכנסות" fill={SERIES.income} radius={[4, 4, 0, 0]} />
                      <Bar dataKey="expenses" name="הוצאות" fill={SERIES.expenses} radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : <Empty icon={Receipt} title="אין נתונים בתקופה הזו" />}
            </Card>

            <Card title="יתרה מצטברת בתקופה">
              {summary.months.length ? (
                <>
                  <div dir="ltr" className="h-[272px]">
                    <ResponsiveContainer>
                      <LineChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                        <CartesianGrid stroke={ct.grid} vertical={false} />
                        <XAxis dataKey="label" reversed tick={{ fontSize: 11, fill: ct.tick }} />
                        <YAxis orientation="right" width={60} tickFormatter={fmtMoneyCompact} tick={{ fontSize: 11, fill: ct.tick }} />
                        <Tooltip contentStyle={ct.tooltip} formatter={(v) => fmtMoney(v)} />
                        <ReferenceLine y={0} stroke={ct.zero} />
                        <Line type="monotone" dataKey="cumulative" name="יתרה מצטברת" stroke={ct.line} strokeWidth={2} dot={{ r: 4 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  <p className="mt-2 text-xs text-charcoal-400">מתחיל מ-0 בתחילת התקופה שנבחרה, ולא כולל את היתרה בבנק.</p>
                </>
              ) : <Empty icon={Wallet} title="אין נתונים בתקופה הזו" />}
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="הכנסות לפי מוצר או סיווג"><Breakdown items={summary.byIncome} /></Card>
            <Card title="הוצאות לפי סוג"><Breakdown items={summary.byExpense} /></Card>
          </div>

          <Card title="תזרים חודשי" bodyClass="overflow-x-auto">
            {summary.months.length ? (
              <table className="w-full min-w-[560px] text-sm">
                <thead className="bg-sage-50/60 text-xs text-charcoal-500">
                  <tr>
                    {['חודש', 'הכנסות', 'הוצאות', 'רווח / הפסד', 'יתרה מצטברת'].map((h) => <th key={h} className="px-4 py-2.5 text-right font-medium">{h}</th>)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-charcoal-100">
                  {[...summary.months].reverse().map((m) => (
                    <tr key={m.month} className="hover:bg-sage-50/40">
                      <td className="px-4 py-2.5 font-medium">{fmtMonth(m.month)}</td>
                      <td className="px-4 py-2.5"><Money value={m.income} /></td>
                      <td className="px-4 py-2.5"><Money value={m.expenses} /></td>
                      <td className="px-4 py-2.5 font-medium"><Money value={m.net} /></td>
                      <td className="px-4 py-2.5"><Money value={m.cumulative} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <Empty icon={Receipt} title="אין נתונים בתקופה הזו" />}
          </Card>
        </>
      )}

      <Card title="הוספת רשומה">
        <TransactionForm key="new" onSaved={load} />
      </Card>

      <Card
        bodyClass="overflow-x-auto"
        title="רשומות"
        action={(
          <div className="flex gap-1">
            {[['all', 'הכל'], ['income', 'הכנסות'], ['expense', 'הוצאות']].map(([id, label]) => (
              <button key={id} onClick={() => setKindFilter(id)} className={`rounded-lg px-2.5 py-1 text-xs font-medium ${kindFilter === id ? 'bg-sage-600 text-white' : 'text-charcoal-500 hover:bg-charcoal-50'}`}>{label}</button>
            ))}
          </div>
        )}
      >
        {shown.length ? (
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-sage-50/60 text-xs text-charcoal-500">
              <tr>
                {['תאריך', 'סוג', 'מוצר / סוג הוצאה', 'סיווג', 'סכום', ''].map((h) => <th key={h} className="px-4 py-2.5 text-right font-medium">{h}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-charcoal-100">
              {shown.slice(0, visible).map((r) => (
                <tr key={r.id} className="hover:bg-sage-50/40">
                  <td className="whitespace-nowrap px-4 py-2.5 text-charcoal-500">{fmtDay(r.date)}</td>
                  <td className="px-4 py-2.5">{KIND_LABEL[r.kind]}</td>
                  <td className="px-4 py-2.5 font-medium">{r.category} {r.is_demo && <DemoBadge />}</td>
                  <td className="px-4 py-2.5 text-charcoal-500">{r.subcategory || '—'}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 font-medium"><Money value={r.kind === 'expense' ? -r.amount_agorot : r.amount_agorot} /></td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-left">
                    <button className="btn-ghost p-1.5" onClick={() => setEditing(r)} aria-label="עריכה"><Pencil className="h-4 w-4" /></button>
                    <button className="btn-ghost p-1.5" onClick={() => remove(r)} aria-label="מחיקה"><Trash2 className="h-4 w-4" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <Empty icon={Receipt} title="אין רשומות להצגה">הוסיפו הכנסה או הוצאה בטופס שלמעלה</Empty>}
        {shown.length > visible && (
          <div className="p-3 text-center">
            <button className="btn-secondary" onClick={() => setVisible((v) => v + PAGE_SIZE)}>הצג עוד</button>
          </div>
        )}
      </Card>

      <Modal open={!!editing} onClose={() => setEditing(null)} title="עריכת רשומה">
        {editing && <TransactionForm key={editing.id} row={editing} onSaved={async () => { setEditing(null); await load(); }} />}
      </Modal>
    </div>
  );
}

// Keeps the shekel sign and minus sign together inside right-to-left text.
const Money = ({ value }) => <span dir="ltr">{fmtMoney(value)}</span>;

function Breakdown({ items }) {
  if (!items.length) return <Empty title="אין נתונים בתקופה הזו" />;
  return (
    <ul className="space-y-3">
      {items.map((it) => (
        <li key={it.category}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
            <span className="font-medium text-charcoal-800">{it.category}</span>
            <span className="whitespace-nowrap text-charcoal-600"><Money value={it.amount} /> · {(it.share * 100).toFixed(1)}%</span>
          </div>
          <div className="h-2 rounded-full bg-charcoal-50">
            <div className="h-2 rounded-full bg-sage-500" style={{ width: `${Math.max(it.share * 100, 1)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function TransactionForm({ row, onSaved }) {
  const blank = { kind: 'income', date: toDateInput(new Date()), category: '', subcategory: '', amount: '' };
  const [form, setForm] = useState(row
    ? { kind: row.kind, date: row.date, category: row.category, subcategory: row.subcategory, amount: amountToInput(row.amount_agorot) }
    : blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });
  const isExpense = form.kind === 'expense';
  const listId = `finance-types-${row?.id ?? 'new'}`;

  const submit = async (e) => {
    e.preventDefault();
    const amount = parseAmount(form.amount);
    if (amount === null) { setError('יש להזין סכום גדול מאפס, למשל 1250 או 1250.50'); return; }
    setBusy(true); setError(null);
    const body = { kind: form.kind, date: form.date, category: form.category, subcategory: form.subcategory, amount_agorot: amount };
    try {
      if (row) await api.put(`/finance/transactions/${row.id}`, body);
      else await api.post('/finance/transactions', body);
      if (!row) setForm({ ...blank, kind: form.kind, date: form.date });
      await onSaved();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="flex w-fit rounded-xl border border-charcoal-200 bg-surface p-0.5 text-sm">
        {Object.entries(KIND_LABEL).map(([id, label]) => (
          <button key={id} type="button" onClick={() => setForm({ ...form, kind: id, category: '', subcategory: '' })} className={`rounded-lg px-4 py-1.5 ${form.kind === id ? 'bg-sage-600 text-white' : 'text-charcoal-600'}`}>{label}</button>
        ))}
      </div>
      <div className={`grid gap-3 sm:grid-cols-2 ${isExpense ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`}>
        <div>
          <label className="label">תאריך</label>
          <input type="date" required className="input" value={form.date} onChange={set('date')} />
        </div>
        <div>
          <label className="label">{isExpense ? 'סוג הוצאה' : 'מוצר או סיווג'}</label>
          <input required maxLength={60} list={listId} className="input" placeholder="בחרו מהרשימה או הקלידו" value={form.category} onChange={set('category')} />
          <datalist id={listId}>
            {(isExpense ? EXPENSE_TYPES : INCOME_TYPES).map((t) => <option key={t} value={t} />)}
          </datalist>
        </div>
        {isExpense && (
          <div>
            <label className="label">סיווג (לא חובה)</label>
            <input maxLength={60} className="input" placeholder="למשל: ספק, פרויקט" value={form.subcategory} onChange={set('subcategory')} />
          </div>
        )}
        <div>
          <label className="label">{isExpense ? 'הוצאה (₪)' : 'הכנסה (₪)'}</label>
          <input required inputMode="decimal" dir="ltr" className="input text-right" placeholder="0" value={form.amount} onChange={set('amount')} />
        </div>
      </div>
      <ErrorNote error={error} />
      <button className="btn-primary" disabled={busy}>
        {busy ? <Spinner /> : <Plus className="h-4 w-4" />} {row ? 'שמור שינויים' : `הוסף ${KIND_LABEL[form.kind]}`}
      </button>
    </form>
  );
}
