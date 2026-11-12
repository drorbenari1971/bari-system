// Apify REST API: runs the scrapers used for the leads and returns their results, normalized.
// Same actors and inputs as the runs made by hand in the Apify console.
import { env } from '../config.js';

export const apifyConfigured = () => !!env('APIFY_TOKEN');

export const INSTAGRAM_ACTOR = 'apify~instagram-scraper';
export const FACEBOOK_ACTOR = 'TMBawM4LZpKN15DZX'; // "Facebook Posts Search" by Scraper One

const limit = (key, fallback) => Math.max(1, Math.min(200, Number(env(key)) || fallback));
export const settings = () => ({
  instagramPerTag: limit('APIFY_INSTAGRAM_RESULTS', 40),
  facebookPerTerm: limit('APIFY_FACEBOOK_RESULTS', 30),
  maxUsdPerRun: Number(env('APIFY_MAX_USD_PER_RUN')) || 1,
});

// Rough cost of one collection, from today's runs: ~$0.003 per Instagram post, ~$0.005 per Facebook post.
export function estimateUsd(terms) {
  const s = settings();
  const ig = terms.instagram.length ? terms.instagram.length * s.instagramPerTag * 0.003 : 0;
  const fb = terms.facebook.length * s.facebookPerTerm * 0.005;
  return Math.round((ig + fb) * 100) / 100;
}

const API = 'https://api.apify.com/v2';

async function request(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${env('APIFY_TOKEN')}`, 'Content-Type': 'application/json', ...init.headers },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(res.status === 401 || res.status === 403
      ? `Apify דחה את המפתח (${res.status}). בדקו את APIFY_TOKEN.`
      : `שגיאת Apify: ${json.error?.message ?? res.status}`);
  }
  return json;
}

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);

// Starts an actor, waits for it (up to ~15 minutes) and returns its dataset items and cost.
// maxTotalChargeUsd caps what a pay-per-result actor may charge for this run.
export async function runActor(actor, input, { pollSeconds = 60, maxPolls = 15 } = {}) {
  const started = await request(`/acts/${actor}/runs?maxTotalChargeUsd=${settings().maxUsdPerRun}`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  let run = started.data;
  for (let i = 0; i < maxPolls && !TERMINAL.has(run.status); i++) {
    run = (await request(`/actor-runs/${run.id}?waitForFinish=${pollSeconds}`)).data;
  }
  if (!TERMINAL.has(run.status)) throw new Error('ההרצה ב-Apify לא הסתיימה בזמן');
  const items = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await request(`/datasets/${run.defaultDatasetId}/items?clean=true&format=json&limit=1000&offset=${offset}`);
    items.push(...page);
    if (page.length < 1000) break;
  }
  // Some actors stop early with a message (e.g. their own rate limit) but still report SUCCEEDED.
  const limited = /rate limit|upgrade your plan|quota/i.test(run.statusMessage ?? '');
  if (!items.length && limited) throw new Error(`Apify: ${run.statusMessage}`);
  return { status: run.status, statusMessage: run.statusMessage ?? '', costUsd: Number(run.usageTotalUsd) || 0, items };
}

// ---------- normalizing results into { platform, account, post } ----------

export function normalizeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    u.hash = '';
    if (!/profile\.php|story\.php|permalink\.php/.test(u.pathname)) u.search = '';
    u.hostname = u.hostname.replace(/^(m|mobile|web)\./, 'www.');
    return u.toString().replace(/\/+$/, '').toLowerCase();
  } catch {
    return String(url).trim().replace(/\/+$/, '').toLowerCase();
  }
}

const day = (value) => {
  if (!value) return null;
  const d = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};
const count = (v) => (Number(v) > 0 ? Math.round(Number(v)) : 0);

export function fromInstagram(item, tags) {
  if (!item.ownerUsername || !item.url) return null;
  const fromInput = decodeURIComponent(String(item.inputUrl ?? '')).match(/tags\/([^/?#]+)/)?.[1];
  const tag = tags.find((t) => t === fromInput)
    ?? tags.find((t) => (item.hashtags ?? []).some((h) => String(h).replace(/^#/, '') === t))
    ?? fromInput ?? tags[0];
  return {
    platform: 'אינסטגרם',
    term: tag,
    account: {
      key: `ig:${item.ownerUsername.toLowerCase()}`,
      handle: item.ownerUsername,
      displayName: item.ownerFullName ?? '',
      profileUrl: `https://www.instagram.com/${item.ownerUsername}/`,
      facebookUrl: '',
    },
    post: {
      url: item.url,
      text: item.caption ?? '',
      likes: count(item.likesCount),
      comments: count(item.commentsCount),
      date: day(item.timestamp),
      format: { Image: 'תמונה', Sidecar: 'קרוסלה', Video: 'וידאו' }[item.type] ?? '',
    },
  };
}

export function fromFacebook(item, term) {
  const author = item.author ?? {};
  const profileUrl = author.profileUrl || author.url || '';
  if (!item.url || (!profileUrl && !author.name)) return null;
  const text = item.postText ?? item.text ?? '';
  // Keyword search also returns loosely related posts; keep only those that mention the term.
  if (!text.toLowerCase().includes(term.toLowerCase())) return null;
  const slug = (() => {
    try {
      const u = new URL(profileUrl);
      return /profile\.php/.test(u.pathname) ? '' : u.pathname.split('/').filter(Boolean)[0] ?? '';
    } catch { return ''; }
  })();
  const attachments = item.attachments ?? [];
  return {
    platform: 'פייסבוק',
    term,
    account: {
      key: profileUrl ? `fb:${normalizeUrl(profileUrl)}` : `fb:name:${author.name}`,
      handle: slug || author.name,
      displayName: author.name ?? '',
      profileUrl: '',
      facebookUrl: profileUrl,
    },
    post: {
      url: item.url,
      text,
      likes: count(item.reactionsCount),
      comments: count(item.commentsCount),
      date: day(item.timestamp),
      format: attachments.length > 1 ? 'קרוסלה' : /video/i.test(attachments[0]?.type ?? '') ? 'וידאו' : attachments.length ? 'תמונה' : '',
    },
  };
}
