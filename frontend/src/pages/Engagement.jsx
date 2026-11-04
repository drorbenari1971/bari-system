import { useEffect, useMemo, useState } from 'react';
import { MessageCircle, RefreshCw, Send, Wand2, CheckCheck } from 'lucide-react';
import { api } from '../api.js';
import { timeAgo, fmtDateTime, productLabel } from '../constants.js';
import { Card, Empty, ErrorNote, Notice, PlatformBadge, Spinner, DemoBadge } from '../components/ui.jsx';

const FILTERS = [
  { id: 'all', label: 'הכל' },
  { id: 'unanswered', label: 'ממתינות למענה' },
  { id: 'facebook', label: 'פייסבוק' },
  { id: 'instagram', label: 'אינסטגרם' },
];

export default function Engagement() {
  const [comments, setComments] = useState([]);
  const [filter, setFilter] = useState('all');
  const [selectedId, setSelectedId] = useState(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  const load = async () => {
    const q = filter === 'unanswered' ? '?filter=unanswered' : ['facebook', 'instagram'].includes(filter) ? `?platform=${filter}` : '';
    try { setComments(await api.get(`/engagement/comments${q}`)); } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, [filter]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const t = setInterval(load, 30_000); return () => clearInterval(t); }); // live refresh

  const selected = useMemo(() => comments.find((c) => c.id === selectedId) ?? null, [comments, selectedId]);

  const open = (c) => {
    setSelectedId(c.id); setReply(''); setNote(null); setError(null);
    if (!c.is_read) api.post(`/engagement/comments/${c.id}/read`).then(load).catch(() => {});
  };

  const run = async (kind, fn) => {
    setBusy(kind); setError(null);
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(null); }
  };

  const sync = () => run('sync', async () => {
    const r = await api.post('/engagement/sync');
    setNote(r.skipped ? `לא בוצע סנכרון: ${r.reason}` : `נמשכו ${r.newComments} תגובות חדשות.`);
    await load();
  });

  const suggest = () => run('suggest', async () => {
    const r = await api.post(`/engagement/comments/${selected.id}/suggest`);
    setReply(r.reply);
  });

  const send = () => run('send', async () => {
    const r = await api.post(`/engagement/comments/${selected.id}/reply`, { message: reply });
    setReply('');
    setNote(r.status === 'simulated' ? 'התגובה נשמרה מקומית (סימולציה – Meta לא מחובר או תגובת דמו).' : 'התגובה נשלחה בהצלחה.');
    await load();
  });

  const unansweredCount = comments.filter((c) => !c.replied).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="page-title">תגובות ומעורבות</h1>
          <p className="page-sub">תיבה מאוחדת לתגובות מפייסבוק ומאינסטגרם – עם מענה ישיר מהמערכת</p>
        </div>
        <button className="btn-secondary" onClick={sync} disabled={!!busy}>
          {busy === 'sync' ? <Spinner /> : <RefreshCw className="h-4 w-4" />} משוך תגובות חדשות
        </button>
      </div>

      <ErrorNote error={error} />
      {note && <Notice>{note}</Notice>}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Card
          bodyClass=""
          title={
            <div className="flex flex-wrap gap-1">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setFilter(f.id)}
                  className={`rounded-lg px-2.5 py-1 text-xs font-medium ${filter === f.id ? 'bg-sage-600 text-white' : 'text-charcoal-500 hover:bg-charcoal-50'}`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          }
          action={<span className="text-xs text-charcoal-400">{unansweredCount} ממתינות</span>}
        >
          {comments.length ? (
            <ul className="scrollbar-thin max-h-[640px] divide-y divide-charcoal-100 overflow-y-auto">
              {comments.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => open(c)}
                    className={`flex w-full gap-3 px-4 py-3 text-right transition ${selectedId === c.id ? 'bg-sage-50' : 'hover:bg-charcoal-50/60'}`}
                  >
                    <div className="relative">
                      <div className="grid h-9 w-9 place-items-center rounded-full bg-sage-100 text-sm font-semibold text-sage-700">{c.author?.[0] ?? '?'}</div>
                      {!c.is_read && <span className="absolute -left-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-honey" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-sm">
                        <span className={`truncate ${c.is_read ? 'font-medium' : 'font-semibold'}`}>{c.author}</span>
                        <PlatformBadge platform={c.platform} />
                        {c.replied && <CheckCheck className="h-3.5 w-3.5 text-sage-500" />}
                        <span className="mr-auto shrink-0 text-xs text-charcoal-400">{timeAgo(c.created_time)}</span>
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-sm text-charcoal-600">{c.message}</p>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          ) : <Empty icon={MessageCircle} title="אין תגובות להצגה" />}
        </Card>

        <Card title="שיחה">
          {selected ? (
            <div className="space-y-5">
              <div className="rounded-xl bg-charcoal-50 p-3 text-xs text-charcoal-500">
                {selected.post_headline
                  ? <>על הפוסט: <span className="font-medium text-charcoal-700">{selected.post_headline}</span>{selected.post_product && ` · ${productLabel(selected.post_product)}`}</>
                  : 'פוסט לא מזוהה במערכת'}
              </div>

              <div className="flex gap-3">
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-sage-100 font-semibold text-sage-700">{selected.author?.[0]}</div>
                <div className="flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-semibold">{selected.author}</span>
                    <PlatformBadge platform={selected.platform} />
                    <DemoBadge show={selected.is_demo} />
                    <span className="text-xs text-charcoal-400">{fmtDateTime(selected.created_time)}</span>
                  </div>
                  <div className="mt-1.5 inline-block rounded-2xl rounded-tr-sm bg-charcoal-50 px-4 py-2.5 text-[15px]">{selected.message}</div>
                </div>
              </div>

              {selected.replies.map((r) => (
                <div key={r.id} className="flex flex-row-reverse gap-3">
                  <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-sage-600 text-xs font-bold text-white">ב</div>
                  <div className="text-left">
                    <div dir="rtl" className="inline-block rounded-2xl rounded-tl-sm bg-sage-600 px-4 py-2.5 text-right text-[15px] text-white">{r.message}</div>
                    <div className="mt-1 text-xs text-charcoal-400">
                      {fmtDateTime(r.created_at)} · {r.status === 'sent' ? 'נשלח' : r.status === 'simulated' ? 'סימולציה' : `נכשל: ${r.error}`}
                    </div>
                  </div>
                </div>
              ))}

              <div className="space-y-2 border-t border-charcoal-100 pt-4">
                <textarea
                  className="input min-h-[96px]"
                  placeholder="כתבו תגובה בשם בריא…"
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                />
                <div className="flex flex-wrap gap-2">
                  <button className="btn-primary" onClick={send} disabled={!!busy || !reply.trim()}>
                    {busy === 'send' ? <Spinner /> : <Send className="h-4 w-4" />} שלח תגובה
                  </button>
                  <button className="btn-secondary" onClick={suggest} disabled={!!busy}>
                    {busy === 'suggest' ? <Spinner /> : <Wand2 className="h-4 w-4" />} הצע תגובה עם Claude
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <Empty icon={MessageCircle} title="בחרו תגובה מהרשימה">כדי לקרוא ולהגיב ישירות מהמערכת</Empty>
          )}
        </Card>
      </div>
    </div>
  );
}
