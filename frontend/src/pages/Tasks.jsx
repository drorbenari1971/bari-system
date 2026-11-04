import { useEffect, useState } from 'react';
import { Plus, Trash2, ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react';
import { api } from '../api.js';
import { fmtDate } from '../constants.js';
import { ErrorNote, Spinner, DemoBadge } from '../components/ui.jsx';

const COLUMNS = [
  { id: 'todo', label: 'לביצוע', accent: 'bg-charcoal-300' },
  { id: 'in_progress', label: 'בעבודה', accent: 'bg-honey' },
  { id: 'done', label: 'הושלם', accent: 'bg-sage-500' },
];
const PRIORITY = {
  high: { label: 'גבוהה', cls: 'bg-red-50 text-red-700' },
  medium: { label: 'בינונית', cls: 'bg-amber-50 text-amber-700' },
  low: { label: 'נמוכה', cls: 'bg-charcoal-50 text-charcoal-600' },
};
const EMPTY = { title: '', description: '', priority: 'medium', due_date: '' };

export default function Tasks() {
  const [tasks, setTasks] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = () => api.get('/tasks').then(setTasks).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const add = async (e) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    setBusy(true); setError(null);
    try { await api.post('/tasks', form); setForm(EMPTY); await load(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const update = async (t, patch) => {
    setTasks((all) => all.map((x) => (x.id === t.id ? { ...x, ...patch } : x)));
    try { await api.put(`/tasks/${t.id}`, patch); } catch (err) { setError(err.message); load(); }
  };

  const remove = async (t) => {
    if (!confirm(`למחוק את "${t.title}"?`)) return;
    await api.del(`/tasks/${t.id}`);
    load();
  };

  const move = (t, dir) => {
    const idx = COLUMNS.findIndex((c) => c.id === t.status) + dir;
    if (COLUMNS[idx]) update(t, { status: COLUMNS[idx].id });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">ניהול משימות</h1>
        <p className="page-sub">משימות השיווק של הצוות – מרעיון ועד ביצוע</p>
      </div>

      <form onSubmit={add} className="card grid gap-3 p-4 md:grid-cols-[2fr_2fr_auto_auto_auto] md:items-end">
        <div>
          <label className="label">משימה חדשה</label>
          <input className="input" placeholder="מה צריך לעשות?" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </div>
        <div>
          <label className="label">פירוט</label>
          <input className="input" placeholder="לא חובה" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </div>
        <div>
          <label className="label">עדיפות</label>
          <select className="input" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
            {Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </div>
        <div>
          <label className="label">תאריך יעד</label>
          <input type="date" className="input" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
        </div>
        <button className="btn-primary" disabled={busy || !form.title.trim()}>{busy ? <Spinner /> : <Plus className="h-4 w-4" />} הוסף</button>
      </form>

      <ErrorNote error={error} />

      {!tasks ? (
        <div className="grid h-40 place-items-center"><Spinner className="h-6 w-6 text-sage-500" /></div>
      ) : (
        <div className="grid gap-5 md:grid-cols-3">
          {COLUMNS.map((col, ci) => {
            const items = tasks.filter((t) => t.status === col.id);
            return (
              <section key={col.id} className="rounded-2xl bg-sage-50/60 p-3">
                <header className="mb-3 flex items-center gap-2 px-1">
                  <span className={`h-2.5 w-2.5 rounded-full ${col.accent}`} />
                  <h2 className="font-semibold">{col.label}</h2>
                  <span className="text-xs text-charcoal-400">{items.length}</span>
                </header>
                <div className="space-y-2.5">
                  {items.map((t) => (
                    <article key={t.id} className={`card p-3.5 ${t.status === 'done' ? 'opacity-70' : ''}`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className={`font-medium ${t.status === 'done' ? 'line-through' : ''}`}>{t.title}</div>
                        <button className="text-charcoal-300 hover:text-red-600" onClick={() => remove(t)} aria-label="מחק"><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                      {t.description && <p className="mt-1 text-sm text-charcoal-500">{t.description}</p>}
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <select
                          className={`chip cursor-pointer border-0 ${PRIORITY[t.priority].cls}`}
                          value={t.priority}
                          onChange={(e) => update(t, { priority: e.target.value })}
                        >
                          {Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                        </select>
                        {t.due_date && (
                          <span className={`flex items-center gap-1 text-xs ${t.status !== 'done' && new Date(t.due_date) < new Date(new Date().toDateString()) ? 'text-red-600' : 'text-charcoal-400'}`}>
                            <CalendarDays className="h-3 w-3" />{fmtDate(t.due_date)}
                          </span>
                        )}
                        <DemoBadge show={!!t.is_demo} />
                        <div className="mr-auto flex">
                          <button className="btn-ghost p-1" disabled={ci === 0} onClick={() => move(t, -1)} aria-label="אחורה"><ChevronRight className="h-4 w-4" /></button>
                          <button className="btn-ghost p-1" disabled={ci === COLUMNS.length - 1} onClick={() => move(t, 1)} aria-label="קדימה"><ChevronLeft className="h-4 w-4" /></button>
                        </div>
                      </div>
                    </article>
                  ))}
                  {!items.length && <div className="rounded-xl border border-dashed border-charcoal-200 py-6 text-center text-xs text-charcoal-400">אין משימות</div>}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
