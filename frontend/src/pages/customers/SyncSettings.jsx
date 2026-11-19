// "סנכרון והגדרות": connection to the accounting provider, customer sync, feature flags and change history.
import { useCallback, useEffect, useState } from 'react';
import { PlugZap, Pencil, Trash2, CheckCircle2, XCircle, CircleDashed, History, Plus, RefreshCw, Users, ToggleRight } from 'lucide-react';
import { api } from '../../api.js';
import { fmtDateTime } from '../../constants.js';
import { Card, Empty, ErrorNote, Notice, Spinner } from '../../components/ui.jsx';

const STATUS = {
  ok: { label: 'מחובר', icon: CheckCircle2, cls: 'text-sage-700' },
  error: { label: 'שגיאה', icon: XCircle, cls: 'text-red-600' },
  unchecked: { label: 'לא נבדק', icon: CircleDashed, cls: 'text-charcoal-500' },
};

const ACTION_LABEL = {
  'connection.created': 'נוצר חיבור',
  'connection.updated': 'החיבור עודכן',
  'connection.deleted': 'החיבור נמחק',
  'customer.created': 'לקוח חדש',
  'customer.updated': 'פרטי לקוח עודכנו',
  'customer.deactivated': 'לקוח סומן כלא פעיל',
  'customer.reactivated': 'לקוח חזר להיות פעיל',
  'customer.identity_linked': 'רשומה צורפה ללקוח קיים (לפי טלפון)',
  'customer.removed_in_source': 'לקוח הוסר ב-Morning',
  'customer.restored_in_source': 'לקוח חזר ב-Morning',
  'flag.changed': 'מתג שונה',
};

const SOURCE_LABEL = { manual: 'ידני', polling: 'סנכרון תקופתי', system: 'מערכת', webhook: 'Webhook', replay: 'הרצה חוזרת' };

const RUN_STATUS = {
  running: { label: 'רץ עכשיו', cls: 'text-sky-700' },
  completed: { label: 'הושלם', cls: 'text-sage-700' },
  failed: { label: 'נכשל', cls: 'text-red-600' },
  cancelled: { label: 'בוטל', cls: 'text-amber-700' },
};

const SYNC_INTERVALS = [{ value: 15, label: 'כל 15 דקות' }, { value: 60, label: 'כל שעה' }, { value: 360, label: 'כל 6 שעות' }];

export default function SyncSettings() {
  const [providers, setProviders] = useState(null);
  const [connections, setConnections] = useState(null);
  const [editing, setEditing] = useState(null); // null | 'new' | connection
  const [error, setError] = useState(null);
  const [auditKey, setAuditKey] = useState(0);

  const load = useCallback(async () => {
    try {
      const [p, c] = await Promise.all([api.get('/accounting/providers'), api.get('/accounting/connections')]);
      setProviders(p);
      setConnections(c);
      setAuditKey((k) => k + 1);
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const refreshAudit = useCallback(() => setAuditKey((k) => k + 1), []);

  if (!providers || !connections) {
    return error ? <ErrorNote error={error} /> : <div className="grid h-40 place-items-center"><Spinner className="h-6 w-6 text-sage-500" /></div>;
  }

  return (
    <div className="space-y-6">
      <ErrorNote error={error} />
      <Card
        title={<span className="flex items-center gap-2"><PlugZap className="h-4 w-4 text-sage-500" /> חיבור למערכת הנהלת החשבונות</span>}
        action={!editing && <button className="btn-secondary px-3 py-1.5" onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> חיבור חדש</button>}
      >
        {editing ? (
          <ConnectionForm
            providers={providers}
            connection={editing === 'new' ? null : editing}
            onCancel={() => setEditing(null)}
            onSaved={async () => { setEditing(null); await load(); }}
          />
        ) : connections.length ? (
          <ul className="space-y-4">
            {connections.map((c) => <ConnectionRow key={c.id} connection={c} onEdit={() => setEditing(c)} onChanged={load} onSynced={refreshAudit} />)}
          </ul>
        ) : (
          <Empty icon={PlugZap} title="אין עדיין חיבור">לחצו "חיבור חדש" והזינו את פרטי ה-API מ-Morning</Empty>
        )}
      </Card>
      <FlagsCard onChanged={refreshAudit} />
      <ChangeHistory refreshKey={auditKey} />
    </div>
  );
}

function ConnectionRow({ connection: c, onEdit, onChanged, onSynced }) {
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const status = STATUS[c.status] ?? STATUS.unchecked;
  const StatusIcon = status.icon;

  const run = async (kind, fn) => {
    setBusy(kind); setError(null); setResult(null);
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(null); }
  };
  const test = () => run('test', async () => {
    const r = await api.post(`/accounting/connections/${c.id}/test`);
    setResult(r.ok ? { ok: true, text: r.details } : { ok: false, text: r.error });
    await onChanged();
  });
  const toggle = () => run('toggle', async () => { await api.put(`/accounting/connections/${c.id}`, { enabled: !c.enabled }); await onChanged(); });
  const remove = () => {
    if (!confirm(`למחוק את החיבור "${c.label}"? פרטי ההתחברות יימחקו מהמערכת.`)) return;
    run('delete', async () => { await api.del(`/accounting/connections/${c.id}`); await onChanged(); });
  };

  return (
    <li className="rounded-xl border border-charcoal-100 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{c.label}</span>
            <span className="chip bg-charcoal-50 text-charcoal-600">{c.providerLabel}</span>
            <span className="chip bg-charcoal-50 text-charcoal-600">{c.environment === 'sandbox' ? 'סביבת בדיקות' : 'סביבה אמיתית'}</span>
            {!c.enabled && <span className="chip bg-amber-50 text-amber-700">מושבת</span>}
          </div>
          <div className={`mt-1.5 flex items-center gap-1.5 text-sm ${status.cls}`}>
            <StatusIcon className="h-4 w-4" /> {status.label}
            {c.lastCheckAt && <span className="text-xs text-charcoal-400">· נבדק {fmtDateTime(c.lastCheckAt)}</span>}
          </div>
          {c.status === 'error' && c.lastError && <p className="mt-1 text-sm text-red-600">{c.lastError}</p>}
          <p className="mt-1 text-xs text-charcoal-400" dir="auto">
            {Object.entries(c.credentials).map(([k, v]) => `${k}: ${v.set ? v.hint ?? 'שמור' : 'חסר'}`).join(' · ')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-primary px-3 py-1.5" onClick={test} disabled={!!busy || !c.enabled}>{busy === 'test' ? <Spinner /> : <PlugZap className="h-4 w-4" />} בדוק חיבור</button>
          <button className="btn-secondary px-3 py-1.5" onClick={onEdit} disabled={!!busy}><Pencil className="h-4 w-4" /> עריכה</button>
          <button className="btn-ghost px-3 py-1.5" onClick={toggle} disabled={!!busy}>{c.enabled ? 'השבת' : 'הפעל'}</button>
          <button className="btn-danger px-2 py-1.5" onClick={remove} disabled={!!busy} aria-label="מחיקה"><Trash2 className="h-4 w-4" /></button>
        </div>
      </div>
      {result && (result.ok
        ? <div className="mt-3 rounded-xl border border-sage-200 bg-sage-50 px-3 py-2 text-sm text-sage-800">{result.text}</div>
        : <div className="mt-3"><ErrorNote error={result.text} /></div>)}
      {error && <div className="mt-3"><ErrorNote error={error} /></div>}
      <CustomerSync connection={c} onChanged={onChanged} onSynced={onSynced} />
    </li>
  );
}

function ConnectionForm({ providers, connection, onCancel, onSaved }) {
  const isNew = !connection;
  const [providerId, setProviderId] = useState(connection?.provider ?? providers[0]?.id);
  const provider = providers.find((p) => p.id === providerId);
  const [form, setForm] = useState({
    label: connection?.label ?? '',
    environment: connection?.environment ?? Object.keys(provider?.environments ?? {})[0],
    credentials: {},
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const setCred = (key) => (e) => setForm({ ...form, credentials: { ...form.credentials, [key]: e.target.value } });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const body = { label: form.label, environment: form.environment, credentials: form.credentials };
      const saved = isNew
        ? await api.post('/accounting/connections', { provider: providerId, ...body })
        : await api.put(`/accounting/connections/${connection.id}`, body);
      await api.post(`/accounting/connections/${saved.id}/test`); // check right away; the result shows on the connection
      await onSaved();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label className="label">ספק</label>
          <select className="input" value={providerId} onChange={(e) => setProviderId(e.target.value)} disabled={!isNew}>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </div>
        <div>
          <label className="label">סביבה</label>
          <select className="input" value={form.environment} onChange={(e) => setForm({ ...form, environment: e.target.value })}>
            {Object.entries(provider?.environments ?? {}).map(([id, env]) => <option key={id} value={id}>{env.label}</option>)}
          </select>
        </div>
        <div>
          <label className="label">שם לחיבור (לא חובה)</label>
          <input className="input" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder={provider?.label} />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {provider?.credentialFields.map((f) => (
          <div key={f.key}>
            <label className="label">{f.label}</label>
            <input
              className="input"
              dir="ltr"
              type={f.secret ? 'password' : 'text'}
              autoComplete="off"
              required={isNew}
              value={form.credentials[f.key] ?? ''}
              onChange={setCred(f.key)}
              placeholder={isNew ? f.placeholder : 'השאירו ריק כדי לא לשנות'}
            />
          </div>
        ))}
      </div>
      <Notice>
        את המפתחות יוצרים ב-Morning, תחת הגדרות ← כלי מפתחים ← API. הם נשמרים מוצפנים במחשב הזה, ולא מוצגים שוב אחרי השמירה.
      </Notice>
      <ErrorNote error={error} />
      <div className="flex gap-2">
        <button className="btn-primary" disabled={busy}>{busy ? <Spinner /> : null} שמור ובדוק חיבור</button>
        <button type="button" className="btn-ghost" onClick={onCancel} disabled={busy}>ביטול</button>
      </div>
    </form>
  );
}

function ChangeHistory({ refreshKey }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    api.get('/accounting/audit?pageSize=20').then(setData).catch(() => setData({ items: [] }));
  }, [refreshKey]);
  if (!data) return null;
  return (
    <Card title={<span className="flex items-center gap-2"><History className="h-4 w-4 text-sage-500" /> יומן שינויים</span>} bodyClass="">
      {data.items.length ? (
        <ul className="divide-y divide-charcoal-100">
          {data.items.map((a) => (
            <li key={a.id} className="px-5 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{ACTION_LABEL[a.action] ?? a.action}</span>
                {(a.after?.name ?? a.before?.name) && <span className="text-charcoal-600" dir="auto">{a.after?.name ?? a.before?.name}</span>}
                <span className="text-xs text-charcoal-400">{fmtDateTime(a.at)} · {SOURCE_LABEL[a.source] ?? a.source}</span>
              </div>
              {a.before && a.changes.length > 0 && (
                <p className="mt-0.5 text-xs text-charcoal-500" dir="auto">{a.changes.map((ch) => ch.field).join(', ')}</p>
              )}
            </li>
          ))}
        </ul>
      ) : <Empty icon={History} title="אין עדיין שינויים" />}
    </Card>
  );
}

const WAIT_FOR_RUN_MS = 60_000; // a requested sync that never starts a run (e.g. one was already running)

function CustomerSync({ connection: c, onChanged, onSynced }) {
  const [data, setData] = useState(null);
  const [requested, setRequested] = useState(null); // { at, lastRunId } until the new run shows up
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get(`/accounting/sync-runs?connectionId=${c.id}&pageSize=1`);
      setData(r);
      return r.items[0] ?? null;
    } catch (e) { setError(e.message); return null; }
  }, [c.id]);
  useEffect(() => { load(); }, [load]);

  const run = data?.items[0];
  const running = run?.status === 'running';
  const busy = !!requested || running;

  useEffect(() => {
    if (!busy) return undefined;
    const t = setInterval(async () => {
      const latest = await load();
      if (requested && ((latest && latest.id !== requested.lastRunId) || Date.now() - requested.at > WAIT_FOR_RUN_MS)) setRequested(null);
    }, 2000);
    return () => clearInterval(t);
  }, [busy, requested, load]);

  // When a run ends, the change history has new entries.
  const [wasRunning, setWasRunning] = useState(false);
  useEffect(() => {
    if (wasRunning && !running) onSynced();
    setWasRunning(running);
  }, [running, wasRunning, onSynced]);

  const syncNow = async () => {
    setError(null);
    try {
      await api.post(`/accounting/connections/${c.id}/sync`);
      setRequested({ at: Date.now(), lastRunId: run?.id ?? null });
    } catch (e) { setError(e.message); }
  };
  const changeInterval = async (e) => {
    setError(null);
    try {
      await api.put(`/accounting/connections/${c.id}`, { settings: { customerSyncMinutes: Number(e.target.value) } });
      await onChanged();
    } catch (err) { setError(err.message); }
  };

  const status = RUN_STATUS[run?.status];
  return (
    <div className="mt-4 border-t border-charcoal-100 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Users className="h-4 w-4 text-sage-500" /> סנכרון לקוחות
          {data && <span className="chip bg-charcoal-50 text-charcoal-600">{data.knownCustomers.toLocaleString('he-IL')} לקוחות</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select className="input w-auto py-1.5 text-sm" value={c.settings.customerSyncMinutes ?? 60} onChange={changeInterval} aria-label="תדירות הסנכרון">
            {SYNC_INTERVALS.map((i) => <option key={i.value} value={i.value}>{i.label}</option>)}
          </select>
          <button className="btn-secondary px-3 py-1.5" onClick={syncNow} disabled={busy || !c.enabled}>
            {busy ? <Spinner /> : <RefreshCw className="h-4 w-4" />} {busy ? 'מסנכרן…' : 'סנכרן עכשיו'}
          </button>
        </div>
      </div>
      {run ? (
        <div className="mt-2 text-sm">
          <span className={status?.cls}>{status?.label ?? run.status}</span>
          <span className="text-xs text-charcoal-400"> · {fmtDateTime(run.started_at)} · {SOURCE_LABEL[run.source] ?? run.source}</span>
          <p className="mt-0.5 text-xs text-charcoal-500">
            נקראו {run.fetched} · נוספו {run.added} · עודכנו {run.updated} · ללא שינוי {run.unchanged}
            {run.removed > 0 && <> · הוסרו ב-Morning {run.removed}</>}
            {run.failed > 0 && <span className="text-red-600"> · לא נשמרו {run.failed}</span>}
          </p>
          {run.error && <p className={`mt-1 text-xs ${run.status === 'completed' ? 'text-amber-700' : 'text-red-600'}`}>{run.error}</p>}
        </div>
      ) : data && (
        <p className="mt-2 text-xs text-charcoal-500">עדיין לא בוצע סנכרון. הסנכרון הראשון מתחיל לבד אחרי בדיקת חיבור מוצלחת, או בלחיצה על "סנכרן עכשיו".</p>
      )}
      {error && <div className="mt-2"><ErrorNote error={error} /></div>}
    </div>
  );
}

function FlagsCard({ onChanged }) {
  const [flags, setFlags] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => api.get('/accounting/flags').then(setFlags).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  if (!flags) return error ? <ErrorNote error={error} /> : null;

  const toggle = async (f) => {
    setError(null);
    try {
      await api.put(`/accounting/flags/${f.key}`, { enabled: !f.enabled });
      await load();
      onChanged();
    } catch (e) { setError(e.message); }
  };
  return (
    <Card title={<span className="flex items-center gap-2"><ToggleRight className="h-4 w-4 text-sage-500" /> מתגים</span>}>
      <ul className="space-y-2">
        {flags.map((f) => (
          <li key={f.key} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>
              {f.label}
              {!f.enabled && <span className="chip mr-2 bg-amber-50 text-amber-700">כבוי</span>}
              {f.lockedByEnv && <span className="mr-2 text-xs text-charcoal-400">נעול בקובץ ההגדרות ({f.envName})</span>}
            </span>
            <button className={f.enabled ? 'btn-ghost px-3 py-1' : 'btn-secondary px-3 py-1'} onClick={() => toggle(f)} disabled={f.lockedByEnv}>
              {f.enabled ? 'כבה' : 'הדלק'}
            </button>
          </li>
        ))}
      </ul>
      <ErrorNote error={error} />
    </Card>
  );
}
