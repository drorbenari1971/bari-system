// Meta webhooks: real-time comments from the Facebook Page (field "feed")
// and Instagram (field "comments"). Requires a public URL configured in the Meta app; not used by default (the app has no login).
import { Router } from 'express';
import crypto from 'node:crypto';
import { db, upsertComment } from '../db.js';
import { env } from '../config.js';

const router = Router();

router.get('/meta', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === env('META_WEBHOOK_VERIFY_TOKEN')) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

router.post('/meta', (req, res) => {
  const secret = env('META_APP_SECRET');
  if (secret) {
    const sig = req.get('x-hub-signature-256') ?? '';
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody ?? '').digest('hex');
    const ok = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    if (!ok) return res.sendStatus(401);
  }

  const findPost = db.prepare('SELECT id FROM posts WHERE fb_post_id = ? OR ig_media_id = ?');
  for (const entry of req.body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      if (req.body.object === 'page' && change.field === 'feed' && v.item === 'comment' && v.verb === 'add') {
        upsertComment({
          external_id: v.comment_id,
          platform: 'facebook',
          external_post_id: v.post_id,
          post_id: findPost.get(v.post_id, v.post_id)?.id,
          author: v.from?.name ?? 'משתמש פייסבוק',
          message: v.message ?? '',
          created_time: v.created_time ? new Date(v.created_time * 1000).toISOString() : undefined,
        });
      }
      if (req.body.object === 'instagram' && change.field === 'comments') {
        upsertComment({
          external_id: v.id,
          platform: 'instagram',
          external_post_id: v.media?.id,
          post_id: v.media?.id ? findPost.get(v.media.id, v.media.id)?.id : null,
          author: v.from?.username ?? 'משתמש אינסטגרם',
          message: v.text ?? '',
        });
      }
    }
  }
  res.sendStatus(200);
});

export default router;
