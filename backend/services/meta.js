// Meta Graph API: publish to Facebook Page + Instagram (feed & story), read metrics,
// read comments and reply to them.
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config.js';
import { MEDIA_DIR } from '../db.js';
import { cloudinaryConfigured, uploadImage } from './storage.js';

const base = () => `https://graph.facebook.com/${env('META_GRAPH_VERSION', 'v21.0')}`;
const token = () => env('META_PAGE_ACCESS_TOKEN');

export const metaConfigured = () => !!(env('META_PAGE_ID') && token());
export const igConfigured = () => metaConfigured() && !!env('META_IG_USER_ID');

async function graph(method, endpoint, params = {}) {
  const url = new URL(`${base()}/${endpoint}`);
  let body;
  if (method === 'GET') {
    for (const [k, v] of Object.entries({ ...params, access_token: token() })) url.searchParams.set(k, v);
  } else if (params instanceof FormData) {
    params.append('access_token', token());
    body = params;
  } else {
    body = new URLSearchParams({ ...params, access_token: token() });
  }
  const res = await fetch(url, { method, body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error?.message ?? `Graph API ${res.status}`);
  return json;
}

export function buildCaption(post) {
  return [post.headline, post.body, post.cta, (post.hashtags ?? []).join(' ')].filter(Boolean).join('\n\n');
}

const isRaster = (mediaPath) => !!mediaPath && /\.(png|jpe?g)$/i.test(mediaPath);
const localFile = (mediaPath) => path.join(MEDIA_DIR, path.basename(mediaPath));

// Publishes to the platforms selected on the post. Never throws: returns ids + log lines.
export async function publishPost(post) {
  const caption = buildCaption(post);
  const out = { fb_post_id: null, ig_media_id: null, ig_story_id: null, log: [] };
  const wants = new Set(post.platforms ?? []);

  if (wants.has('facebook')) {
    try {
      if (isRaster(post.image_feed)) {
        const form = new FormData();
        const buf = fs.readFileSync(localFile(post.image_feed));
        form.append('source', new Blob([buf], { type: 'image/png' }), path.basename(post.image_feed));
        form.append('message', caption);
        const r = await graph('POST', `${env('META_PAGE_ID')}/photos`, form);
        out.fb_post_id = r.post_id ?? r.id;
      } else {
        const r = await graph('POST', `${env('META_PAGE_ID')}/feed`, { message: caption });
        out.fb_post_id = r.id;
        out.log.push('פייסבוק: פורסם כטקסט בלבד (אין תמונה אמיתית מצורפת).');
      }
      out.log.push(`פייסבוק: פורסם בהצלחה (${out.fb_post_id}).`);
    } catch (err) {
      out.log.push(`פייסבוק: שגיאה – ${err.message}`);
    }
  }

  if (wants.has('instagram')) {
    if (!igConfigured()) {
      out.log.push('אינסטגרם: דילוג – META_IG_USER_ID לא מוגדר.');
    } else if (!cloudinaryConfigured()) {
      out.log.push('אינסטגרם: דילוג – נדרש חיבור ל-Cloudinary לאחסון התמונות (CLOUDINARY_* בקובץ .env).');
    } else {
      if (isRaster(post.image_feed)) {
        try {
          out.ig_media_id = await igPublish({ image_url: await uploadImage(post.image_feed), caption });
          out.log.push(`אינסטגרם פיד: פורסם (${out.ig_media_id}).`);
        } catch (err) {
          out.log.push(`אינסטגרם פיד: שגיאה – ${err.message}`);
        }
      } else {
        out.log.push('אינסטגרם פיד: דילוג – אינסטגרם דורש תמונה (PNG/JPG).');
      }
      if (isRaster(post.image_story)) {
        try {
          out.ig_story_id = await igPublish({ image_url: await uploadImage(post.image_story), media_type: 'STORIES' });
          out.log.push(`אינסטגרם סטורי: פורסם (${out.ig_story_id}).`);
        } catch (err) {
          out.log.push(`אינסטגרם סטורי: שגיאה – ${err.message}`);
        }
      }
    }
  }
  return out;
}

async function igPublish(params) {
  const igUser = env('META_IG_USER_ID');
  const container = await graph('POST', `${igUser}/media`, params);
  // Wait for the media container to finish processing (usually seconds for images).
  for (let i = 0; i < 15; i++) {
    const s = await graph('GET', container.id, { fields: 'status_code' });
    if (s.status_code === 'FINISHED') break;
    if (s.status_code === 'ERROR') throw new Error('עיבוד המדיה באינסטגרם נכשל');
    await new Promise((r) => setTimeout(r, 2000));
  }
  const published = await graph('POST', `${igUser}/media_publish`, { creation_id: container.id });
  return published.id;
}

// ---------- metrics ----------

export async function fetchFacebookMetrics(fbPostId) {
  const r = await graph('GET', fbPostId, {
    fields: 'shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)',
  });
  let reach = 0;
  try {
    const ins = await graph('GET', `${fbPostId}/insights`, { metric: 'post_impressions_unique' });
    reach = ins.data?.[0]?.values?.[0]?.value ?? 0;
  } catch { /* insights need read_insights permission; keep 0 */ }
  return {
    reach,
    likes: r.reactions?.summary?.total_count ?? 0,
    comments: r.comments?.summary?.total_count ?? 0,
    shares: r.shares?.count ?? 0,
  };
}

export async function fetchInstagramMetrics(mediaId) {
  const r = await graph('GET', `${mediaId}/insights`, { metric: 'reach,likes,comments,shares' });
  const val = (name) => {
    const m = r.data?.find((d) => d.name === name);
    return m?.values?.[0]?.value ?? m?.total_value?.value ?? 0;
  };
  return { reach: val('reach'), likes: val('likes'), comments: val('comments'), shares: val('shares') };
}

// ---------- comments ----------

export async function fetchFacebookComments(fbPostId) {
  const r = await graph('GET', `${fbPostId}/comments`, {
    fields: 'id,message,from,created_time',
    order: 'reverse_chronological',
    limit: '50',
  });
  return (r.data ?? []).map((c) => ({
    external_id: c.id,
    platform: 'facebook',
    external_post_id: fbPostId,
    author: c.from?.name ?? 'משתמש פייסבוק',
    message: c.message ?? '',
    created_time: c.created_time ? new Date(c.created_time).toISOString() : undefined,
  }));
}

export async function fetchInstagramComments(mediaId) {
  const r = await graph('GET', `${mediaId}/comments`, { fields: 'id,text,username,timestamp', limit: '50' });
  return (r.data ?? []).map((c) => ({
    external_id: c.id,
    platform: 'instagram',
    external_post_id: mediaId,
    author: c.username ?? 'משתמש אינסטגרם',
    message: c.text ?? '',
    created_time: c.timestamp ? new Date(c.timestamp).toISOString() : undefined,
  }));
}

export async function replyToComment(comment, message) {
  if (comment.platform === 'instagram') {
    return (await graph('POST', `${comment.external_id}/replies`, { message })).id;
  }
  return (await graph('POST', `${comment.external_id}/comments`, { message })).id;
}
