// Customer card: who the customer is, how they were identified, purchase summary, every document
// with its payments, the Morning client card (if any) and the change history.
import { useEffect, useState } from 'react';
import { ArrowRight, Phone, Mail, FileText, ExternalLink, History, CreditCard, IdCard } from 'lucide-react';
import { api } from '../../api.js';
import { fmtNum, fmtDateTime } from '../../constants.js';
import { Card, Empty, ErrorNote, Spinner } from '../../components/ui.jsx';
import { IDENTIFIED, MATCH, KINDS, DOC_STATUS, ACTIONS, SOURCES, fmtMoney, fmtDay, methodLabel } from './customerFormat.js';

function Stat({ label, value, sub }) {
  return (
    <div className="rounded-xl border border-charcoal-100 p-3">
      <div className="text-xs text-charcoal-500">{label}</div>
      <div className="mt-1 text-lg font-semibold text-charcoal-900">{value}</div>
      {sub && <div className="text-xs text-charcoal-400">{sub}</div>}
    </div>
  );
}

export default function CustomerCard({ id, onBack }) {
  const [c, setC] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setC(null);
    api.get(`/accounting/customers/${id}`).then(setC).catch((e) => setError(e.message));
  }, [id]);

  const back = <button className="btn-ghost px-2 py-1.5" onClick={onBack}><ArrowRight className="h-4 w-4" /> חזרה לרשימה</button>;
  if (!c) return <div className="space-y-4">{back}{error ? <ErrorNote error={error} /> : <div className="grid h-40 place-items-center"><Spinner className="h-6 w-6 text-sage-500" /></div>}</div>;

  const idf = IDENTIFIED[c.identifiedBy];
  return (
    <div className="space-y-6">
      {back}
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold text-charcoal-900" dir="auto">{c.name || 'ללא שם'}</h2>
              <span className={`chip ${idf.cls}`} title={idf.hint}>{idf.label}</span>
              {c.purchases >= 2 && <span className="chip bg-sky-50 text-sky-700">לקוח חוזר</span>}
              {c.removed && <span className="chip bg-red-50 text-red-700">הוסר ב-Morning</span>}
            </div>
            <div className="mt-2 flex flex-wrap gap-4 text-sm text-charcoal-600">
              {c.phone && <span className="flex items-center gap-1.5"><Phone className="h-4 w-4" /><span dir="ltr">{c.phone}</span></span>}
              {c.email && <span className="flex items-center gap-1.5"><Mail className="h-4 w-4" /><span dir="ltr">{c.email}</span></span>}
              {!c.phone && !c.email && <span className="text-charcoal-400">אין טלפון או מייל (הקבלות ב-Morning כוללות רק שם)</span>}
            </div>
          </div>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Stat label="רכישות" value={fmtNum(c.purchases)} />
          <Stat label="סה״כ" value={fmtMoney(c.total)} />
          <Stat label="ממוצע לרכישה" value={c.purchases ? fmtMoney(c.average) : '—'} />
          <Stat label="רכישה ראשונה" value={fmtDay(c.firstDate)} />
          <Stat label="רכישה אחרונה" value={fmtDay(c.lastDate)} />
          <Stat label="בין רכישות" value={c.avgDaysBetween === null ? '—' : `${fmtNum(c.avgDaysBetween)} ימים`} sub={c.avgDaysBetween === null ? null : 'בממוצע'} />
        </div>
        {c.methods.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
            <CreditCard className="h-4 w-4 text-charcoal-400" />
            {c.methods.map((m) => (
              <span key={m.key} className="chip bg-charcoal-50 text-charcoal-700">{methodLabel(m.method, m.app)} · {fmtNum(m.count)} · {fmtMoney(m.amount)}</span>
            ))}
          </div>
        )}
      </Card>

      <Card title={<span className="flex items-center gap-2"><FileText className="h-4 w-4 text-sage-500" /> מסמכים ({fmtNum(c.documents.length)})</span>} bodyClass="">
        {c.documents.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-charcoal-50/60 text-right text-xs text-charcoal-500">
                <tr>
                  <th className="px-5 py-2.5 font-medium">תאריך</th>
                  <th className="px-3 py-2.5 font-medium">מסמך</th>
                  <th className="px-3 py-2.5 font-medium">סכום</th>
                  <th className="hidden px-3 py-2.5 font-medium sm:table-cell">תשלום</th>
                  <th className="hidden px-3 py-2.5 font-medium md:table-cell">תיאור</th>
                  <th className="hidden px-3 py-2.5 font-medium lg:table-cell">זוהה לפי</th>
                  <th className="px-3 py-2.5 font-medium"><span className="sr-only">PDF</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-charcoal-100">
                {c.documents.map((d) => (
                  <tr key={d.id} className={d.counted ? '' : 'text-charcoal-400'}>
                    <td className="px-5 py-2.5 whitespace-nowrap">{fmtDay(d.date)}</td>
                    <td className="px-3 py-2.5">
                      {KINDS[d.kind] ?? d.kind} {d.number}
                      {d.status !== 'open' && d.status !== 'closed' && <span className="chip mr-1 bg-red-50 text-red-700">{DOC_STATUS[d.status]}</span>}
                      {!d.counted && d.status !== 'cancelled' && d.status !== 'cancelling' && <span className="chip mr-1 bg-charcoal-50 text-charcoal-500" title="לא נספר כרכישה">לא נספר</span>}
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap font-medium">{fmtMoney(d.gross)}</td>
                    <td className="hidden px-3 py-2.5 sm:table-cell">{d.payments.map((p) => methodLabel(p.method, p.app)).join(', ') || '—'}</td>
                    <td className="hidden px-3 py-2.5 md:table-cell" dir="auto">
                      {d.lines.length ? d.lines.map((l) => `${l.description}${l.quantity > 1 ? ` ×${l.quantity}` : ''}`).join(', ') : d.description || '—'}
                    </td>
                    <td className="hidden px-3 py-2.5 lg:table-cell">{MATCH[d.customerMatch] ?? '—'}</td>
                    <td className="px-3 py-2.5">
                      {d.pdfUrl && (
                        <a href={d.pdfUrl} target="_blank" rel="noopener noreferrer" className="btn-ghost px-2 py-1" title="פתיחת המסמך ב-Morning">
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty icon={FileText} title="אין מסמכים ללקוח הזה" />}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={<span className="flex items-center gap-2"><IdCard className="h-4 w-4 text-sage-500" /> איך הלקוח מזוהה</span>}>
          {c.cards.length > 0 ? c.cards.map((k) => (
            <div key={k.external_id} className="mb-3 rounded-xl border border-charcoal-100 p-3 text-sm">
              <div className="font-medium">כרטיס לקוח ב-Morning {k.removed_at && <span className="chip bg-red-50 text-red-700">הוסר</span>} {!k.active && <span className="chip bg-amber-50 text-amber-700">לא פעיל</span>}</div>
              <div className="mt-1 space-y-0.5 text-charcoal-600">
                {k.name && <div dir="auto">{k.name}</div>}
                {(k.mobile || k.phone) && <div dir="ltr" className="text-right">{k.mobile || k.phone}</div>}
                {k.emails.length > 0 && <div dir="ltr" className="text-right">{k.emails.join(', ')}</div>}
                {(k.address || k.city) && <div>{[k.address, k.city].filter(Boolean).join(', ')}</div>}
                {k.tax_id && <div>ח.פ/ת.ז: {k.tax_id}</div>}
                {k.source_created_at && <div className="text-xs text-charcoal-400">נוצר ב-Morning: {fmtDay(k.source_created_at.slice(0, 10))}</div>}
              </div>
            </div>
          )) : <p className="mb-3 text-sm text-charcoal-500">אין כרטיס לקוח ב-Morning. הלקוח נוצר מתוך הקבלות.</p>}
          <div className="text-xs text-charcoal-500">
            מזהים: {c.identities.map((i) => `${MATCH[i.kind] ?? i.kind}${i.kind === 'external_id' ? '' : `: ${i.value}`}`).join(' · ') || '—'}
          </div>
        </Card>

        <Card title={<span className="flex items-center gap-2"><History className="h-4 w-4 text-sage-500" /> היסטוריית שינויים</span>} bodyClass="">
          {c.history.length ? (
            <ul className="divide-y divide-charcoal-100">
              {c.history.map((h, i) => (
                <li key={i} className="px-5 py-2.5 text-sm">
                  <span className="font-medium">{ACTIONS[h.action] ?? h.action}</span>
                  {h.linkedBy && <span className="chip mr-1 bg-charcoal-50 text-charcoal-600">לפי {MATCH[h.linkedBy] ?? h.linkedBy}</span>}
                  <span className="text-xs text-charcoal-400"> · {fmtDateTime(h.at)} · {SOURCES[h.source] ?? h.source}</span>
                  {h.changes.length > 0 && h.action === 'customer.updated' && <div className="text-xs text-charcoal-500">{h.changes.join(', ')}</div>}
                </li>
              ))}
            </ul>
          ) : <Empty icon={History} title="אין שינויים" />}
        </Card>
      </div>
    </div>
  );
}
