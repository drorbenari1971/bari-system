// Orders whose receipt may or may not have been issued (the answer from Morning was lost). They need
// a check against Morning before anything else is done with them.
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { api } from '../../api.js';
import { fmtDateTime } from '../../constants.js';
import { ErrorNote, Spinner } from '../../components/ui.jsx';
import { fmtMoney } from './customerFormat.js';

export default function OrdersAttention({ refreshKey, onChanged }) {
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  const load = useCallback(() => api.get('/accounting/orders?status=uncertain').then((r) => setItems(r.items)).catch(() => setItems([])), []);
  useEffect(() => { load(); }, [load, refreshKey]);

  const check = async (id) => {
    setBusy(id); setError(null); setNote(null);
    try {
      const r = await api.post(`/accounting/orders/${id}/reconcile`);
      setNote(r.status === 'issued' ? `נמצאה ב-Morning קבלה מס' ${r.documentNumber}. ההזמנה סומנה כהופקה.` : 'הקבלה לא נוצרה ב-Morning. אפשר להפיק אותה שוב מטופס "הזמנה חדשה".');
      await load();
      onChanged();
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  };

  if (!items.length && !note && !error) return null;
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">
      {items.length > 0 && (
        <>
          <div className="flex items-center gap-2 font-semibold text-amber-900"><AlertTriangle className="h-4 w-4" /> הזמנות שלא ידוע אם הקבלה שלהן הופקה</div>
          <ul className="mt-2 space-y-1.5">
            {items.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center justify-between gap-2">
                <span dir="auto">{o.customerName} · {fmtMoney(o.total)} · {fmtDateTime(o.createdAt)}</span>
                <button className="btn-secondary px-2 py-1" onClick={() => check(o.id)} disabled={!!busy}>
                  {busy === o.id ? <Spinner /> : <RotateCcw className="h-3.5 w-3.5" />} בדיקה ב-Morning
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {note && <p className="mt-2 text-amber-900">{note}</p>}
      <ErrorNote error={error} />
    </div>
  );
}
