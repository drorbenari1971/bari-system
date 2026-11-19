// Webhook setup and monitoring for one connection: the address (URL token) and the signing secret
// are separate; the secret is shown once, right after it is created.
import { useCallback, useEffect, useState } from 'react';
import { Zap, Copy, KeyRound, Link2, RotateCcw, AlertTriangle, Info } from 'lucide-react';
import { api } from '../../api.js';
import { fmtDateTime } from '../../constants.js';
import { ErrorNote, Spinner } from '../../components/ui.jsx';

const STATUS = {
  ok: { label: 'פעיל', cls: 'bg-sage-50 text-sage-700' },
  off: { label: 'כבוי', cls: 'bg-charcoal-50 text-charcoal-600' },
  not_configured: { label: 'לא הוגדר', cls: 'bg-charcoal-50 text-charcoal-600' },
  warning: { label: 'אזהרה', cls: 'bg-amber-50 text-amber-700' },
  error: { label: 'תקלה', cls: 'bg-red-50 text-red-700' },
};
const OUTCOME = {
  accepted: 'התקבל', duplicate: 'כפול', ignored: 'לא רלוונטי', unreadable: 'לא קריא', disabled: 'לא עובד', rejected: 'נדחה',
};
const REASON = {
  bad_signature: 'חתימה שגויה', no_secret: 'אין סוד', content_type: 'סוג תוכן', too_large: 'גדול מדי',
  flag_off: 'המתג כבוי', connection_disabled: 'החיבור מושבת',
};
const WARNING_STYLE = { error: 'text-red-700', warning: 'text-amber-700', info: 'text-charcoal-500' };
const REFRESH_MS = 30_000;

const copy = (text) => navigator.clipboard?.writeText(text);

export default function WebhookPanel({ connection: c, refreshKey, onChanged }) {
  const [data, setData] = useState(null);
  const [newSecret, setNewSecret] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => api.get(`/accounting/connections/${c.id}/webhook`).then(setData).catch((e) => setError(e.message)), [c.id]);
  useEffect(() => { load(); }, [load, refreshKey]);
  useEffect(() => {
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const act = async (kind, fn) => {
    setBusy(kind); setError(null);
    try { await fn(); await load(); onChanged(); } catch (e) { setError(e.message); } finally { setBusy(null); }
  };
  const createSecret = (rotate) => {
    if (rotate && !confirm('להחליף את הסוד? עד שתעדכנו את הסוד החדש ב-Morning, כל השליחות יידחו.')) return;
    act('secret', async () => setNewSecret((await api.post(`/accounting/connections/${c.id}/webhook/secret`)).secret));
  };
  const rotateToken = () => {
    if (!confirm('להחליף את הכתובת? הכתובת הישנה תפסיק לעבוד, וצריך להדביק את החדשה ב-Morning.')) return;
    act('token', () => api.post(`/accounting/connections/${c.id}/webhook/token`));
  };
  const replay = (id) => act(`replay-${id}`, () => api.post(`/accounting/webhook-deliveries/${id}/replay`));

  if (!data) return error ? <div className="mt-4"><ErrorNote error={error} /></div> : null;
  const h = data.health;
  const status = STATUS[h.status] ?? STATUS.not_configured;
  const configured = data.secretSet && data.path;

  return (
    <div className="mt-4 border-t border-charcoal-100 pt-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-medium">
          <Zap className="h-4 w-4 text-sage-500" /> Webhook (עדכון מיידי)
          <span className={`chip ${status.cls}`}>{status.label}</span>
        </div>
        {configured ? (
          <div className="flex flex-wrap gap-2">
            <button className="btn-ghost px-3 py-1.5" onClick={() => createSecret(true)} disabled={!!busy}><KeyRound className="h-4 w-4" /> החלף סוד</button>
            <button className="btn-ghost px-3 py-1.5" onClick={rotateToken} disabled={!!busy}><Link2 className="h-4 w-4" /> החלף כתובת</button>
          </div>
        ) : (
          <button className="btn-secondary px-3 py-1.5" onClick={() => createSecret(false)} disabled={!!busy}>
            {busy === 'secret' ? <Spinner /> : <KeyRound className="h-4 w-4" />} צור כתובת וסוד
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-charcoal-500">
        ה-Webhook רק מזרז: כשנוצר לקוח ב-Morning, המערכת מושכת אותו מיד דרך ה-API. הסנכרון התקופתי נשאר מקור האמת וממשיך לרוץ.
      </p>

      {newSecret && (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3">
          <p className="font-medium text-amber-800">הסוד החדש. העתיקו אותו עכשיו: הוא לא יוצג שוב.</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 break-all rounded-lg bg-white px-2 py-1 text-xs" dir="ltr">{newSecret}</code>
            <button className="btn-secondary px-2 py-1" onClick={() => copy(newSecret)} aria-label="העתקת הסוד"><Copy className="h-4 w-4" /></button>
          </div>
          <button className="btn-ghost mt-2 px-2 py-1 text-xs" onClick={() => setNewSecret(null)}>העתקתי, הסתר</button>
        </div>
      )}

      {configured && (
        <div className="mt-3 space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-charcoal-500">כתובת:</span>
            <code className="break-all rounded bg-charcoal-50 px-1.5 py-0.5 text-xs" dir="ltr">{data.url ?? `<WEBHOOK_PUBLIC_URL>${data.path}`}</code>
            {data.url && <button className="btn-ghost px-1.5 py-0.5" onClick={() => copy(data.url)} aria-label="העתקת הכתובת"><Copy className="h-3.5 w-3.5" /></button>}
          </div>
          <p className="text-xs text-charcoal-500">
            סוד: מוגדר{data.secretSetAt && ` (נוצר ${fmtDateTime(data.secretSetAt)})`} · אירועים: {data.topics.join(', ')}
          </p>
          <p className="text-xs text-charcoal-500">
            אירוע אחרון: {h.lastDeliveryAt ? fmtDateTime(h.lastDeliveryAt) : 'עדיין לא התקבל'}
            {' · '}24 שעות: התקבלו {h.last24h.accepted ?? 0}, נדחו {h.last24h.rejected ?? 0}
          </p>
        </div>
      )}

      {h.warnings.length > 0 && (
        <ul className="mt-3 space-y-1">
          {h.warnings.map((w) => (
            <li key={w.code} className={`flex items-start gap-1.5 text-xs ${WARNING_STYLE[w.level]}`}>
              {w.level === 'info' ? <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
              {w.text}
            </li>
          ))}
        </ul>
      )}

      {configured && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-sage-700">איך מגדירים ב-Morning</summary>
          <ol className="mt-2 list-decimal space-y-1 pr-5 text-xs text-charcoal-600">
            <li>מפעילים מנהרה (ngrok או Cloudflare Tunnel) לפורט 4100 במחשב הזה, ושומרים את הכתובת שלה ב-<code dir="ltr">WEBHOOK_PUBLIC_URL</code> בקובץ <code dir="ltr">backend\.env</code>.</li>
            <li>ב-Morning: הגדרות ← כלי מפתחים ← Webhooks ← הוספת Webhook.</li>
            <li>מדביקים את הכתובת שלמעלה, ובוחרים רק את האירוע <code dir="ltr">client/created</code>.</li>
            <li>מדביקים את הסוד בשדה ה-Secret ושומרים.</li>
            <li>כאן, בכרטיס "מתגים", מדליקים את "קבלת אירועים מ-Morning (Webhooks)".</li>
          </ol>
        </details>
      )}

      {data.deliveries.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-sage-700">שליחות אחרונות ({data.deliveries.length})</summary>
          <ul className="mt-2 divide-y divide-charcoal-100 text-xs">
            {data.deliveries.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <span>
                  {fmtDateTime(d.received_at)} · <span dir="ltr">{d.topic ?? '—'}</span> · {OUTCOME[d.outcome] ?? d.outcome}
                  {d.rejection_reason && <span className="text-charcoal-400"> ({REASON[d.rejection_reason] ?? d.rejection_reason})</span>}
                </span>
                {d.outcome === 'accepted' && d.job_id && (
                  <button className="btn-ghost px-2 py-0.5" onClick={() => replay(d.id)} disabled={!!busy}>
                    {busy === `replay-${d.id}` ? <Spinner /> : <RotateCcw className="h-3.5 w-3.5" />} הרץ שוב
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && <div className="mt-2"><ErrorNote error={error} /></div>}
    </div>
  );
}
