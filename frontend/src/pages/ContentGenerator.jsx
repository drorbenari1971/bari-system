import { useEffect, useState } from 'react';
import { Sparkles, ImagePlus, Save, CalendarCheck, Wand2, FileText, Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { PRODUCTS, TONES, productLabel, toneLabel, fmtDateTime } from '../constants.js';
import PostPreview from '../components/PostPreview.jsx';
import SchedulePanel from '../components/SchedulePanel.jsx';
import { Card, Empty, ErrorNote, Modal, Notice, Spinner, StatusBadge } from '../components/ui.jsx';

export default function ContentGenerator() {
  const [product, setProduct] = useState('bone_broth');
  const [tone, setTone] = useState('educational');
  const [notes, setNotes] = useState('');
  const [post, setPost] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(null); // 'text' | 'image' | 'save'
  const [error, setError] = useState(null);
  const [demoNote, setDemoNote] = useState(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [drafts, setDrafts] = useState([]);
  const [flash, setFlash] = useState(null);

  const loadDrafts = () => api.get('/posts?status=draft,failed').then(setDrafts).catch(() => {});
  useEffect(() => { loadDrafts(); }, []);

  const act = async (kind, fn) => {
    setBusy(kind); setError(null);
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(null); }
  };

  const generateText = () => act('text', async () => {
    const { post: p, demo } = await api.post('/posts/generate', { product, tone, notes });
    setPost(p); setDirty(false);
    setDemoNote(demo ? 'הטקסט נוצר במצב דמו – הוסיפו ANTHROPIC_API_KEY בקובץ backend/.env כדי ש-Claude יכתוב פוסטים אמיתיים.' : null);
    loadDrafts();
  });

  const generateImages = () => act('image', async () => {
    if (dirty) await save();
    const { post: p, demo } = await api.post(`/posts/${post.id}/images`, { image_prompt: post.image_prompt });
    setPost(p);
    setDemoNote(demo ? 'התמונות הן placeholder – הוסיפו OPENAI_API_KEY כדי לייצר תמונות אמיתיות.' : null);
    loadDrafts();
  });

  const save = async () => {
    const p = await api.put(`/posts/${post.id}`, {
      headline: post.headline, body: post.body, cta: post.cta, hashtags: post.hashtags, image_prompt: post.image_prompt,
    });
    setPost(p); setDirty(false);
    return p;
  };

  const removeDraft = async (id) => {
    if (!confirm('למחוק את הטיוטה?')) return;
    await api.del(`/posts/${id}`);
    if (post?.id === id) setPost(null);
    loadDrafts();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">מחולל תוכן AI</h1>
        <p className="page-sub">בחרו מוצר וטון – Claude יכתוב פוסט בעברית ויכין תיאור לתמונות פיד וסטורי</p>
      </div>

      <Card>
        <div className="grid gap-5 lg:grid-cols-[1fr_1fr_1.2fr]">
          <div>
            <label className="label">מוצר</label>
            <div className="grid grid-cols-2 gap-2">
              {PRODUCTS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setProduct(p.id)}
                  className={`btn border ${product === p.id ? 'border-sage-500 bg-sage-50 text-sage-800' : 'border-charcoal-200 text-charcoal-600 hover:bg-charcoal-50'}`}
                >
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: p.color }} />{p.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="label">טון</label>
            <div className="space-y-2">
              {TONES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTone(t.id)}
                  className={`flex w-full items-center justify-between rounded-xl border px-3 py-2 text-sm transition ${tone === t.id ? 'border-sage-500 bg-sage-50 text-sage-800' : 'border-charcoal-200 text-charcoal-600 hover:bg-charcoal-50'}`}
                >
                  <span className="font-medium">{t.label}</span>
                  <span className="text-xs text-charcoal-400">{t.hint}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col">
            <label className="label">דגשים (לא חובה)</label>
            <textarea
              className="input min-h-[92px] flex-1"
              placeholder="למשל: מבצע חורף, להזכיר משלוח חינם מעל 200 ₪, לפנות להורים צעירים…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            <button className="btn mt-3 bg-blue-600 text-white hover:bg-blue-700" onClick={generateText} disabled={!!busy}>
              {busy === 'text' ? <Spinner /> : <Sparkles className="h-4 w-4" />}
              {busy === 'text' ? 'Claude כותב…' : 'צור פוסט'}
            </button>
          </div>
        </div>
      </Card>

      <ErrorNote error={error} />
      {demoNote && <Notice>{demoNote}</Notice>}
      {flash && <div className="rounded-xl border border-sage-200 bg-sage-50 px-3 py-2 text-sm text-sage-800">{flash}</div>}

      {post ? (
        <Card
          title={<span className="flex items-center gap-2">תצוגה מקדימה <StatusBadge status={post.status} /></span>}
          action={
            <div className="flex flex-wrap gap-2">
              {dirty && (
                <button className="btn-secondary" onClick={() => act('save', save)} disabled={!!busy}>
                  {busy === 'save' ? <Spinner /> : <Save className="h-4 w-4" />} שמור שינויים
                </button>
              )}
              <button className="btn-secondary" onClick={generateImages} disabled={!!busy}>
                {busy === 'image' ? <Spinner /> : <ImagePlus className="h-4 w-4" />}
                {post.image_feed ? 'צור תמונות מחדש' : 'צור תמונות'}
              </button>
              <button
                className="btn-primary"
                disabled={!!busy || post.status === 'published'}
                onClick={async () => { if (dirty) await act('save', save); setScheduleOpen(true); }}
              >
                <CalendarCheck className="h-4 w-4" /> אשר ותזמן
              </button>
            </div>
          }
        >
          <PostPreview
            post={post}
            editable
            imageLoading={busy === 'image'}
            onChange={(p) => { setPost(p); setDirty(true); }}
          />
          <div className="mt-5">
            <label className="label flex items-center gap-1.5"><Wand2 className="h-3.5 w-3.5" /> תיאור התמונה (Prompt – נכתב ע״י Claude, ניתן לעריכה)</label>
            <textarea
              dir="ltr"
              className="input min-h-[70px] text-left font-mono text-xs"
              value={post.image_prompt}
              onChange={(e) => { setPost({ ...post, image_prompt: e.target.value }); setDirty(true); }}
            />
          </div>
        </Card>
      ) : (
        <Card><Empty icon={Sparkles} title="עוד אין פוסט">בחרו מוצר וטון ולחצו "צור פוסט"</Empty></Card>
      )}

      <Card title="טיוטות אחרונות" bodyClass="">
        {drafts.length ? (
          <ul className="divide-y divide-charcoal-100">
            {drafts.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-5 py-3">
                {d.image_feed
                  ? <img src={d.image_feed} alt="" className="h-11 w-11 rounded-lg object-cover" />
                  : <span className="grid h-11 w-11 place-items-center rounded-lg bg-sage-50 text-sage-400"><FileText className="h-4 w-4" /></span>}
                <button className="min-w-0 flex-1 text-right" onClick={() => { setPost(d); setDirty(false); setDemoNote(null); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
                  <div className="truncate text-sm font-medium hover:text-sage-700">{d.headline || 'ללא כותרת'}</div>
                  <div className="text-xs text-charcoal-400">{productLabel(d.product)} · {toneLabel(d.tone)} · {fmtDateTime(d.created_at)}</div>
                </button>
                <StatusBadge status={d.status} />
                <button className="btn-ghost p-1.5" onClick={() => removeDraft(d.id)} aria-label="מחק"><Trash2 className="h-4 w-4" /></button>
              </li>
            ))}
          </ul>
        ) : <Empty icon={FileText} title="אין טיוטות" />}
      </Card>

      <Modal open={scheduleOpen && !!post} onClose={() => setScheduleOpen(false)} title="אישור ותזמון פרסום">
        {post && (
          <SchedulePanel
            post={post}
            onDone={(p) => {
              setScheduleOpen(false);
              setPost(p);
              setFlash(p.status === 'scheduled'
                ? `הפוסט תוזמן ל-${fmtDateTime(p.scheduled_at)} ויפורסם אוטומטית.`
                : `סטטוס: ${p.status === 'published' ? 'פורסם' : p.status}. ${(p.publish_log ?? []).slice(-1)[0] ?? ''}`);
              loadDrafts();
            }}
          />
        )}
      </Modal>
    </div>
  );
}
