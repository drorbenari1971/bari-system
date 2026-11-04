// Local cron jobs:
//  - every minute: publish posts whose scheduled_at has arrived
//  - every hour:   pull metrics + comments from Meta for published posts
import cron from 'node-cron';
import { db, getPost, hydratePost, updatePost, appendPublishLog, insertMetric, upsertComment, nowIso } from './db.js';
import { isRemoteId } from './constants.js';
import * as meta from './services/meta.js';

export async function publishNow(postId) {
  // Claim the post atomically so the cron tick and a manual click can't double-publish.
  const claim = db.prepare(
    "UPDATE posts SET status = 'publishing', updated_at = ? WHERE id = ? AND status IN ('draft','scheduled','failed')",
  ).run(nowIso(), postId);
  if (!claim.changes) throw new Error('הפוסט כבר מפורסם או בתהליך פרסום');

  const post = getPost(postId);
  try {
    if (!meta.metaConfigured() || post.is_demo) {
      updatePost(postId, {
        status: 'published',
        published_at: nowIso(),
        fb_post_id: post.platforms.includes('facebook') ? `sim_fb_${postId}` : null,
        ig_media_id: post.platforms.includes('instagram') ? `sim_ig_${postId}` : null,
      });
      appendPublishLog(postId, 'סימולציה: Meta API לא מוגדר – הפוסט סומן כמפורסם מקומית בלבד.');
      return getPost(postId);
    }

    const result = await meta.publishPost(post);
    const ok = !!(result.fb_post_id || result.ig_media_id || result.ig_story_id);
    updatePost(postId, {
      status: ok ? 'published' : 'failed',
      published_at: ok ? nowIso() : null,
      fb_post_id: result.fb_post_id,
      ig_media_id: result.ig_media_id,
      ig_story_id: result.ig_story_id,
    });
    for (const line of result.log) appendPublishLog(postId, line);
    return getPost(postId);
  } catch (err) {
    updatePost(postId, { status: 'failed' });
    appendPublishLog(postId, `שגיאה כללית: ${err.message}`);
    throw err;
  }
}

async function runDuePosts() {
  const due = db.prepare("SELECT id FROM posts WHERE status = 'scheduled' AND scheduled_at <= ?").all(nowIso());
  for (const { id } of due) {
    try {
      const p = await publishNow(id);
      console.log(`[scheduler] post #${id} -> ${p.status}`);
    } catch (err) {
      console.error(`[scheduler] post #${id} failed:`, err.message);
    }
  }
}

// Pulls fresh metrics and comments for every really-published post. Returns a summary.
export async function syncFromMeta() {
  if (!meta.metaConfigured()) return { skipped: true, reason: 'Meta API לא מוגדר', metrics: 0, newComments: 0 };

  const posts = db.prepare("SELECT * FROM posts WHERE status = 'published' AND is_demo = 0").all().map(hydratePost);
  let metrics = 0;
  let newComments = 0;
  const errors = [];

  for (const post of posts) {
    if (isRemoteId(post.fb_post_id)) {
      try {
        insertMetric(post.id, 'facebook', await meta.fetchFacebookMetrics(post.fb_post_id));
        metrics++;
        for (const c of await meta.fetchFacebookComments(post.fb_post_id)) {
          if (upsertComment({ ...c, post_id: post.id })) newComments++;
        }
      } catch (err) { errors.push(`FB #${post.id}: ${err.message}`); }
    }
    if (isRemoteId(post.ig_media_id)) {
      try {
        insertMetric(post.id, 'instagram', await meta.fetchInstagramMetrics(post.ig_media_id));
        metrics++;
        for (const c of await meta.fetchInstagramComments(post.ig_media_id)) {
          if (upsertComment({ ...c, post_id: post.id })) newComments++;
        }
      } catch (err) { errors.push(`IG #${post.id}: ${err.message}`); }
    }
  }
  return { skipped: false, posts: posts.length, metrics, newComments, errors };
}

export function startScheduler() {
  cron.schedule('* * * * *', () => runDuePosts().catch((e) => console.error('[scheduler]', e)));
  cron.schedule('7 * * * *', () =>
    syncFromMeta()
      .then((r) => !r.skipped && console.log(`[sync] metrics=${r.metrics} newComments=${r.newComments}`))
      .catch((e) => console.error('[sync]', e)));
  console.log('[scheduler] running: publish queue every minute, Meta sync hourly');
  runDuePosts().catch(() => {});
}
