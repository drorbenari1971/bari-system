import { useEffect, useMemo, useState } from 'react';
import { Users, RefreshCw, ExternalLink, ChevronDown, ChevronUp, Search, Flame, MessageSquareDashed, Handshake, Clock, X, Plus } from 'lucide-react';
import { api, STATIC_DEMO } from '../api.js';
import { fmtNum, fmtDateTime } from '../constants.js';
import { Card, Empty, ErrorNote, Notice, Spinner, StatCard } from '../components/ui.jsx';

// Chip colors follow the meaning of each value in Airtable (priority 1 = high, closed deal = done, etc.).
const PRIORITY_CLS = { 1: 'bg-red-50 text-red-700', 2: 'bg-amber-50 text-amber-700', 3: 'bg-charcoal-50 text-charcoal-600' };
const STATUS_CLS = {
  'לא נוצר קשר': 'bg-charcoal-50 text-charcoal-600',
  'נשלחה הודעה': 'bg-sky-50 text-sky-700',
  'בשיחה': 'bg-amber-50 text-amber-700',
  'סגור – עסקה': 'bg-sage-100 text-sage-800',
  'לא מעוניין': 'bg-red-50 text-red-700',
};
const priorityLevel = (p) => Number(String(p).trim()[0]) || null;
const PLATFORMS = ['אינסטגרם', 'פייסבוק'];
const PLATFORM_CLS = { 'אינסטגרם': 'bg-gradient-to-l from-fuchsia-100 to-amber-100 text-fuchsia-800', 'פייסבוק': 'bg-blue-50 text-blue-700' };
const platformsOf = (l) => (l.platforms ? l.platforms.split(',') : []);
// Instagram accounts are named by handle; Facebook-only ones by page or profile name.
const isInstagram = (l) => platformsOf(l).includes('אינסטגרם') || (!l.platforms && !l.facebook_url);
const mainLink = (l) => (isInstagram(l) ? l.profile_url || `https://www.instagram.com/${l.handle}/` : l.facebook_url || l.profile_url || undefined);
const fmtPostDate = (d) => {
  if (!d) return '';
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString('he-IL', { day: 'numeric', month: 'short', year: 'numeric' });
};

export default function Leads() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [filters, setFilters] = useState({ q: '', platform: '', status: '', priority: '', potential: '', type: '' });
  const [open, setOpen] = useState(() => new Set());

  const load = () => api.get('/leads').then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  // While a collection runs (a few minutes), refresh every 10 seconds to show its result.
  const collecting = !!data?.collection?.running;
  useEffect(() => {
    if (!collecting) return undefined;
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [collecting]);

  const sync = async () => {
    setSyncing(true); setError(null); setNote(null);
    try {
      const r = await api.post('/leads/sync');
      if (r.skipped) setNote(`לא בוצע סנכרון: ${r.reason}`);
      else if (!r.ok) setError(`הסנכרון נכשל: ${r.error}`);
      else setNote(`סונכרנו ${r.accounts} חשבונות ו-${r.posts} פוסטים מ-Airtable${r.pushed ? `, ו-${r.pushed} שינויי סטטוס נשמרו שם` : ''}.`);
      await load();
    } catch (e) { setError(e.message); } finally { setSyncing(false); }
  };

  const setStatus = async (lead, status) => {
    setError(null); setNote(null);
    try {
      const r = await api.put(`/leads/${lead.airtable_id}/status`, { status });
      setData((d) => ({ ...d, leads: d.leads.map((l) => (l.airtable_id === lead.airtable_id ? { ...l, ...r.lead } : l)) }));
      if (r.warning) setNote(r.warning);
    } catch (e) { setError(e.message); }
  };

  // Sets or clears (empty value) a lead's priority, potential or actor type, here and in Airtable.
  const setField = async (lead, field, value) => {
    setError(null); setNote(null);
    try {
      const r = await api.put(`/leads/${lead.airtable_id}/${field}`, { value });
      setData((d) => ({ ...d, leads: d.leads.map((l) => (l.airtable_id === lead.airtable_id ? { ...l, ...r.lead } : l)) }));
    } catch (e) { setError(e.message); }
  };

  const leads = data?.leads ?? [];
  const options = useMemo(() => {
    const uniq = (key) => [...new Set(leads.map((l) => l[key]).filter(Boolean))].sort();
    return { priority: uniq('priority'), potential: uniq('potential'), type: uniq('actor_type') };
  }, [leads]);

  const shown = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    return leads.filter((l) => (!filters.platform || platformsOf(l).includes(filters.platform))
      && (!filters.status || l.status === filters.status)
      && (!filters.priority || l.priority === filters.priority)
      && (!filters.potential || l.potential === filters.potential)
      && (!filters.type || l.actor_type === filters.type)
      && (!q || [l.handle, l.display_name, l.notes, l.approach, l.phone, l.email].some((v) => (v ?? '').toLowerCase().includes(q))));
  }, [leads, filters]);

  const count = (fn) => leads.filter(fn).length;
  const toggle = (id) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const setFilter = (key) => (e) => setFilters({ ...filters, [key]: e.target.value });

  if (!data && !error) return <div className="grid h-64 place-items-center"><Spinner className="h-6 w-6 text-sage-500" /></div>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="page-title">לידים מהרשתות</h1>
          <p className="page-sub">חשבונות מאינסטגרם ומפייסבוק שפרסמו על ציר עצמות, גהי וטאלו. הנתונים נאספים ב-Apify ומסונכרנים מ-Airtable.</p>
        </div>
        <div className="flex items-center gap-3">
          {data?.syncedAt && <span className="flex items-center gap-1 text-xs text-charcoal-400"><Clock className="h-3.5 w-3.5" /> סונכרן {fmtDateTime(data.syncedAt)}</span>}
          <button className="btn-secondary" onClick={sync} disabled={syncing || STATIC_DEMO}>
            {syncing ? <Spinner /> : <RefreshCw className="h-4 w-4" />} סנכרן עכשיו
          </button>
        </div>
      </div>

      <ErrorNote error={error} />
      {note && <Notice>{note}</Notice>}
      {data && !data.configured && !STATIC_DEMO && (
        <Notice>
          <div className="mb-1 font-medium">Airtable עוד לא מחובר. כדי לחבר אותו:</div>
          <ol className="list-inside list-decimal space-y-0.5">
            <li>צרו מפתח גישה בכתובת <Code>airtable.com/create/tokens</Code></li>
            <li>תנו לו את ההרשאות <Code>data.records:read</Code> ו-<Code>data.records:write</Code>, וגישה רק לבסיס של הלידים</li>
            <li>הדביקו אותו בשורה <Code>AIRTABLE_TOKEN</Code> בקובץ <Code>backend\.env</Code>, והפעילו מחדש את <Code>start.bat</Code></li>
          </ol>
        </Notice>
      )}
      {data?.syncError && <ErrorNote error={`הסנכרון האחרון נכשל: ${data.syncError}`} />}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={Users} label="לידים" value={fmtNum(leads.length)} />
        <StatCard icon={MessageSquareDashed} label="עוד לא נוצר קשר" value={fmtNum(count((l) => l.status === 'לא נוצר קשר'))} tone="charcoal" />
        <StatCard icon={Flame} label="עדיפות גבוהה" value={fmtNum(count((l) => priorityLevel(l.priority) === 1))} tone="honey" />
        <StatCard icon={Handshake} label="בשיחה או עסקה" value={fmtNum(count((l) => ['בשיחה', 'סגור – עסקה'].includes(l.status)))} tone="sky" />
      </div>

      <Collection info={data?.collection} onStarted={load} />

      <SearchTerms onSaved={load} />

      <div className="card flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-[200px] flex-1">
          <label className="label">חיפוש</label>
          <div className="relative">
            <Search className="pointer-events-none absolute right-3 top-2.5 h-4 w-4 text-charcoal-400" />
            <input className="input pr-9" placeholder="שם חשבון, שם, טלפון או מילה מההערות" value={filters.q} onChange={setFilter('q')} />
          </div>
        </div>
        <FilterSelect label="פלטפורמה" value={filters.platform} onChange={setFilter('platform')} options={PLATFORMS} />
        <FilterSelect label="סטטוס פנייה" value={filters.status} onChange={setFilter('status')} options={data?.statuses ?? []} />
        <FilterSelect label="עדיפות" value={filters.priority} onChange={setFilter('priority')} options={options.priority} />
        <FilterSelect label="פוטנציאל" value={filters.potential} onChange={setFilter('potential')} options={options.potential} />
        <FilterSelect label="סוג שחקן" value={filters.type} onChange={setFilter('type')} options={options.type} />
      </div>

      <Card title={`${fmtNum(shown.length)} לידים`} bodyClass="">
        {shown.length ? (
          <ul className="divide-y divide-charcoal-100">
            {shown.map((l) => (
              <li key={l.airtable_id} className="space-y-3 px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <a href={mainLink(l)} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 font-semibold text-charcoal-900 hover:text-sage-700" dir="auto">
                        {isInstagram(l) ? `@${l.handle}` : l.handle} <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                      {l.display_name && <span className="text-sm text-charcoal-500">{l.display_name}</span>}
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {platformsOf(l).map((p) => <span key={p} className={`chip ${PLATFORM_CLS[p] ?? 'bg-charcoal-50 text-charcoal-600'}`}>{p}</span>)}
                      <ChoiceChip lead={l} field="priority" label="עדיפות" cls={l.priority ? PRIORITY_CLS[priorityLevel(l.priority)] ?? PRIORITY_CLS[3] : ''} options={data?.choices?.priority} onChange={setField} />
                      <ChoiceChip lead={l} field="potential" label="פוטנציאל" cls="bg-sage-50 text-sage-800" options={data?.choices?.potential} onChange={setField} />
                      <ChoiceChip lead={l} field="actor_type" label="סוג שחקן" cls="bg-charcoal-50 text-charcoal-600" options={data?.choices?.actor_type} onChange={setField} />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <select
                      className={`chip cursor-pointer border-0 py-1 text-sm ${STATUS_CLS[l.status] ?? STATUS_CLS['לא נוצר קשר']}`}
                      value={l.status}
                      onChange={(e) => setStatus(l, e.target.value)}
                      aria-label={`סטטוס פנייה של ${l.handle}`}
                    >
                      {!l.status && <option value="">ללא סטטוס</option>}
                      {(data?.statuses ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                    {l.status_pending && <span className="text-xs text-amber-700" title="השינוי יישלח ל-Airtable בסנכרון הבא">ממתין לשמירה ב-Airtable</span>}
                  </div>
                </div>

                <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-charcoal-500">
                  <span>{fmtNum(l.post_count)} פוסטים</span>
                  <span>{fmtNum(l.total_likes)} לייקים</span>
                  <span>מעורבות ממוצעת לפוסט: {fmtNum(l.avg_engagement)}</span>
                  {isInstagram(l) && l.facebook_url && (
                    <a href={l.facebook_url} target="_blank" rel="noopener noreferrer" className="text-sage-700 hover:underline">גם בפייסבוק ↗</a>
                  )}
                  {l.phone && <a href={`tel:${l.phone.replace(/[^\d+]/g, '')}`} dir="ltr" className="text-sage-700 hover:underline">{l.phone}</a>}
                  {l.email && <a href={`mailto:${l.email}`} dir="ltr" className="text-sage-700 hover:underline">{l.email}</a>}
                </div>

                {l.approach && (
                  <div className="rounded-xl bg-sage-50/60 px-3 py-2 text-sm text-charcoal-700">
                    <span className="font-medium text-sage-800">איך לפנות: </span>{l.approach}
                  </div>
                )}
                {l.notes && <p className="text-sm text-charcoal-500">{l.notes}</p>}

                {l.posts.length > 0 && (
                  <div>
                    <button className="flex items-center gap-1 text-xs font-medium text-sage-700 hover:underline" onClick={() => toggle(l.airtable_id)}>
                      {open.has(l.airtable_id) ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                      {open.has(l.airtable_id) ? 'הסתר פוסטים' : l.posts.length === 1 ? 'הצג את הפוסט' : `הצג ${l.posts.length} פוסטים`}
                    </button>
                    {open.has(l.airtable_id) && (
                      <ul className="mt-2 space-y-1.5">
                        {l.posts.map((p) => (
                          <li key={p.airtable_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-charcoal-100 px-3 py-2 text-sm">
                            <span className="min-w-0 flex-1 font-medium">{p.summary}</span>
                            {p.platform && <span className="text-xs text-charcoal-500">{p.platform}</span>}
                            {p.hashtag && <span className="text-xs text-sage-700">{p.hashtag}</span>}
                            {p.content_type && <span className="text-xs text-charcoal-500">{p.content_type}</span>}
                            <span className="text-xs text-charcoal-400">{fmtPostDate(p.date)}</span>
                            <span className="text-xs text-charcoal-500">{fmtNum(p.likes)} לייקים · {fmtNum(p.comments)} תגובות</span>
                            {p.url && (
                              <a href={p.url} target="_blank" rel="noopener noreferrer" className="text-xs text-sage-700 hover:underline">לפוסט ↗</a>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Empty icon={Users} title={leads.length ? 'אין לידים שמתאימים לסינון' : 'אין עדיין לידים'}>
            {leads.length ? 'נסו לנקות חלק מהסינונים' : 'אחרי החיבור ל-Airtable, לחצו "סנכרן עכשיו"'}
          </Empty>
        )}
      </Card>
    </div>
  );
}

// Automatic collection: Apify -> Airtable -> this screen, every 6 hours, or now on request.
function Collection({ info, onStarted }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  if (!info || STATIC_DEMO) return null;
  const last = info.last;

  const start = async () => {
    if (!confirm(`להריץ עכשיו איסוף ב-Apify לפי מילות החיפוש? עלות משוערת: כ-$${info.estimateUsd}. החשבונות והפוסטים החדשים ייכתבו ל-Airtable.`)) return;
    setBusy(true); setErr(null);
    try { await api.post('/leads/collect'); await onStarted(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <Card
      title={<span className="flex items-center gap-2"><RefreshCw className="h-4 w-4 text-sage-500" /> איסוף אוטומטי מ-Apify</span>}
      action={(
        <button className="btn-primary px-3 py-1.5" onClick={start} disabled={!info.configured || info.running || busy}>
          {info.running || busy ? <Spinner /> : null} {info.running ? 'אוסף…' : 'אסוף עכשיו'}
        </button>
      )}
    >
      {!info.configured ? (
        <p className="text-sm text-charcoal-600">
          לא פעיל: חסר מפתח Apify. הדביקו אותו בשורה <Code>APIFY_TOKEN</Code> בקובץ <Code>backend\.env</Code> והפעילו מחדש את <Code>start.bat</Code>.
        </p>
      ) : (
        <div className="space-y-2 text-sm text-charcoal-600">
          <p>
            פעיל: כל {info.everyHours} שעות (00:17, 06:17, 12:17, 18:17) כשהשרת פתוח. עלות משוערת לאיסוף: כ-${info.estimateUsd}.
            {info.running && ' האיסוף רץ עכשיו ולוקח כמה דקות.'}
          </p>
          {last && (last.ok ? (
            <p>
              איסוף אחרון: {fmtDateTime(last.finishedAt)} · <b>{last.newAccounts}</b> חשבונות חדשים · <b>{last.newPosts}</b> פוסטים חדשים
              · {last.alreadyKnown} כבר היו · עלות ${last.costUsd}
              {last.newAccounts > 0 && last.classified < last.newAccounts && ` · ${last.newAccounts - last.classified} ממתינים לסיווג`}
            </p>
          ) : last.skipped ? null : <span className="text-red-600">האיסוף האחרון נכשל: {last.error}</span>)}
          {last?.errors?.length > 0 && (
            <ul className="list-inside list-disc text-xs text-amber-700">{last.errors.map((e) => <li key={e}>{e}</li>)}</ul>
          )}
        </div>
      )}
      <ErrorNote error={err} />
    </Card>
  );
}

// A classification shown as a chip that opens a list of the Airtable choices; "ללא" clears it.
function ChoiceChip({ lead, field, label, cls, options = [], onChange }) {
  const value = lead[field] ?? '';
  const list = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <select
      className={`chip cursor-pointer border-0 py-0.5 ${value ? cls : 'border border-dashed border-charcoal-200 bg-transparent text-charcoal-400'}`}
      value={value}
      onChange={(e) => onChange(lead, field, e.target.value)}
      aria-label={`${label} של ${lead.handle}`}
      title={`${label} (נשמר גם ב-Airtable)`}
    >
      <option value="">{value ? `ללא ${label}` : `+ ${label}`}</option>
      {list.map((o) => <option key={o} value={o}>{field === 'priority' ? `עדיפות ${o}` : o}</option>)}
    </select>
  );
}

function ClearableChip({ cls, label, onClear }) {
  return (
    <span className={`chip ${cls}`}>
      {label}
      <button onClick={onClear} className="opacity-50 hover:opacity-100" aria-label={`הסר: ${label}`} title="הסר">
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

const TERM_PLATFORMS = [
  { id: 'instagram', label: 'אינסטגרם', hint: 'האשטגים (בלי #)', placeholder: 'למשל: מרק_עצמות' },
  { id: 'facebook', label: 'פייסבוק', hint: 'מילים לחיפוש פוסטים', placeholder: 'למשל: מרק עצמות' },
];

// The words the Apify collection searches for, per platform. Edited here, saved in the local database.
function SearchTerms({ onSaved }) {
  const [terms, setTerms] = useState(null);
  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState({ instagram: '', facebook: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => { api.get('/leads/search-terms').then((t) => { setTerms(t); setSaved(t); }).catch((e) => setErr(e.message)); }, []);
  if (!terms) return null;

  const dirty = JSON.stringify(terms) !== JSON.stringify(saved);
  const add = (platform) => {
    // Same cleanup as the server: no leading '#', and Instagram hashtags have no spaces.
    const words = draft[platform].split(',')
      .map((w) => w.trim().replace(/^#+/, '').trim())
      .map((w) => (platform === 'instagram' ? w.replace(/\s+/g, '_') : w.replace(/\s+/g, ' ')))
      .filter(Boolean);
    if (!words.length) return;
    setTerms({ ...terms, [platform]: [...new Set([...terms[platform], ...words])] });
    setDraft({ ...draft, [platform]: '' });
    setMsg(null);
  };
  const remove = (platform, word) => { setTerms({ ...terms, [platform]: terms[platform].filter((w) => w !== word) }); setMsg(null); };
  const save = async () => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const t = await api.put('/leads/search-terms', terms);
      setTerms(t); setSaved(t); setMsg('נשמר. האיסוף הבא יחפש לפי המילים האלה.');
      onSaved?.(); // the cost estimate depends on the number of words
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <Card
      title={<span className="flex items-center gap-2"><Search className="h-4 w-4 text-sage-500" /> מילות חיפוש</span>}
      action={(
        <div className="flex items-center gap-2">
          {msg && <span className="text-xs text-sage-700">{msg}</span>}
          {dirty && <button className="btn-ghost px-2 py-1 text-xs" onClick={() => { setTerms(saved); setMsg(null); }}>בטל שינויים</button>}
          <button className="btn-primary px-3 py-1.5" onClick={save} disabled={!dirty || busy}>{busy ? <Spinner /> : null} שמור</button>
        </div>
      )}
    >
      <div className="grid gap-5 md:grid-cols-2">
        {TERM_PLATFORMS.map((p) => (
          <div key={p.id}>
            <div className="mb-2 text-sm font-medium text-charcoal-700">{p.label} <span className="font-normal text-charcoal-400">· {p.hint}</span></div>
            <div className="mb-2 flex min-h-[28px] flex-wrap gap-1.5">
              {terms[p.id].map((w) => (
                <ClearableChip key={w} cls="bg-sage-50 text-sage-800" label={p.id === 'instagram' ? `#${w}` : w} onClear={() => remove(p.id, w)} />
              ))}
              {!terms[p.id].length && <span className="text-xs text-charcoal-400">אין מילים: לא יתבצע חיפוש בפלטפורמה הזו</span>}
            </div>
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); add(p.id); }}>
              <input className="input" placeholder={p.placeholder} value={draft[p.id]} onChange={(e) => setDraft({ ...draft, [p.id]: e.target.value })} />
              <button className="btn-secondary" disabled={!draft[p.id].trim()}><Plus className="h-4 w-4" /> הוסף</button>
            </form>
          </div>
        ))}
      </div>
      <ErrorNote error={err} />
      <p className="mt-3 text-xs text-charcoal-400">
        האיסוף האוטומטי מ-Apify מחפש לפי המילים האלה. כל מילה בפייסבוק היא הרצה נפרדת, ולכן כל מילה נוספת מייקרת את האיסוף.
      </p>
    </Card>
  );
}

// Technical text (addresses, setting names) stays left-to-right inside the Hebrew sentence.
const Code = ({ children }) => <code dir="ltr" className="rounded bg-surface/60 px-1 font-mono text-xs">{children}</code>;

function FilterSelect({ label, value, onChange, options }) {
  return (
    <div>
      <label className="label">{label}</label>
      <select className="input w-auto min-w-[140px]" value={value} onChange={onChange}>
        <option value="">הכל</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}
