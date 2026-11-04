import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, ChevronLeft, CalendarX, Trash2, Copy, Inbox, Sparkles } from 'lucide-react';
import { api } from '../api.js';
import { productLabel, toneLabel, fmtDateTime, STATUS } from '../constants.js';
import PostPreview from '../components/PostPreview.jsx';
import SchedulePanel from '../components/SchedulePanel.jsx';
import { Card, Empty, ErrorNote, Modal, StatusBadge, DemoBadge } from '../components/ui.jsx';

const WEEKDAYS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const postDate = (p) => new Date(p.scheduled_at ?? p.published_at ?? p.created_at);

function buildDays(cursor, view) {
  const start = new Date(cursor);
  start.setHours(0, 0, 0, 0);
  if (view === 'month') start.setDate(1);
  start.setDate(start.getDate() - start.getDay()); // week starts on Sunday
  const count = view === 'month' ? 42 : 7;
  return Array.from({ length: count }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

export default function CalendarPage() {
  const [view, setView] = useState('month');
  const [cursor, setCursor] = useState(() => new Date());
  const [posts, setPosts] = useState([]);
  const [drafts, setDrafts] = useState([]);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);

  const days = useMemo(() => buildDays(cursor, view), [cursor, view]);

  const load = useCallback(async () => {
    try {
      const from = days[0].toISOString();
      const to = new Date(days[days.length - 1].getTime() + 86_400_000).toISOString();
      const [inRange, d] = await Promise.all([
        api.get(`/posts?status=scheduled,published,publishing,failed&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
        api.get('/posts?status=draft'),
      ]);
      setPosts(inRange); setDrafts(d);
    } catch (e) { setError(e.message); }
  }, [days]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);

  const byDay = useMemo(() => {
    const m = new Map();
    for (const p of posts) {
      const k = dayKey(postDate(p));
      m.set(k, [...(m.get(k) ?? []), p].sort((a, b) => postDate(a) - postDate(b)));
    }
    return m;
  }, [posts]);

  const shift = (dir) => {
    const d = new Date(cursor);
    if (view === 'month') d.setMonth(d.getMonth() + dir, 1); else d.setDate(d.getDate() + dir * 7);
    setCursor(d);
  };

  const title = view === 'month'
    ? cursor.toLocaleDateString('he-IL', { month: 'long', year: 'numeric' })
    : `${days[0].toLocaleDateString('he-IL', { day: 'numeric', month: 'short' })} – ${days[6].toLocaleDateString('he-IL', { day: 'numeric', month: 'short', year: 'numeric' })}`;

  const today = dayKey(new Date());
  const queue = posts.filter((p) => p.status === 'scheduled').sort((a, b) => postDate(a) - postDate(b));

  const postAction = async (fn) => {
    setError(null);
    try { await fn(); setSelected(null); await load(); } catch (e) { setError(e.message); }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="page-title">לוח תוכן ותזמון</h1>
          <p className="page-sub">אשרו טיוטות, תזמנו, והמערכת תפרסם אוטומטית לפייסבוק ולאינסטגרם בזמן שנקבע</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-xl border border-charcoal-200 bg-surface p-0.5 text-sm">
            {[['month', 'חודש'], ['week', 'שבוע']].map(([v, l]) => (
              <button key={v} onClick={() => setView(v)} className={`rounded-lg px-3 py-1.5 ${view === v ? 'bg-sage-600 text-white' : 'text-charcoal-600'}`}>{l}</button>
            ))}
          </div>
          <button className="btn-ghost border border-charcoal-200 bg-surface px-2" onClick={() => shift(-1)} aria-label="הקודם"><ChevronRight className="h-4 w-4" /></button>
          <button className="btn-ghost border border-charcoal-200 bg-surface" onClick={() => setCursor(new Date())}>היום</button>
          <button className="btn-ghost border border-charcoal-200 bg-surface px-2" onClick={() => shift(1)} aria-label="הבא"><ChevronLeft className="h-4 w-4" /></button>
        </div>
      </div>

      <ErrorNote error={error} />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
        <Card title={title} bodyClass="p-3">
          <div className="grid grid-cols-7 gap-px overflow-hidden rounded-xl border border-charcoal-100 bg-charcoal-100">
            {WEEKDAYS.map((w) => <div key={w} className="bg-sage-50 py-2 text-center text-xs font-medium text-sage-800">{w}</div>)}
            {days.map((d) => {
              const k = dayKey(d);
              const items = byDay.get(k) ?? [];
              const outside = view === 'month' && d.getMonth() !== cursor.getMonth();
              return (
                <div key={k} className={`${view === 'week' ? 'min-h-[360px]' : 'min-h-[110px]'} p-1.5 ${outside ? 'bg-charcoal-50' : 'bg-surface'}`}>
                  <div className={`mb-1 flex h-6 w-6 items-center justify-center rounded-full text-xs ${k === today ? 'bg-sage-600 font-semibold text-white' : outside ? 'text-charcoal-300' : 'text-charcoal-600'}`}>
                    {d.getDate()}
                  </div>
                  <div className="space-y-1">
                    {items.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => setSelected(p)}
                        className={`block w-full truncate rounded-md px-1.5 py-1 text-right text-[11px] leading-tight ${STATUS[p.status]?.cls}`}
                        title={p.headline}
                      >
                        <span className="font-medium">{postDate(p).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}</span>{' '}
                        {view === 'week' ? p.headline : productLabel(p.product)}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap gap-3 px-1 text-xs text-charcoal-500">
            {['scheduled', 'published', 'failed'].map((s) => (
              <span key={s} className="flex items-center gap-1.5"><span className={`h-2.5 w-2.5 rounded ${STATUS[s].cls}`} />{STATUS[s].label}</span>
            ))}
          </div>
        </Card>

        <div className="space-y-6">
          <Card title={<span className="flex items-center gap-2"><Inbox className="h-4 w-4 text-sage-500" /> ממתינים לאישור</span>} bodyClass="">
            {drafts.length ? (
              <ul className="scrollbar-thin max-h-[340px] divide-y divide-charcoal-100 overflow-y-auto">
                {drafts.map((d) => (
                  <li key={d.id}>
                    <button onClick={() => setSelected(d)} className="flex w-full items-center gap-3 px-4 py-2.5 text-right hover:bg-sage-50/60">
                      {d.image_feed ? <img src={d.image_feed} alt="" className="h-10 w-10 rounded-lg object-cover" /> : <span className="h-10 w-10 rounded-lg bg-sage-50" />}
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{d.headline || 'ללא כותרת'}</div>
                        <div className="text-xs text-charcoal-400">{productLabel(d.product)} · {toneLabel(d.tone)}</div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty icon={Sparkles} title="אין טיוטות">
                <Link to="/generator" className="text-sage-700 hover:underline">צרו פוסט במחולל התוכן</Link>
              </Empty>
            )}
          </Card>

          <Card title="תור פרסום" bodyClass="">
            {queue.length ? (
              <ul className="divide-y divide-charcoal-100">
                {queue.map((p) => (
                  <li key={p.id}>
                    <button onClick={() => setSelected(p)} className="w-full px-4 py-2.5 text-right hover:bg-sage-50/60">
                      <div className="truncate text-sm font-medium">{p.headline}</div>
                      <div className="text-xs text-charcoal-400">{fmtDateTime(p.scheduled_at)} · {p.platforms.map((x) => (x === 'facebook' ? 'FB' : 'IG')).join(' + ')}</div>
                    </button>
                  </li>
                ))}
              </ul>
            ) : <Empty title="התור ריק בתקופה המוצגת" />}
          </Card>
        </div>
      </div>

      <Modal open={!!selected} onClose={() => setSelected(null)} title={selected?.headline || 'פוסט'} wide>
        {selected && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <StatusBadge status={selected.status} />
              <DemoBadge show={selected.is_demo} />
              {selected.scheduled_at && selected.status === 'scheduled' && <span className="text-charcoal-500">מתוזמן ל-{fmtDateTime(selected.scheduled_at)}</span>}
              {selected.published_at && <span className="text-charcoal-500">פורסם {fmtDateTime(selected.published_at)}</span>}
            </div>
            <PostPreview post={selected} />

            {['draft', 'scheduled', 'failed'].includes(selected.status) && (
              <div className="rounded-2xl border border-sage-100 bg-sage-50/40 p-4">
                <div className="mb-3 font-medium">{selected.status === 'scheduled' ? 'שינוי מועד' : 'אישור ותזמון'}</div>
                <SchedulePanel post={selected} onDone={() => postAction(async () => {})} />
              </div>
            )}

            {selected.publish_log?.length > 0 && (
              <div>
                <div className="label">יומן פרסום</div>
                <ul className="space-y-1 rounded-xl bg-charcoal-50 p-3 text-xs text-charcoal-600">
                  {selected.publish_log.map((l, i) => <li key={i}>{l}</li>)}
                </ul>
              </div>
            )}

            <div className="flex flex-wrap gap-2 border-t border-charcoal-100 pt-4">
              {selected.status === 'scheduled' && (
                <button className="btn-secondary" onClick={() => postAction(() => api.post(`/posts/${selected.id}/unschedule`))}>
                  <CalendarX className="h-4 w-4" /> בטל תזמון (חזרה לטיוטה)
                </button>
              )}
              <button className="btn-secondary" onClick={() => postAction(() => api.post(`/posts/${selected.id}/duplicate`))}>
                <Copy className="h-4 w-4" /> שכפל כטיוטה
              </button>
              <button
                className="btn-danger"
                onClick={() => confirm('למחוק את הפוסט מהמערכת? (לא נמחק מפייסבוק/אינסטגרם)') && postAction(() => api.del(`/posts/${selected.id}`))}
              >
                <Trash2 className="h-4 w-4" /> מחק
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
