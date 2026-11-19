// Monitoring (design section 13): the job queue, jobs that failed or wait for a retry (with "try
// again"), and the recent sync runs. Refreshes every 15 seconds.
import { useCallback, useEffect, useState } from 'react';
import { Activity, RotateCcw } from 'lucide-react';
import { api } from '../../api.js';
import { fmtDateTime, fmtNum } from '../../constants.js';
import { Card, ErrorNote, Spinner } from '../../components/ui.jsx';
import { SOURCES } from './customerFormat.js';

const REFRESH_MS = 15_000;
const JOB_TYPES = {
  customers_sync: 'סנכרון לקוחות', customers_page: 'דף לקוחות', customers_finalize: 'סיום סנכרון לקוחות',
  documents_sync: 'סנכרון מסמכים', documents_page: 'דף מסמכים', documents_finalize: 'סיום סנכרון מסמכים',
  fetch_customer: 'משיכת לקוח', fetch_document: 'משיכת מסמך',
};
const COUNTS = [['pending', 'ממתינות'], ['processing', 'בעבודה'], ['retry', 'ממתינות לניסיון חוזר'], ['failed', 'נכשלו'], ['completed', 'הושלמו (30 יום)']];
const RUN_TYPES = { customers: 'לקוחות', documents: 'מסמכים' };
const RUN_STATUS = { running: 'רץ', completed: 'הושלם', failed: 'נכשל', cancelled: 'בוטל' };

export default function MonitorCard({ onChanged }) {
  const [jobs, setJobs] = useState(null);
  const [problems, setProblems] = useState([]);
  const [runs, setRuns] = useState([]);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const [all, failed, retry, r] = await Promise.all([
        api.get('/accounting/jobs?pageSize=1'),
        api.get('/accounting/jobs?status=failed&pageSize=20'),
        api.get('/accounting/jobs?status=retry&pageSize=20'),
        api.get('/accounting/sync-runs?pageSize=10'),
      ]);
      setJobs(all.counts);
      setProblems([...failed.items, ...retry.items].sort((a, b) => b.id - a.id));
      setRuns(r.items);
      setError(null);
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const retry = async (id) => {
    setBusy(id);
    try { await api.post(`/accounting/jobs/${id}/retry`); await load(); onChanged(); } catch (e) { setError(e.message); } finally { setBusy(null); }
  };

  if (!jobs) return error ? <ErrorNote error={error} /> : null;
  return (
    <Card title={<span className="flex items-center gap-2"><Activity className="h-4 w-4 text-sage-500" /> ניטור</span>}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {COUNTS.map(([key, label]) => (
          <div key={key} className={`rounded-xl border p-2.5 text-center ${key === 'failed' && jobs.failed ? 'border-red-200 bg-red-50' : 'border-charcoal-100'}`}>
            <div className={`text-lg font-semibold ${key === 'failed' && jobs.failed ? 'text-red-700' : 'text-charcoal-900'}`}>{fmtNum(jobs[key])}</div>
            <div className="text-xs text-charcoal-500">{label}</div>
          </div>
        ))}
      </div>

      {problems.length > 0 && (
        <div className="mt-4">
          <div className="mb-1 text-sm font-medium">משימות שנכשלו או ממתינות לניסיון חוזר</div>
          <ul className="divide-y divide-charcoal-100 text-sm">
            {problems.map((j) => (
              <li key={j.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                <div>
                  <span className="font-medium">{JOB_TYPES[j.type] ?? j.type}</span>
                  <span className={`chip mr-1 ${j.status === 'failed' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'}`}>{j.status === 'failed' ? 'נכשלה' : 'תנסה שוב'}</span>
                  <span className="text-xs text-charcoal-400"> · {SOURCES[j.source] ?? j.source} · ניסיונות {j.attempts}/{j.max_attempts}{j.status === 'retry' ? ` · הבא ב-${fmtDateTime(j.next_attempt_at)}` : ''}</span>
                  {j.last_error && <p className="mt-0.5 text-xs text-red-600">{j.last_error}</p>}
                </div>
                <button className="btn-ghost px-2 py-1" onClick={() => retry(j.id)} disabled={busy === j.id}>
                  {busy === j.id ? <Spinner /> : <RotateCcw className="h-3.5 w-3.5" />} נסה שוב עכשיו
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <details className="mt-4">
        <summary className="cursor-pointer text-xs text-sage-700">ריצות סנכרון אחרונות</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-right text-charcoal-500">
              <tr><th className="py-1 pl-3">התחלה</th><th className="pl-3">סוג</th><th className="pl-3">מקור</th><th className="pl-3">מצב</th><th className="pl-3">נקראו</th><th className="pl-3">נוספו</th><th className="pl-3">עודכנו</th><th>שגיאות</th></tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-t border-charcoal-100" title={r.error ?? ''}>
                  <td className="py-1 pl-3 whitespace-nowrap">{fmtDateTime(r.started_at)}</td>
                  <td className="pl-3">{RUN_TYPES[r.type] ?? r.type}</td>
                  <td className="pl-3">{SOURCES[r.source] ?? r.source}</td>
                  <td className={`pl-3 ${r.status === 'failed' ? 'text-red-600' : ''}`}>{RUN_STATUS[r.status] ?? r.status}</td>
                  <td className="pl-3">{fmtNum(r.fetched)}</td>
                  <td className="pl-3">{fmtNum(r.added)}</td>
                  <td className="pl-3">{fmtNum(r.updated)}</td>
                  <td>{fmtNum(r.failed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <ErrorNote error={error} />
    </Card>
  );
}
