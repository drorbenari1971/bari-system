import { useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, BarChart,
} from 'recharts';
import { Eye, Heart, MessageCircle, Share2, RefreshCw, Brain, Lightbulb } from 'lucide-react';
import { api } from '../api.js';
import { useTheme } from '../App.jsx';
import { fmtNum, fmtDate, fmtDateTime, productLabel, toneLabel } from '../constants.js';
import { Card, Empty, ErrorNote, Notice, Spinner, StatCard, DemoBadge } from '../components/ui.jsx';

const C = { likes: '#d9a441', comments: '#5b8fb9', shares: '#8a9a7b' };

// Chart colors from the active palette - SVG attributes can't use var(), so read the values.
const cssColor = (name) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
  return `rgb(${v.split(/\s+/).join(',')})`;
};
const chartTheme = (dark) => ({
  reach: cssColor(dark ? 'sage-400' : 'sage-500'),
  bar: cssColor(dark ? 'sage-500' : 'sage-400'),
  grid: cssColor('charcoal-100'),
  tick: cssColor('charcoal-500'),
  label: cssColor('charcoal-700'),
  tooltip: {
    borderRadius: 12, fontFamily: 'Heebo', direction: 'rtl', fontSize: 12,
    border: `1px solid ${cssColor('charcoal-200')}`,
    background: cssColor('surface'),
    color: cssColor('charcoal-900'),
  },
});

export default function Analytics() {
  const ct = chartTheme(useTheme().dark);
  const [data, setData] = useState(null);
  const [insights, setInsights] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [syncMsg, setSyncMsg] = useState(null);

  const load = () => api.get('/analytics/summary').then(setData).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    api.get('/analytics/insights/latest').then(setInsights).catch(() => {});
  }, []);

  const chartData = useMemo(() => (data?.posts ?? []).map((p, i) => ({
    name: `#${i + 1} ${productLabel(p.product)}`,
    headline: p.headline,
    date: fmtDate(p.published_at),
    reach: p.reach, likes: p.likes, comments: p.comments, shares: p.shares,
    engagement: p.engagement_rate,
  })), [data]);

  const sync = async () => {
    setBusy('sync'); setError(null); setSyncMsg(null);
    try {
      const r = await api.post('/analytics/sync');
      setSyncMsg(r.skipped ? `לא בוצע סנכרון: ${r.reason}` : `עודכנו ${r.metrics} מדדים, ${r.newComments} תגובות חדשות${r.errors?.length ? ` (${r.errors.length} שגיאות)` : ''}`);
      await load();
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  };

  const analyze = async () => {
    setBusy('ai'); setError(null);
    try { setInsights(await api.post('/analytics/insights')); } catch (e) { setError(e.message); } finally { setBusy(null); }
  };

  if (!data && !error) return <div className="grid h-64 place-items-center"><Spinner className="h-6 w-6 text-sage-500" /></div>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="page-title">אנליטיקס ותובנות AI</h1>
          <p className="page-sub">ביצועי כל פוסט – טווח הגעה, לייקים, תגובות ושיתופים</p>
        </div>
        <button className="btn-secondary" onClick={sync} disabled={!!busy}>
          {busy === 'sync' ? <Spinner /> : <RefreshCw className="h-4 w-4" />} סנכרן נתונים מ-Meta
        </button>
      </div>

      <ErrorNote error={error} />
      {syncMsg && <Notice>{syncMsg}</Notice>}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard icon={Eye} label="טווח הגעה" value={fmtNum(data.totals.reach)} />
            <StatCard icon={Heart} label="לייקים" value={fmtNum(data.totals.likes)} tone="honey" />
            <StatCard icon={MessageCircle} label="תגובות" value={fmtNum(data.totals.comments)} tone="sky" />
            <StatCard icon={Share2} label="שיתופים" value={fmtNum(data.totals.shares)} tone="charcoal" />
          </div>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <Card title="ביצועים לפי פוסט">
              {chartData.length ? (
                <div dir="ltr" className="h-[340px]">
                  <ResponsiveContainer>
                    <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid stroke={ct.grid} vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize: 11, fill: ct.tick }} reversed />
                      <YAxis yAxisId="l" orientation="right" tick={{ fontSize: 11, fill: ct.tick }} />
                      <YAxis yAxisId="r" orientation="left" tick={{ fontSize: 11, fill: ct.tick }} />
                      <Tooltip contentStyle={ct.tooltip} cursor={{ fill: ct.grid }} labelFormatter={(_, p) => p?.[0]?.payload?.headline ?? ''} />
                      <Legend wrapperStyle={{ fontFamily: 'Heebo', fontSize: 12 }} />
                      <Bar yAxisId="l" dataKey="likes" name="לייקים" fill={C.likes} radius={[4, 4, 0, 0]} />
                      <Bar yAxisId="l" dataKey="comments" name="תגובות" fill={C.comments} radius={[4, 4, 0, 0]} />
                      <Bar yAxisId="l" dataKey="shares" name="שיתופים" fill={C.shares} radius={[4, 4, 0, 0]} />
                      <Line yAxisId="r" type="monotone" dataKey="reach" name="טווח הגעה" stroke={ct.reach} strokeWidth={2.5} dot={{ r: 3 }} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              ) : <Empty icon={Eye} title="אין עדיין פוסטים שפורסמו" />}
            </Card>

            <Card
              title={<span className="flex items-center gap-2"><Brain className="h-4 w-4 text-sage-600" /> תובנות אופטימיזציה (AI)</span>}
              action={
                <button className="btn-primary px-3 py-1.5" onClick={analyze} disabled={!!busy || !chartData.length}>
                  {busy === 'ai' ? <Spinner /> : <Lightbulb className="h-4 w-4" />} {insights ? 'נתח מחדש' : 'נתח עם Claude'}
                </button>
              }
            >
              {busy === 'ai' ? (
                <div className="flex items-center gap-2 py-8 text-sm text-charcoal-500"><Spinner /> Claude מנתח את נתוני הפוסטים…</div>
              ) : insights ? (
                <div className="space-y-4">
                  <div className="flex items-start gap-2">
                    <p className="flex-1 text-sm text-charcoal-700">{insights.summary}</p>
                    <DemoBadge show={insights.is_demo} />
                  </div>
                  <ul className="space-y-3">
                    {insights.bullets.map((b, i) => (
                      <li key={i} className="flex gap-3">
                        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-sage-500" />
                        <div>
                          <div className="text-sm font-semibold text-charcoal-800">{b.title}</div>
                          <div className="text-sm text-charcoal-600">{b.detail}</div>
                        </div>
                      </li>
                    ))}
                  </ul>
                  <div className="text-xs text-charcoal-400">עודכן {fmtDateTime(insights.created_at)}</div>
                </div>
              ) : (
                <Empty icon={Lightbulb} title="עוד לא בוצע ניתוח">Claude יקבל את מדדי הפוסטים האחרונים ויחזיר המלצות לחידוד מסרים ואסטרטגיה</Empty>
              )}
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="מעורבות לפי מוצר">
              <GroupChart rows={data.byProduct} />
            </Card>
            <Card title="מעורבות לפי טון">
              <GroupChart rows={data.byTone} />
            </Card>
          </div>

          <Card title="טבלת פוסטים" bodyClass="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-sage-50/60 text-xs text-charcoal-500">
                <tr>
                  {['פוסט', 'מוצר', 'טון', 'תאריך', 'הגעה', 'לייקים', 'תגובות', 'שיתופים', 'מעורבות'].map((h) => (
                    <th key={h} className="px-4 py-2.5 text-right font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-charcoal-100">
                {[...data.posts].reverse().map((p) => (
                  <tr key={p.id} className="hover:bg-sage-50/40">
                    <td className="max-w-[260px] truncate px-4 py-2.5 font-medium">{p.headline} {p.is_demo && <DemoBadge />}</td>
                    <td className="px-4 py-2.5">{productLabel(p.product)}</td>
                    <td className="px-4 py-2.5">{toneLabel(p.tone)}</td>
                    <td className="px-4 py-2.5 text-charcoal-500">{fmtDate(p.published_at)}</td>
                    <td className="px-4 py-2.5">{fmtNum(p.reach)}</td>
                    <td className="px-4 py-2.5">{fmtNum(p.likes)}</td>
                    <td className="px-4 py-2.5">{fmtNum(p.comments)}</td>
                    <td className="px-4 py-2.5">{fmtNum(p.shares)}</td>
                    <td className="px-4 py-2.5 font-medium text-sage-700">{p.engagement_rate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}

function GroupChart({ rows }) {
  const ct = chartTheme(useTheme().dark);
  const filtered = rows.filter((r) => r.posts > 0);
  if (!filtered.length) return <Empty title="אין נתונים" />;
  return (
    <div dir="ltr" className="h-[220px]">
      <ResponsiveContainer>
        <BarChart data={filtered} layout="vertical" margin={{ left: 8, right: 16 }}>
          <CartesianGrid stroke={ct.grid} horizontal={false} />
          <XAxis type="number" tick={{ fontSize: 11, fill: ct.tick }} unit="%" />
          <YAxis type="category" dataKey="label" orientation="right" width={70} tick={{ fontSize: 12, fill: ct.label }} />
          <Tooltip contentStyle={ct.tooltip} cursor={{ fill: ct.grid }} formatter={(v, n) => [n === 'engagement_rate' ? `${v}%` : fmtNum(v), 'שיעור מעורבות']} />
          <Bar dataKey="engagement_rate" fill={ct.bar} radius={[0, 6, 6, 0]} barSize={22} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
