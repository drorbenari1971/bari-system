// SQLite database (file: backend/data/bari.db) using Node's built-in node:sqlite
// - no native compilation needed.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BACKEND_DIR } from './config.js';

export const DATA_DIR = path.join(BACKEND_DIR, 'data');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'bari.db'));

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

db.exec(`
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'todo',      -- todo | in_progress | done
  priority    TEXT NOT NULL DEFAULT 'medium',    -- low | medium | high
  due_date    TEXT,
  is_demo     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT ${NOW},
  updated_at  TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE IF NOT EXISTS posts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  product      TEXT NOT NULL,                    -- bone_broth | chicken_broth | ghee | tallow
  tone         TEXT NOT NULL,                    -- educational | sales | storytelling
  headline     TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  cta          TEXT NOT NULL DEFAULT '',
  hashtags     TEXT NOT NULL DEFAULT '[]',       -- JSON array
  image_prompt TEXT NOT NULL DEFAULT '',
  image_feed   TEXT,                             -- /media/... (1:1)
  image_story  TEXT,                             -- /media/... (9:16)
  status       TEXT NOT NULL DEFAULT 'draft',    -- draft | scheduled | publishing | published | failed
  platforms    TEXT NOT NULL DEFAULT '["facebook","instagram"]',
  scheduled_at TEXT,                             -- ISO-8601 UTC
  published_at TEXT,
  fb_post_id   TEXT,
  ig_media_id  TEXT,
  ig_story_id  TEXT,
  publish_log  TEXT NOT NULL DEFAULT '[]',       -- JSON array of strings
  is_demo      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT ${NOW},
  updated_at   TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status, scheduled_at);

-- One row per sync snapshot -> keeps history for trend charts
CREATE TABLE IF NOT EXISTS post_metrics (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id     INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  platform    TEXT NOT NULL,                     -- facebook | instagram
  reach       INTEGER NOT NULL DEFAULT 0,
  likes       INTEGER NOT NULL DEFAULT 0,
  comments    INTEGER NOT NULL DEFAULT 0,
  shares      INTEGER NOT NULL DEFAULT 0,
  captured_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX IF NOT EXISTS idx_metrics_post ON post_metrics(post_id, platform);

CREATE TABLE IF NOT EXISTS comments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id      TEXT NOT NULL UNIQUE,
  platform         TEXT NOT NULL,
  post_id          INTEGER REFERENCES posts(id) ON DELETE SET NULL,
  external_post_id TEXT,
  author           TEXT NOT NULL DEFAULT '',
  message          TEXT NOT NULL DEFAULT '',
  created_time     TEXT NOT NULL DEFAULT ${NOW},
  is_read          INTEGER NOT NULL DEFAULT 0,
  replied          INTEGER NOT NULL DEFAULT 0,
  is_demo          INTEGER NOT NULL DEFAULT 0,
  fetched_at       TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE IF NOT EXISTS comment_replies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id  INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  message     TEXT NOT NULL,
  external_id TEXT,
  status      TEXT NOT NULL DEFAULT 'sent',      -- sent | simulated | failed
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT ${NOW}
);

-- Finance: income and expenses. Money is stored in agorot (integers) to keep sums exact.
CREATE TABLE IF NOT EXISTS transactions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
  date          TEXT NOT NULL,                   -- YYYY-MM-DD
  category      TEXT NOT NULL,                   -- income: product or classification; expense: expense type
  subcategory   TEXT NOT NULL DEFAULT '',        -- expense classification (optional)
  amount_agorot INTEGER NOT NULL CHECK (amount_agorot > 0),
  is_demo       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT ${NOW},
  updated_at    TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);

CREATE TABLE IF NOT EXISTS insights (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  summary    TEXT NOT NULL DEFAULT '',
  bullets    TEXT NOT NULL DEFAULT '[]',         -- JSON array of {title, detail}
  is_demo    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
`);

export const nowIso = () => new Date().toISOString();

const parseJson = (s, fallback) => {
  try { return JSON.parse(s); } catch { return fallback; }
};

export function hydratePost(row) {
  if (!row) return null;
  return {
    ...row,
    hashtags: parseJson(row.hashtags, []),
    platforms: parseJson(row.platforms, []),
    publish_log: parseJson(row.publish_log, []),
    is_demo: !!row.is_demo,
  };
}

export const getPost = (id) => hydratePost(db.prepare('SELECT * FROM posts WHERE id = ?').get(id));

export function updatePost(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return getPost(id);
  const values = keys.map((k) => {
    const v = fields[k];
    return Array.isArray(v) || (v && typeof v === 'object') ? JSON.stringify(v) : v;
  });
  db.prepare(`UPDATE posts SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...values, nowIso(), id);
  return getPost(id);
}

export function appendPublishLog(id, line) {
  const post = getPost(id);
  if (!post) return;
  const stamp = new Date().toLocaleString('he-IL');
  updatePost(id, { publish_log: [...post.publish_log, `[${stamp}] ${line}`] });
}

// Latest metric snapshot per post+platform, folded into per-post totals.
export function latestMetricsByPost() {
  const rows = db.prepare(`
    SELECT m.* FROM post_metrics m
    JOIN (SELECT post_id, platform, MAX(id) AS mid FROM post_metrics GROUP BY post_id, platform) x
      ON m.id = x.mid
  `).all();
  const map = new Map();
  for (const r of rows) {
    const cur = map.get(r.post_id) ?? { reach: 0, likes: 0, comments: 0, shares: 0, byPlatform: {} };
    cur.reach += r.reach; cur.likes += r.likes; cur.comments += r.comments; cur.shares += r.shares;
    cur.byPlatform[r.platform] = { reach: r.reach, likes: r.likes, comments: r.comments, shares: r.shares };
    map.set(r.post_id, cur);
  }
  return map;
}

export function insertMetric(postId, platform, m) {
  db.prepare('INSERT INTO post_metrics (post_id, platform, reach, likes, comments, shares, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(postId, platform, m.reach | 0, m.likes | 0, m.comments | 0, m.shares | 0, m.captured_at ?? nowIso());
}

// Insert or ignore a comment pulled from Meta (or a webhook). Returns true if new.
export function upsertComment(c) {
  const res = db.prepare(`
    INSERT OR IGNORE INTO comments (external_id, platform, post_id, external_post_id, author, message, created_time, is_demo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(c.external_id, c.platform, c.post_id ?? null, c.external_post_id ?? null, c.author ?? '', c.message ?? '',
    c.created_time ?? nowIso(), c.is_demo ? 1 : 0);
  return res.changes > 0;
}
