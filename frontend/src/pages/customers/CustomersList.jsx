// "לקוחות": headline numbers, search, filters, sorting, Excel export, and the customers table
// (with a delete button on each row).
import { useEffect, useState } from 'react';
import { Users, Repeat, Wallet, UserRound, Search, Download, ChevronLeft, ChevronRight, FilePlus2, Trash2 } from 'lucide-react';
import NewOrderForm from './NewOrderForm.jsx';
import OrdersAttention from './OrdersAttention.jsx';
import DeleteCustomerDialog from './DeleteCustomerDialog.jsx';
import { api, STATIC_DEMO } from '../../api.js';
import { fmtNum } from '../../constants.js';
import { StatCard, Card, Empty, ErrorNote, Spinner } from '../../components/ui.jsx';
import { SEGMENTS, SORTS, IDENTIFIED, fmtMoney, fmtDay, methodLabel } from './customerFormat.js';

const PAGE_SIZE = 50;
const SEARCH_DELAY_MS = 300;

export default function CustomersList({ onOpen }) {
  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  const [segment, setSegment] = useState('all');
  const [sort, setSort] = useState('last_purchase');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [ordering, setOrdering] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [deleting, setDeleting] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => { setQ(query.trim()); setPage(1); }, SEARCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const params = new URLSearchParams({ q, segment, sort, page: String(page), pageSize: String(PAGE_SIZE) });
    api.get(`/accounting/customers?${params}`)
      .then((r) => { if (alive) { setData(r); setError(null); } })
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [q, segment, sort, page, refreshKey]);

  const s = data?.summary;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const exportHref = `/api/accounting/customers/export.csv?${new URLSearchParams({ q, segment, sort })}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {STATIC_DEMO
          ? <button className="btn-primary" disabled title="לא זמין בגרסת ההדגמה"><FilePlus2 className="h-4 w-4" /> הזמנה חדשה</button>
          : <button className="btn-primary" onClick={() => setOrdering(true)}><FilePlus2 className="h-4 w-4" /> הזמנה חדשה</button>}
      </div>
      {!STATIC_DEMO && <OrdersAttention refreshKey={refreshKey} onChanged={() => setRefreshKey((k) => k + 1)} />}
      {!STATIC_DEMO && <NewOrderForm open={ordering} onClose={() => setOrdering(false)} onIssued={() => setRefreshKey((k) => k + 1)} />}
      {!STATIC_DEMO && <DeleteCustomerDialog customerId={deleting} onClose={() => setDeleting(null)} onDeleted={() => { setDeleting(null); setRefreshKey((k) => k + 1); }} />}
      {s && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard icon={Users} label="לקוחות" value={fmtNum(s.customers)} sub={`${fmtNum(s.buyers)} מהם קנו לפחות פעם אחת`} />
          <StatCard icon={Repeat} label="לקוחות חוזרים" value={fmtNum(s.returning)} sub={`${s.returningShare}% מהלקוחות שקנו`} tone="sky" />
          <StatCard icon={Wallet} label="סך הרכישות" value={fmtMoney(s.revenue)} sub={`${fmtNum(s.purchases)} רכישות`} tone="honey" />
          <StatCard icon={UserRound} label="ממוצע ללקוח" value={fmtMoney(s.averagePerBuyer)} sub="מתוך הלקוחות שקנו" tone="charcoal" />
        </div>
      )}

      <Card bodyClass="">
        <div className="flex flex-wrap items-center gap-3 border-b border-charcoal-100 px-5 py-3.5">
          <div className="relative min-w-[12rem] flex-1">
            <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-charcoal-400" />
            <input className="input pr-9" placeholder="חיפוש לפי שם, טלפון או מייל" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="חיפוש לקוח" />
          </div>
          <div className="flex flex-wrap rounded-xl border border-charcoal-200 p-0.5 text-sm">
            {SEGMENTS.map((sg) => (
              <button key={sg.id} onClick={() => { setSegment(sg.id); setPage(1); }}
                className={`rounded-lg px-3 py-1.5 ${segment === sg.id ? 'bg-sage-600 text-white' : 'text-charcoal-600'}`}>{sg.label}</button>
            ))}
          </div>
          <select className="input w-auto py-1.5 text-sm" value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }} aria-label="מיון">
            {SORTS.map((o) => <option key={o.id} value={o.id}>מיון: {o.label}</option>)}
          </select>
          {STATIC_DEMO
            ? <button className="btn-secondary px-3 py-1.5" disabled title="לא זמין בגרסת ההדגמה"><Download className="h-4 w-4" /> ייצוא ל-Excel</button>
            : <a className="btn-secondary px-3 py-1.5" href={exportHref}><Download className="h-4 w-4" /> ייצוא ל-Excel</a>}
        </div>

        <ErrorNote error={error} />
        {!data ? (
          <div className="grid h-40 place-items-center"><Spinner className="h-6 w-6 text-sage-500" /></div>
        ) : data.items.length ? (
          <div className={`overflow-x-auto ${loading ? 'opacity-60' : ''}`}>
            <table className="w-full text-sm">
              <thead className="bg-charcoal-50/60 text-right text-xs text-charcoal-500">
                <tr>
                  <th className="px-5 py-2.5 font-medium">לקוח</th>
                  <th className="hidden px-3 py-2.5 font-medium md:table-cell">פרטי קשר</th>
                  <th className="px-3 py-2.5 font-medium">רכישות</th>
                  <th className="px-3 py-2.5 font-medium">סה"כ</th>
                  <th className="hidden px-3 py-2.5 font-medium sm:table-cell">רכישה אחרונה</th>
                  <th className="hidden px-3 py-2.5 font-medium lg:table-cell">תשלום אחרון</th>
                  <th className="px-3 py-2.5 font-medium"><span className="sr-only">מחיקה</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-charcoal-100">
                {data.items.map((c) => {
                  const idf = IDENTIFIED[c.identifiedBy];
                  return (
                    <tr key={c.id} onClick={() => onOpen(c.id)} className="cursor-pointer hover:bg-sage-50/40">
                      <td className="px-5 py-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium text-charcoal-800" dir="auto">{c.name || 'ללא שם'}</span>
                          <span className={`chip ${idf.cls}`} title={idf.hint}>{idf.label}</span>
                          {c.purchases >= 2 && <span className="chip bg-sky-50 text-sky-700">חוזר</span>}
                          {c.removed && <span className="chip bg-red-50 text-red-700">הוסר ב-Morning</span>}
                        </div>
                      </td>
                      <td className="hidden px-3 py-3 text-charcoal-600 md:table-cell" dir="ltr">
                        <div className="text-right">{c.phone || c.email || '—'}</div>
                      </td>
                      <td className="px-3 py-3">{fmtNum(c.purchases)}</td>
                      <td className="px-3 py-3 font-medium">{fmtMoney(c.total)}</td>
                      <td className="hidden px-3 py-3 text-charcoal-600 sm:table-cell">{fmtDay(c.lastDate)}</td>
                      <td className="hidden px-3 py-3 text-charcoal-600 lg:table-cell">{methodLabel(c.lastMethod, c.lastApp) || '—'}</td>
                      <td className="px-3 py-3 text-left">
                        {!STATIC_DEMO && (
                          <button className="btn-ghost px-2 py-1 text-charcoal-400 hover:text-red-600" title="מחיקת לקוח" aria-label={`מחיקת ${c.name || 'לקוח'}`}
                            onClick={(e) => { e.stopPropagation(); setDeleting(c.id); }}>
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={Users} title={q || segment !== 'all' ? 'אין לקוחות שמתאימים לחיפוש' : 'עדיין אין לקוחות'}>
            {q || segment !== 'all' ? 'נסו חיפוש אחר או סינון אחר' : 'הלקוחות יופיעו כאן אחרי הסנכרון הראשון מ-Morning (בלשונית "סנכרון והגדרות")'}
          </Empty>
        )}

        {data && data.total > data.pageSize && (
          <div className="flex items-center justify-between border-t border-charcoal-100 px-5 py-3 text-sm text-charcoal-600">
            <span>{fmtNum(data.total)} לקוחות · עמוד {page} מתוך {pages}</span>
            <div className="flex gap-2">
              <button className="btn-ghost px-2 py-1" onClick={() => setPage(page - 1)} disabled={page <= 1} aria-label="עמוד קודם"><ChevronRight className="h-4 w-4" /></button>
              <button className="btn-ghost px-2 py-1" onClick={() => setPage(page + 1)} disabled={page >= pages} aria-label="עמוד הבא"><ChevronLeft className="h-4 w-4" /></button>
            </div>
          </div>
        )}
      </Card>
      <p className="text-xs text-charcoal-400">
        רכישה = קבלה או חשבונית מס/קבלה שלא בוטלה. חשבונית זיכוי מקטינה את הסכום. לקוח חוזר = שתי רכישות או יותר.
      </p>
    </div>
  );
}
