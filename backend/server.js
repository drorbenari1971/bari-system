import { BACKEND_DIR, env } from './config.js';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { db, hydratePost, MEDIA_DIR } from './db.js';
import { seedDemoIfEmpty, seedFinanceDemoIfEmpty, clearDemoData } from './seed.js';
import { startScheduler } from './scheduler.js';
import { claudeConfigured } from './services/claude.js';
import { imagesConfigured } from './services/images.js';
import { metaConfigured, igConfigured } from './services/meta.js';
import { cloudinaryConfigured } from './services/storage.js';
import postsRouter from './routes/posts.js';
import tasksRouter from './routes/tasks.js';
import analyticsRouter, { postPerformance } from './routes/analytics.js';
import engagementRouter from './routes/engagement.js';
import webhooksRouter from './routes/webhooks.js';
import financeRouter from './routes/finance.js';

if (env('SEED_DEMO', 'true') === 'true') {
  seedDemoIfEmpty();
  seedFinanceDemoIfEmpty();
}

const app = express();

// The app has no login, so it only serves this computer: requests must address it by a
// local name, and browser requests must come from a local page (not from another website).
const isLocalHost = (hostname) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
app.use((req, res, next) => {
  const hostOk = isLocalHost((req.headers.host ?? '').replace(/:\d+$/, ''));
  let originOk = true;
  if (req.headers.origin) {
    try { originOk = isLocalHost(new URL(req.headers.origin).hostname); } catch { originOk = false; }
  }
  if (!hostOk || !originOk) return res.status(403).json({ error: 'גישה מותרת רק מהמחשב הזה' });
  next();
});

app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

app.use('/media', express.static(MEDIA_DIR, { maxAge: '7d' }));

app.get('/api/status', (req, res) => {
  res.json({
    claude: claudeConfigured(),
    images: imagesConfigured(),
    facebook: metaConfigured(),
    instagram: igConfigured(),
    imageHosting: cloudinaryConfigured(),
    model: env('CLAUDE_MODEL', 'claude-opus-5-5'),
    hasDemoData: db.prepare('SELECT (SELECT COUNT(*) FROM posts WHERE is_demo = 1) + (SELECT COUNT(*) FROM tasks WHERE is_demo = 1) + (SELECT COUNT(*) FROM transactions WHERE is_demo = 1) AS n').get().n > 0,
  });
});

app.get('/api/dashboard', (req, res) => {
  const perf = postPerformance();
  const totals = perf.reduce((t, p) => ({
    reach: t.reach + p.reach, likes: t.likes + p.likes, comments: t.comments + p.comments, shares: t.shares + p.shares,
  }), { reach: 0, likes: 0, comments: 0, shares: 0 });
  const count = (sql) => db.prepare(sql).get().n;
  res.json({
    totals,
    counts: {
      drafts: count("SELECT COUNT(*) AS n FROM posts WHERE status = 'draft'"),
      scheduled: count("SELECT COUNT(*) AS n FROM posts WHERE status = 'scheduled'"),
      published: perf.length,
      unanswered: count('SELECT COUNT(*) AS n FROM comments WHERE replied = 0'),
    },
    tasks: db.prepare("SELECT * FROM tasks WHERE status != 'done' ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, COALESCE(due_date,'9999') LIMIT 8").all(),
    upcoming: db.prepare("SELECT * FROM posts WHERE status = 'scheduled' ORDER BY scheduled_at ASC LIMIT 5").all().map(hydratePost),
    recentComments: db.prepare(`SELECT c.*, p.headline AS post_headline FROM comments c LEFT JOIN posts p ON p.id = c.post_id
                                ORDER BY c.created_time DESC LIMIT 10`).all(),
    topPosts: [...perf].sort((a, b) => b.reach - a.reach).slice(0, 3),
  });
});

app.post('/api/demo/clear', (req, res) => {
  for (const f of clearDemoData()) {
    try { fs.unlinkSync(path.join(MEDIA_DIR, path.basename(f))); } catch { /* ignore */ }
  }
  res.json({ ok: true });
});

app.use('/api/posts', postsRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/engagement', engagementRouter);
app.use('/api/finance', financeRouter);
app.use('/webhooks', webhooksRouter);

app.use('/api', (req, res) => res.status(404).json({ error: 'נתיב API לא קיים' }));

// Serve the built React app (frontend/dist) from the same port.
const DIST = path.join(BACKEND_DIR, '..', 'frontend', 'dist');
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get(/^\/(?!api|media|webhooks).*/, (req, res) => res.sendFile(path.join(DIST, 'index.html')));
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error('[api]', err);
  res.status(err.status ?? 500).json({ error: err.message ?? 'שגיאת שרת' });
});

const PORT = Number(env('PORT', '4000'));
app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Bari (בריא) is running:  http://localhost:${PORT}\n`);
  console.log(`  Claude: ${claudeConfigured() ? 'connected' : 'demo'} | Images: ${imagesConfigured() ? 'connected' : 'demo'} | Facebook: ${metaConfigured() ? 'connected' : 'simulation'} | Instagram: ${igConfigured() ? 'connected' : 'simulation'}`);
  if (!fs.existsSync(DIST)) console.log('  (frontend not built yet - run setup.bat, or dev.bat for hot-reload on :5173)');
  startScheduler();
});
