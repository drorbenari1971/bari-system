// "הזמנה חדשה": customer intake (existing or new), order lines from the Morning catalog, payment,
// and a receipt issued in Morning. Preview first; issuing asks for a final confirmation, because a
// receipt cannot be deleted. Each opened form has its own order key, so a repeated submit never
// issues a second receipt.
import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Eye, FileCheck2, Search, AlertTriangle, CheckCircle2, ExternalLink, RotateCcw } from 'lucide-react';
import { api } from '../../api.js';
import { Modal, ErrorNote, Spinner } from '../../components/ui.jsx';
import { parseAmount, amountToInput, toDateInput } from '../../financeSummary.js';
import { fmtMoney } from './customerFormat.js';

const PAYMENT_OPTIONS = [
  { id: 'Bit', label: 'Bit', method: 'app', app: 'Bit' },
  { id: 'PayBox', label: 'PayBox', method: 'app', app: 'PayBox' },
  { id: 'bank_transfer', label: 'העברה בנקאית', method: 'bank_transfer', app: '' },
  { id: 'cash', label: 'מזומן', method: 'cash', app: '' },
  { id: 'card', label: 'כרטיס אשראי', method: 'card', app: '' },
  { id: 'other', label: 'אחר', method: 'other', app: '' },
];
const emptyLine = () => ({ key: crypto.randomUUID(), itemId: '', description: '', quantity: '1', price: '' });
const lineTotal = (l) => {
  const q = Number(l.quantity);
  const p = parseAmount(l.price);
  return Number.isFinite(q) && q > 0 && p ? Math.round(q * p) : 0;
};

function Field({ label, children, hint }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-xs text-charcoal-400">{hint}</span>}
    </label>
  );
}

/** Pick an existing customer by searching the synced customers. */
function CustomerPicker({ value, onChange }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  useEffect(() => {
    if (value) return undefined;
    const t = setTimeout(() => {
      api.get(`/accounting/customers?${new URLSearchParams({ q: q.trim(), pageSize: '8', sort: 'last_purchase' })}`).then((r) => setResults(r.items)).catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q, value]);

  if (value) {
    return (
      <div className="flex items-center justify-between rounded-xl border border-sage-200 bg-sage-50 px-3 py-2 text-sm">
        <span><span className="font-medium" dir="auto">{value.name}</span>{value.phone && <span className="text-charcoal-500" dir="ltr"> · {value.phone}</span>}{value.email && <span className="text-charcoal-500" dir="ltr"> · {value.email}</span>}</span>
        <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => onChange(null)}>החלפה</button>
      </div>
    );
  }
  return (
    <div>
      <div className="relative">
        <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-charcoal-400" />
        <input className="input pr-9" placeholder="חיפוש לפי שם, טלפון או מייל" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ul className="mt-2 max-h-48 divide-y divide-charcoal-100 overflow-y-auto rounded-xl border border-charcoal-100 text-sm">
        {results.map((c) => (
          <li key={c.id}>
            <button type="button" className="w-full px-3 py-2 text-right hover:bg-sage-50/60" onClick={() => onChange(c)}>
              <span dir="auto">{c.name || 'ללא שם'}</span>
              <span className="text-xs text-charcoal-400"> · {c.purchases} רכישות{c.phone ? ` · ${c.phone}` : ''}</span>
            </button>
          </li>
        ))}
        {!results.length && <li className="px-3 py-2 text-charcoal-400">אין תוצאות</li>}
      </ul>
    </div>
  );
}

export default function NewOrderForm({ open, onClose, presetCustomer = null, onIssued }) {
  const today = toDateInput(new Date());
  const [orderKey, setOrderKey] = useState(() => crypto.randomUUID());
  const [connectionId, setConnectionId] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [mode, setMode] = useState(presetCustomer ? 'existing' : 'new');
  const [picked, setPicked] = useState(presetCustomer);
  const [nc, setNc] = useState({ name: '', mobile: '', email: '', address: '', city: '', taxId: '', remarks: '' });
  const [lines, setLines] = useState([emptyLine()]);
  const [pay, setPay] = useState({ option: 'Bit', date: today, reference: '' });
  const [receipt, setReceipt] = useState({ date: today, description: '', remarks: '', sendEmail: false });
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!open) return;
    api.get('/accounting/connections').then((list) => {
      const conn = list.find((c) => c.enabled && c.provider === 'morning');
      if (!conn) { setError('אין חיבור פעיל ל-Morning. הגדירו אותו בלשונית "סנכרון והגדרות".'); return; }
      setConnectionId(conn.id);
      api.get(`/accounting/orders/catalog?connectionId=${conn.id}`).then(setCatalog).catch((e) => setError(`לא ניתן לטעון את קטלוג המוצרים: ${e.message}`));
    }).catch((e) => setError(e.message));
  }, [open]);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const total = useMemo(() => lines.reduce((n, l) => n + lineTotal(l), 0), [lines]);
  const customerEmail = mode === 'existing' ? picked?.email : nc.email.trim();
  const option = PAYMENT_OPTIONS.find((o) => o.id === pay.option);

  const setLine = (key, patch) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const pickItem = (key, itemId) => {
    const item = catalog.find((i) => i.id === itemId);
    setLine(key, item ? { itemId, description: item.name, price: amountToInput(item.price) } : { itemId: '' });
  };

  const buildOrder = () => ({
    customer: mode === 'existing' ? { mode, customerId: picked?.id } : { mode, ...nc },
    lines: lines.filter((l) => l.description.trim() || l.price).map((l) => ({
      description: l.description, quantity: Number(l.quantity), unitPrice: parseAmount(l.price) ?? -1,
      itemId: l.itemId || undefined, sku: undefined,
    })),
    payment: { method: option.method, app: option.app, amount: total, date: pay.date, reference: pay.reference },
    receipt,
  });

  const preview = async () => {
    setBusy('preview'); setError(null); setConfirming(false);
    try {
      const r = await api.post('/accounting/orders/preview', { connectionId, order: buildOrder() });
      const bytes = Uint8Array.from(atob(r.pdfBase64), (ch) => ch.charCodeAt(0));
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })));
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  };

  const issue = async () => {
    setBusy('issue'); setError(null);
    try {
      const r = await api.post('/accounting/orders', { connectionId, orderKey, order: buildOrder() });
      setResult(r);
      setConfirming(false);
      if (r.status === 'issued') onIssued?.(r);
    } catch (e) { setError(e.message); setConfirming(false); } finally { setBusy(null); }
  };

  const reconcile = async () => {
    setBusy('reconcile'); setError(null);
    try {
      const r = await api.post(`/accounting/orders/${result.id}/reconcile`);
      setResult(r);
      if (r.status === 'issued') onIssued?.(r);
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  };

  const reset = () => {
    setOrderKey(crypto.randomUUID());
    setMode('new'); setPicked(null);
    setNc({ name: '', mobile: '', email: '', address: '', city: '', taxId: '', remarks: '' });
    setLines([emptyLine()]); setPay({ option: 'Bit', date: today, reference: '' });
    setReceipt({ date: today, description: '', remarks: '', sendEmail: false });
    setResult(null); setPreviewUrl(null); setConfirming(false); setError(null);
  };
  const close = () => {
    if (busy) return;
    const dirty = !result && (nc.name || lines.some((l) => l.description || l.price));
    if (dirty && !confirm('לסגור את הטופס? הפרטים שהוזנו לא יישמרו.')) return;
    reset();
    onClose();
  };

  const customerLabel = mode === 'existing' ? picked?.name : nc.name.trim();
  const canSubmit = connectionId && total > 0 && (mode === 'existing' ? !!picked : !!nc.name.trim());

  return (
    <Modal open={open} onClose={close} title="הזמנה חדשה וקבלה" wide>
      {result ? (
        <div className="space-y-4">
          {result.status === 'issued' && (
            <div className="rounded-xl border border-sage-200 bg-sage-50 p-4">
              <div className="flex items-center gap-2 font-semibold text-sage-800"><CheckCircle2 className="h-5 w-5" /> הקבלה הופקה ב-Morning</div>
              <p className="mt-1 text-sm">קבלה מס' {result.documentNumber} · {result.customerName} · {fmtMoney(result.total)}{result.sendEmail ? ' · נשלחה במייל' : ''}</p>
              {result.pdfUrl && <a className="btn-secondary mt-3 inline-flex px-3 py-1.5" href={result.pdfUrl} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-4 w-4" /> פתיחת הקבלה</a>}
            </div>
          )}
          {result.status === 'uncertain' && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">
              <div className="flex items-center gap-2 font-semibold text-amber-800"><AlertTriangle className="h-5 w-5" /> לא ידוע אם הקבלה נוצרה</div>
              <p className="mt-1">{result.error}</p>
              <button className="btn-secondary mt-3 px-3 py-1.5" onClick={reconcile} disabled={!!busy}>{busy === 'reconcile' ? <Spinner /> : <RotateCcw className="h-4 w-4" />} בדיקה ב-Morning</button>
            </div>
          )}
          {result.status === 'failed' && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm">
              <div className="flex items-center gap-2 font-semibold text-red-800"><AlertTriangle className="h-5 w-5" /> הקבלה לא הופקה</div>
              <p className="mt-1">{result.error}</p>
              <button className="btn-secondary mt-3 px-3 py-1.5" onClick={() => setResult(null)}>חזרה לטופס לתיקון ולניסיון נוסף</button>
            </div>
          )}
          <ErrorNote error={error} />
          <div className="flex gap-2">
            <button className="btn-primary" onClick={reset}><Plus className="h-4 w-4" /> הזמנה חדשה נוספת</button>
            <button className="btn-ghost" onClick={close}>סגירה</button>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h4 className="font-semibold">1. לקוח</h4>
              <div className="flex rounded-xl border border-charcoal-200 p-0.5 text-sm">
                {[['new', 'לקוח חדש'], ['existing', 'לקוח קיים']].map(([id, label]) => (
                  <button key={id} type="button" onClick={() => setMode(id)} className={`rounded-lg px-3 py-1 ${mode === id ? 'bg-sage-600 text-white' : 'text-charcoal-600'}`}>{label}</button>
                ))}
              </div>
            </div>
            {mode === 'existing' ? <CustomerPicker value={picked} onChange={setPicked} /> : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="שם מלא *"><input className="input" value={nc.name} onChange={(e) => setNc({ ...nc, name: e.target.value })} /></Field>
                <Field label="נייד"><input className="input" dir="ltr" inputMode="tel" value={nc.mobile} onChange={(e) => setNc({ ...nc, mobile: e.target.value })} placeholder="050-0000000" /></Field>
                <Field label="מייל"><input className="input" dir="ltr" type="email" value={nc.email} onChange={(e) => setNc({ ...nc, email: e.target.value })} /></Field>
                <Field label="כתובת"><input className="input" value={nc.address} onChange={(e) => setNc({ ...nc, address: e.target.value })} /></Field>
                <Field label="עיר"><input className="input" value={nc.city} onChange={(e) => setNc({ ...nc, city: e.target.value })} /></Field>
                <Field label="ח.פ / ת.ז"><input className="input" dir="ltr" inputMode="numeric" value={nc.taxId} onChange={(e) => setNc({ ...nc, taxId: e.target.value })} /></Field>
                <div className="sm:col-span-2 lg:col-span-3"><Field label="הערות ללקוח (פנימי)"><input className="input" value={nc.remarks} onChange={(e) => setNc({ ...nc, remarks: e.target.value })} /></Field></div>
                <p className="text-xs text-charcoal-500 sm:col-span-2 lg:col-span-3">הלקוח ייווצר ככרטיס לקוח ב-Morning, כך שהקבלות הבאות שלו יזוהו בוודאות.</p>
              </div>
            )}
          </section>

          <section>
            <h4 className="mb-2 font-semibold">2. הזמנה</h4>
            <div className="space-y-2">
              {lines.map((l) => (
                <div key={l.key} className="grid grid-cols-12 items-end gap-2">
                  <div className="col-span-12 sm:col-span-4">
                    <Field label="מוצר">
                      <select className="input" value={l.itemId} onChange={(e) => pickItem(l.key, e.target.value)}>
                        <option value="">מוצר אחר (תיאור חופשי)</option>
                        {catalog.map((i) => <option key={i.id} value={i.id}>{i.name} · {fmtMoney(i.price)}</option>)}
                      </select>
                    </Field>
                  </div>
                  <div className="col-span-12 sm:col-span-4"><Field label="תיאור בקבלה"><input className="input" value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} /></Field></div>
                  <div className="col-span-4 sm:col-span-1"><Field label="כמות"><input className="input" inputMode="decimal" value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} /></Field></div>
                  <div className="col-span-5 sm:col-span-2"><Field label="מחיר ליחידה (₪)"><input className="input" inputMode="decimal" value={l.price} onChange={(e) => setLine(l.key, { price: e.target.value })} /></Field></div>
                  <div className="col-span-3 sm:col-span-1 pb-1">
                    <button type="button" className="btn-ghost px-2 py-2" onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : ls))} aria-label="הסרת שורה" disabled={lines.length === 1}><Trash2 className="h-4 w-4" /></button>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-2 flex items-center justify-between">
              <button type="button" className="btn-ghost px-2 py-1 text-sm" onClick={() => setLines((ls) => [...ls, emptyLine()])}><Plus className="h-4 w-4" /> הוספת שורה</button>
              <div className="text-lg font-semibold">סה"כ: {fmtMoney(total)}</div>
            </div>
          </section>

          <section>
            <h4 className="mb-2 font-semibold">3. תשלום</h4>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="אמצעי תשלום">
                <select className="input" value={pay.option} onChange={(e) => setPay({ ...pay, option: e.target.value })}>
                  {PAYMENT_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
              </Field>
              <Field label="תאריך התשלום"><input className="input" type="date" max={today} value={pay.date} onChange={(e) => setPay({ ...pay, date: e.target.value })} /></Field>
              <Field label="אסמכתה (לא חובה)" hint={option.method === 'bank_transfer' || option.method === 'cash' || option.method === 'card' ? 'לא מודפסת בקבלה באמצעי תשלום זה' : null}>
                <input className="input" dir="ltr" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} />
              </Field>
            </div>
            <p className="mt-1 text-xs text-charcoal-500">סכום התשלום שווה לסכום ההזמנה: {fmtMoney(total)}. לא נשמרים מספרי כרטיס או חשבון בנק.</p>
          </section>

          <section>
            <h4 className="mb-2 font-semibold">4. קבלה</h4>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="תאריך הקבלה"><input className="input" type="date" max={today} value={receipt.date} onChange={(e) => setReceipt({ ...receipt, date: e.target.value })} /></Field>
              <Field label="תיאור (לא חובה)"><input className="input" value={receipt.description} onChange={(e) => setReceipt({ ...receipt, description: e.target.value })} /></Field>
              <Field label="הערות בקבלה (לא חובה)"><input className="input" value={receipt.remarks} onChange={(e) => setReceipt({ ...receipt, remarks: e.target.value })} /></Field>
            </div>
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={receipt.sendEmail} disabled={!customerEmail} onChange={(e) => setReceipt({ ...receipt, sendEmail: e.target.checked })} />
              שליחת הקבלה ללקוח במייל{customerEmail ? <span className="text-charcoal-500" dir="ltr"> ({customerEmail})</span> : <span className="text-charcoal-400"> (אין מייל ללקוח)</span>}
            </label>
          </section>

          {previewUrl && (
            <section>
              <h4 className="mb-2 font-semibold">תצוגה מקדימה (עדיין לא הופקה)</h4>
              <iframe title="תצוגה מקדימה של הקבלה" src={previewUrl} className="h-[480px] w-full rounded-xl border border-charcoal-200 bg-white" />
            </section>
          )}

          <ErrorNote error={error} />

          {confirming ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">
              <p className="font-semibold text-amber-900">להפיק קבלה על {fmtMoney(total)} ל{customerLabel || 'לקוח'}?</p>
              <p className="mt-1 text-amber-900">קבלה היא מסמך חשבונאי: אי אפשר למחוק אותה אחרי ההפקה, רק לבטל אותה במסמך נוסף ב-Morning.{receipt.sendEmail ? ' הקבלה תישלח ללקוח במייל.' : ''}</p>
              <div className="mt-3 flex gap-2">
                <button className="btn-primary" onClick={issue} disabled={!!busy}>{busy === 'issue' ? <Spinner /> : <FileCheck2 className="h-4 w-4" />} כן, להפיק</button>
                <button className="btn-ghost" onClick={() => setConfirming(false)} disabled={!!busy}>ביטול</button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button className="btn-secondary" onClick={preview} disabled={!canSubmit || !!busy}>{busy === 'preview' ? <Spinner /> : <Eye className="h-4 w-4" />} תצוגה מקדימה</button>
              <button className="btn-primary" onClick={() => { setError(null); setConfirming(true); }} disabled={!canSubmit || !!busy}><FileCheck2 className="h-4 w-4" /> הפקת קבלה</button>
              <button className="btn-ghost" onClick={close} disabled={!!busy}>ביטול</button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
