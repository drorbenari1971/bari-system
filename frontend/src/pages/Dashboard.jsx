import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Eye, Heart, MessageCircle, Share2, Sparkles, CalendarClock, ListChecks, Radio, ArrowLeft } from 'lucide-react';
import { api } from '../api.js';
import { fmtNum, fmtDateTime, fmtDate, timeAgo, productLabel } from '../constants.js';
import { Card, Empty, PlatformBadge, StatCard, Spinner, ErrorNote, DemoBadge } from '../components/ui.jsx';

const PRIORITY = { high: 'bg-red-50 text-red-700', medium: 'bg-amber-50 text-amber-700', low: 'bg-charcoal-50 text-charcoal-600' };
const PRIORITY_LABEL = { high: 'גבוהה', medium: 'בינונית', low: 'נמוכה' };

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const load = () => api.get('/dashboard').then(setData).catch((e) => setError(e.message));
    load();
    const t = setInterval(load, 30_000); // live feed refresh
    return () => clearInterval(t);
  }, []);

  if (error) return <ErrorNote error={error} />;
  if (!data) return <div className="grid h-64 place-items-center"><Spinner className="h-6 w-6 text-sage-500" /></div>;

  const { totals, counts } = data;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="page-title">בוקר טוב 🌿</h1>
          <p className="page-sub">תמונת מצב של הנוכחות הדיגיטלית של בריא</p>
        </div>
        <Link to="/generator" className="btn-primary"><Sparkles className="h-4 w-4" /> פוסט חדש</Link>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={Eye} label="סך טווח הגעה" value={fmtNum(totals.reach)} sub={`${counts.published} פוסטים שפורסמו`} />
        <StatCard icon={Heart} label="לייקים" value={fmtNum(totals.likes)} tone="honey" />
        <StatCard icon={MessageCircle} label="תגובות" value={fmtNum(totals.comments)} sub={`${counts.unanswered} ממתינות למענה`} tone="sky" />
        <StatCard icon={Share2} label="שיתופים" value={fmtNum(totals.shares)} tone="charcoal" />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card
          className="lg:col-span-2"
          title={<span className="flex items-center gap-2"><Radio className="h-4 w-4 text-sage-500" /> פיד אינטראקציות חי</span>}
          action={<Link to="/engagement" className="text-sm text-sage-700 hover:underline">לתיבת התגובות</Link>}
          bodyClass=""
        >
          {data.recentComments.length ? (
            <ul className="divide-y divide-charcoal-100">
              {data.recentComments.map((c) => (
                <li key={c.id} className="flex gap-3 px-5 py-3.5">
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-sage-100 text-sm font-semibold text-sage-700">
                    {c.author?.[0] ?? '?'}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">{c.author}</span>
                      <PlatformBadge platform={c.platform} />
                      {!c.replied && <span className="chip bg-amber-50 text-amber-700">ממתין</span>}
                      <span className="text-xs text-charcoal-400">{timeAgo(c.created_time)}</span>
                    </div>
                    <p className="mt-0.5 truncate text-sm text-charcoal-600">{c.message}</p>
                    {c.post_headline && <p className="truncate text-xs text-charcoal-400">על: {c.post_headline}</p>}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty icon={MessageCircle} title="אין עדיין תגובות">תגובות מפייסבוק ואינסטגרם יופיעו כאן</Empty>
          )}
        </Card>

        <div className="space-y-6">
          <Card
            title={<span className="flex items-center gap-2"><ListChecks className="h-4 w-4 text-sage-500" /> משימות פעילות</span>}
            action={<Link to="/tasks" className="text-sm text-sage-700 hover:underline">הכל</Link>}
            bodyClass=""
          >
            {data.tasks.length ? (
              <ul className="divide-y divide-charcoal-100">
                {data.tasks.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-2 px-5 py-3 text-sm">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{t.title}</div>
                      <div className="text-xs text-charcoal-400">
                        {t.status === 'in_progress' ? 'בעבודה' : 'לביצוע'}{t.due_date && ` · יעד ${fmtDate(t.due_date)}`}
                      </div>
                    </div>
                    <span className={`chip ${PRIORITY[t.priority]}`}>{PRIORITY_LABEL[t.priority]}</span>
                  </li>
                ))}
              </ul>
            ) : <Empty icon={ListChecks} title="אין משימות פתוחות" />}
          </Card>

          <Card
            title={<span className="flex items-center gap-2"><CalendarClock className="h-4 w-4 text-sage-500" /> בתור לפרסום</span>}
            action={<Link to="/calendar" className="text-sm text-sage-700 hover:underline">ללוח</Link>}
            bodyClass=""
          >
            {data.upcoming.length ? (
              <ul className="divide-y divide-charcoal-100">
                {data.upcoming.map((p) => (
                  <li key={p.id} className="px-5 py-3 text-sm">
                    <div className="truncate font-medium">{p.headline}</div>
                    <div className="text-xs text-charcoal-400">{productLabel(p.product)} · {fmtDateTime(p.scheduled_at)}</div>
                  </li>
                ))}
              </ul>
            ) : <Empty icon={CalendarClock} title="אין פוסטים מתוזמנים">{counts.drafts} טיוטות ממתינות לאישור</Empty>}
          </Card>
        </div>
      </div>

      {data.topPosts.length > 0 && (
        <Card title="הפוסטים המובילים" action={<Link to="/analytics" className="flex items-center gap-1 text-sm text-sage-700 hover:underline">לניתוח מלא <ArrowLeft className="h-3.5 w-3.5" /></Link>}>
          <div className="grid gap-4 md:grid-cols-3">
            {data.topPosts.map((p) => (
              <div key={p.id} className="flex gap-3 rounded-xl border border-charcoal-100 p-3">
                {p.image_feed && <img src={p.image_feed} alt="" className="h-16 w-16 rounded-lg object-cover" />}
                <div className="min-w-0 text-sm">
                  <div className="line-clamp-2 font-medium">{p.headline}</div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-charcoal-500">
                    <span>{fmtNum(p.reach)} הגעה</span>·<span>{p.engagement_rate}% מעורבות</span>
                    <DemoBadge show={p.is_demo} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
