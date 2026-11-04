import { Router } from 'express';
import { db, hydratePost, latestMetricsByPost } from '../db.js';
import { PRODUCTS, TONES } from '../constants.js';
import { generateInsights } from '../services/claude.js';
import { syncFromMeta } from '../scheduler.js';

const router = Router();
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

export function postPerformance() {
  const metrics = latestMetricsByPost();
  return db.prepare("SELECT * FROM posts WHERE status = 'published' ORDER BY published_at ASC").all()
    .map(hydratePost)
    .map((p) => {
      const m = metrics.get(p.id) ?? { reach: 0, likes: 0, comments: 0, shares: 0, byPlatform: {} };
      const engagement = m.likes + m.comments + m.shares;
      return {
        id: p.id,
        headline: p.headline,
        product: p.product,
        tone: p.tone,
        published_at: p.published_at,
        image_feed: p.image_feed,
        is_demo: p.is_demo,
        reach: m.reach,
        likes: m.likes,
        comments: m.comments,
        shares: m.shares,
        engagement_rate: m.reach ? +(engagement / m.reach * 100).toFixed(2) : 0,
        byPlatform: m.byPlatform,
      };
    });
}

router.get('/summary', (req, res) => {
  const posts = postPerformance();
  const totals = posts.reduce((t, p) => ({
    reach: t.reach + p.reach, likes: t.likes + p.likes, comments: t.comments + p.comments, shares: t.shares + p.shares,
  }), { reach: 0, likes: 0, comments: 0, shares: 0 });
  const group = (key, labels) => Object.entries(labels).map(([id, l]) => {
    const subset = posts.filter((p) => p[key] === id);
    const reach = subset.reduce((s, p) => s + p.reach, 0);
    const eng = subset.reduce((s, p) => s + p.likes + p.comments + p.shares, 0);
    return { id, label: l.he, posts: subset.length, reach, engagement: eng, engagement_rate: reach ? +(eng / reach * 100).toFixed(2) : 0 };
  });
  res.json({ totals, posts, byProduct: group('product', PRODUCTS), byTone: group('tone', TONES) });
});

router.post('/sync', wrap(async (req, res) => res.json(await syncFromMeta())));

router.get('/insights/latest', (req, res) => {
  const row = db.prepare('SELECT * FROM insights ORDER BY id DESC LIMIT 1').get();
  res.json(row ? { ...row, bullets: JSON.parse(row.bullets), is_demo: !!row.is_demo } : null);
});

// Send recent post metrics to Claude, store and return Hebrew recommendations.
router.post('/insights', wrap(async (req, res) => {
  const rows = postPerformance().slice(-30).map((p) => ({
    product: PRODUCTS[p.product]?.he, tone: TONES[p.tone]?.he, headline: p.headline,
    published_at: p.published_at, reach: p.reach, likes: p.likes, comments: p.comments, shares: p.shares,
    engagement_rate_pct: p.engagement_rate,
  }));
  if (!rows.length) return res.status(400).json({ error: 'אין עדיין פוסטים שפורסמו לניתוח' });
  const result = await generateInsights(rows);
  const { lastInsertRowid } = db.prepare('INSERT INTO insights (summary, bullets, is_demo) VALUES (?, ?, ?)')
    .run(result.summary, JSON.stringify(result.bullets), result.demo ? 1 : 0);
  const row = db.prepare('SELECT * FROM insights WHERE id = ?').get(lastInsertRowid);
  res.json({ ...row, bullets: result.bullets, is_demo: result.demo });
}));

export default router;
