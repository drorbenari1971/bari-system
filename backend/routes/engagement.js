import { Router } from 'express';
import { db, getPost } from '../db.js';
import { isRemoteId } from '../constants.js';
import * as meta from '../services/meta.js';
import { suggestReply } from '../services/claude.js';
import { syncFromMeta } from '../scheduler.js';

const router = Router();
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

function withReplies(rows) {
  const stmt = db.prepare('SELECT * FROM comment_replies WHERE comment_id = ? ORDER BY id');
  return rows.map((c) => ({ ...c, is_demo: !!c.is_demo, is_read: !!c.is_read, replied: !!c.replied, replies: stmt.all(c.id) }));
}

router.get('/comments', (req, res) => {
  const { platform, filter, limit = 200 } = req.query;
  let sql = `SELECT c.*, p.headline AS post_headline, p.product AS post_product
             FROM comments c LEFT JOIN posts p ON p.id = c.post_id WHERE 1=1`;
  const args = [];
  if (platform) { sql += ' AND c.platform = ?'; args.push(platform); }
  if (filter === 'unanswered') sql += ' AND c.replied = 0';
  if (filter === 'unread') sql += ' AND c.is_read = 0';
  sql += ' ORDER BY c.created_time DESC LIMIT ?';
  args.push(Number(limit));
  res.json(withReplies(db.prepare(sql).all(...args)));
});

router.post('/sync', wrap(async (req, res) => res.json(await syncFromMeta())));

router.post('/comments/:id/read', (req, res) => {
  db.prepare('UPDATE comments SET is_read = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/comments/:id/suggest', wrap(async (req, res) => {
  const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id);
  if (!comment) return res.status(404).json({ error: 'תגובה לא נמצאה' });
  res.json(await suggestReply({ comment, post: comment.post_id ? getPost(comment.post_id) : null }));
}));

// Reply to a Facebook/Instagram comment through the Graph API.
router.post('/comments/:id/reply', wrap(async (req, res) => {
  const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id);
  if (!comment) return res.status(404).json({ error: 'תגובה לא נמצאה' });
  const message = String(req.body.message ?? '').trim();
  if (!message) return res.status(400).json({ error: 'אין טקסט לתגובה' });

  let status = 'sent';
  let externalId = null;
  let error = null;
  if (comment.is_demo || !isRemoteId(comment.external_id) || !meta.metaConfigured()) {
    status = 'simulated';
  } else {
    try {
      externalId = await meta.replyToComment(comment, message);
    } catch (err) {
      status = 'failed';
      error = err.message;
    }
  }
  db.prepare('INSERT INTO comment_replies (comment_id, message, external_id, status, error) VALUES (?, ?, ?, ?, ?)')
    .run(comment.id, message, externalId, status, error);
  if (status !== 'failed') db.prepare('UPDATE comments SET replied = 1, is_read = 1 WHERE id = ?').run(comment.id);
  if (status === 'failed') return res.status(502).json({ error: `שליחת התגובה נכשלה: ${error}` });
  res.json({ ok: true, status });
}));

export default router;
