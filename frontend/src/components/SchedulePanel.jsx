import { useState } from 'react';
import { CalendarCheck, Send } from 'lucide-react';
import { api } from '../api.js';
import { PLATFORMS, toLocalInput } from '../constants.js';
import { ErrorNote, Spinner } from './ui.jsx';

// "Approve & Schedule" form: date/time + target platforms, or publish immediately.
export default function SchedulePanel({ post, onDone }) {
  const defaultTime = post.scheduled_at
    ? toLocalInput(post.scheduled_at)
    : toLocalInput(new Date(Date.now() + 24 * 3600 * 1000).setHours(9, 0, 0, 0));
  const [when, setWhen] = useState(defaultTime);
  const [platforms, setPlatforms] = useState(post.platforms?.length ? post.platforms : ['facebook', 'instagram']);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const toggle = (id) => setPlatforms((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const run = async (kind) => {
    setBusy(kind); setError(null);
    try {
      let result;
      if (kind === 'schedule') {
        result = await api.post(`/posts/${post.id}/schedule`, { scheduled_at: new Date(when).toISOString(), platforms });
      } else {
        await api.put(`/posts/${post.id}`, { platforms });
        result = await api.post(`/posts/${post.id}/publish-now`);
      }
      onDone?.(result);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label">מועד פרסום</label>
          <input type="datetime-local" className="input" value={when} onChange={(e) => setWhen(e.target.value)} />
        </div>
        <div>
          <label className="label">פלטפורמות</label>
          <div className="flex gap-2">
            {PLATFORMS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => toggle(p.id)}
                className={`btn flex-1 border ${platforms.includes(p.id) ? 'border-sage-500 bg-sage-50 text-sage-800' : 'border-charcoal-200 text-charcoal-500'}`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {!post.image_feed && (
        <div className="text-xs text-amber-700">שימו לב: לפוסט אין עדיין תמונה. אינסטגרם דורש תמונה כדי לפרסם.</div>
      )}
      <ErrorNote error={error} />
      <div className="flex flex-wrap gap-2">
        <button className="btn-primary" disabled={!!busy || !platforms.length} onClick={() => run('schedule')}>
          {busy === 'schedule' ? <Spinner /> : <CalendarCheck className="h-4 w-4" />} אשר ותזמן
        </button>
        <button className="btn-secondary" disabled={!!busy || !platforms.length} onClick={() => run('now')}>
          {busy === 'now' ? <Spinner /> : <Send className="h-4 w-4" />} פרסם עכשיו
        </button>
      </div>
    </div>
  );
}
