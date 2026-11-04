import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db, getPost, hydratePost, updatePost, MEDIA_DIR, nowIso } from '../db.js';
import { PRODUCTS, TONES } from '../constants.js';
import { generatePostCopy } from '../services/claude.js';
import { generatePostImages } from '../services/images.js';
import { publishNow } from '../scheduler.js';

const router = Router();
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

router.get('/', (req, res) => {
  const { status, from, to } = req.query;
  let sql = 'SELECT * FROM posts WHERE 1=1';
  const args = [];
  if (status) { sql += ' AND status IN (' + String(status).split(',').map(() => '?').join(',') + ')'; args.push(...String(status).split(',')); }
  if (from) { sql += ' AND COALESCE(scheduled_at, published_at, created_at) >= ?'; args.push(from); }
  if (to) { sql += ' AND COALESCE(scheduled_at, published_at, created_at) < ?'; args.push(to); }
  sql += ' ORDER BY COALESCE(scheduled_at, published_at, created_at) DESC';
  res.json(db.prepare(sql).all(...args).map(hydratePost));
});

router.get('/:id', (req, res) => {
  const post = getPost(req.params.id);
  if (!post) return res.status(404).json({ error: 'פוסט לא נמצא' });
  res.json(post);
});

// Generate Hebrew copy with Claude and store it as a new draft.
router.post('/generate', wrap(async (req, res) => {
  const { product, tone, notes = '' } = req.body;
  if (!PRODUCTS[product] || !TONES[tone]) return res.status(400).json({ error: 'יש לבחור מוצר וטון' });
  const copy = await generatePostCopy({ product, tone, notes });
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO posts (product, tone, headline, body, cta, hashtags, image_prompt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(product, tone, copy.headline, copy.body, copy.cta, JSON.stringify(copy.hashtags), copy.image_prompt);
  res.json({ post: getPost(lastInsertRowid), demo: copy.demo });
}));

// Generate the 1:1 feed image and 9:16 story image from Claude's image prompt.
router.post('/:id/images', wrap(async (req, res) => {
  const post = getPost(req.params.id);
  if (!post) return res.status(404).json({ error: 'פוסט לא נמצא' });
  const prompt = (req.body.image_prompt ?? post.image_prompt).trim();
  if (!prompt) return res.status(400).json({ error: 'חסר תיאור תמונה' });
  const imgs = await generatePostImages({ postId: post.id, prompt, product: post.product });
  removeMedia(post.image_feed, post.image_story);
  res.json({ post: updatePost(post.id, { image_prompt: prompt, image_feed: imgs.feed, image_story: imgs.story }), demo: imgs.demo });
}));

router.put('/:id', (req, res) => {
  const post = getPost(req.params.id);
  if (!post) return res.status(404).json({ error: 'פוסט לא נמצא' });
  const allowed = ['headline', 'body', 'cta', 'hashtags', 'image_prompt', 'platforms'];
  const fields = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  res.json(updatePost(post.id, fields));
});

// "Approve & Schedule"
router.post('/:id/schedule', (req, res) => {
  const post = getPost(req.params.id);
  if (!post) return res.status(404).json({ error: 'פוסט לא נמצא' });
  if (['published', 'publishing'].includes(post.status)) return res.status(400).json({ error: 'הפוסט כבר פורסם' });
  const when = new Date(req.body.scheduled_at);
  if (Number.isNaN(when.getTime())) return res.status(400).json({ error: 'תאריך לא תקין' });
  if (when.getTime() < Date.now() - 60_000) return res.status(400).json({ error: 'לא ניתן לתזמן לעבר' });
  const platforms = Array.isArray(req.body.platforms) && req.body.platforms.length ? req.body.platforms : post.platforms;
  res.json(updatePost(post.id, { status: 'scheduled', scheduled_at: when.toISOString(), platforms }));
});

router.post('/:id/unschedule', (req, res) => {
  const post = getPost(req.params.id);
  if (!post) return res.status(404).json({ error: 'פוסט לא נמצא' });
  if (post.status !== 'scheduled') return res.status(400).json({ error: 'הפוסט אינו מתוזמן' });
  res.json(updatePost(post.id, { status: 'draft', scheduled_at: null }));
});

router.post('/:id/publish-now', wrap(async (req, res) => {
  if (!getPost(req.params.id)) return res.status(404).json({ error: 'פוסט לא נמצא' });
  res.json(await publishNow(Number(req.params.id)));
}));

router.post('/:id/duplicate', (req, res) => {
  const p = getPost(req.params.id);
  if (!p) return res.status(404).json({ error: 'פוסט לא נמצא' });
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO posts (product, tone, headline, body, cta, hashtags, image_prompt, platforms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(p.product, p.tone, p.headline, p.body, p.cta, JSON.stringify(p.hashtags), p.image_prompt, JSON.stringify(p.platforms), nowIso());
  res.json(getPost(lastInsertRowid));
});

router.delete('/:id', (req, res) => {
  const post = getPost(req.params.id);
  if (!post) return res.status(404).json({ error: 'פוסט לא נמצא' });
  db.prepare('DELETE FROM posts WHERE id = ?').run(post.id);
  removeMedia(post.image_feed, post.image_story);
  res.json({ ok: true });
});

function removeMedia(...files) {
  for (const f of files) {
    if (!f) continue;
    try { fs.unlinkSync(path.join(MEDIA_DIR, path.basename(f))); } catch { /* already gone */ }
  }
}

export default router;
