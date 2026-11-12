// Automatic lead collection: runs Apify with the saved search words, keeps only posts that are
// not in Airtable yet, writes the new accounts and posts to Airtable, then syncs the system.
import { db, nowIso } from './db.js';
import { env } from './config.js';
import * as airtable from './services/airtable.js';
import * as apify from './services/apify.js';
import { claudeConfigured, classifyLead } from './services/claude.js';
import { syncLeads, getSearchTerms, getState, setState } from './routes/leads.js';

const { ACCOUNT_FIELDS: A, POST_FIELDS: P } = airtable;

let running = null;
export const collectionRunning = () => !!running;
export const lastCollection = () => { try { return JSON.parse(getState('last_collection') ?? 'null'); } catch { return null; } };

// One collection at a time; a second call while one runs gets the same result.
export function collectLeads() {
  running ??= doCollect().finally(() => { running = null; });
  return running;
}

const summarize = (text) => {
  const line = String(text).split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > 80 ? `${line.slice(0, 79)}…` : line || '(ללא טקסט)';
};
const hashtagChoice = (term) => `#${term.trim().replace(/\s+/g, '_')}`;
const withoutEmpty = (fields) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== ''));

async function runSources(terms, sources, errors) {
  const s = apify.settings();
  const found = [];
  let costUsd = 0;
  if (terms.instagram.length) {
    try {
      const r = await apify.runActor(apify.INSTAGRAM_ACTOR, {
        addParentData: false,
        directUrls: terms.instagram.map((t) => `https://www.instagram.com/explore/tags/${t}/`),
        resultsLimit: s.instagramPerTag,
        resultsType: 'posts',
        searchType: 'hashtag',
      });
      const items = r.items.map((i) => apify.fromInstagram(i, terms.instagram)).filter(Boolean);
      found.push(...items);
      costUsd += r.costUsd;
      sources.push({ platform: 'אינסטגרם', term: terms.instagram.map((t) => `#${t}`).join(' '), status: r.status, results: r.items.length, relevant: items.length, costUsd: r.costUsd });
    } catch (err) { errors.push(`אינסטגרם: ${err.message}`); }
  }
  for (const [i, term] of terms.facebook.entries()) {
    try {
      const r = await apify.runActor(apify.FACEBOOK_ACTOR, { query: term, resultsCount: s.facebookPerTerm, searchType: 'latest' });
      const items = r.items.map((x) => apify.fromFacebook(x, term)).filter(Boolean);
      found.push(...items);
      costUsd += r.costUsd;
      sources.push({ platform: 'פייסבוק', term, status: r.status, results: r.items.length, relevant: items.length, costUsd: r.costUsd });
    } catch (err) {
      errors.push(`פייסבוק "${term}": ${err.message}`);
      // A rate limit applies to the remaining words too: skip them instead of starting runs that will fail.
      if (/rate limit|upgrade your plan/i.test(err.message) && i < terms.facebook.length - 1) {
        errors.push(`פייסבוק: ${terms.facebook.length - i - 1} מילים נוספות דולגו בגלל המגבלה`);
        break;
      }
    }
  }
  return { found, costUsd };
}

function findExisting(leads, group) {
  const { account, platform } = group;
  if (platform === 'אינסטגרם') {
    return leads.find((l) => l.handle.toLowerCase() === account.handle.toLowerCase() && (!l.platforms || l.platforms.includes('אינסטגרם')));
  }
  const fb = apify.normalizeUrl(account.facebookUrl);
  return leads.find((l) => (fb && apify.normalizeUrl(l.facebook_url) === fb)
    || (l.platforms.includes('פייסבוק') && l.handle.toLowerCase() === account.handle.toLowerCase()));
}

async function doCollect() {
  if (!apify.apifyConfigured()) return { skipped: true, reason: 'Apify לא מחובר (חסר APIFY_TOKEN)' };
  if (!airtable.airtableConfigured()) return { skipped: true, reason: 'Airtable לא מחובר' };

  const startedAt = nowIso();
  const terms = getSearchTerms();
  const sources = [];
  const errors = [];
  let result;
  try {
    const before = await syncLeads();
    if (!before.ok) throw new Error(before.error ?? 'הסנכרון עם Airtable נכשל');

    const { found, costUsd } = await runSources(terms, sources, errors);

    // Keep only posts that are neither in Airtable nor repeated in this batch.
    const known = new Set(db.prepare('SELECT url FROM lead_posts').all().map((p) => apify.normalizeUrl(p.url)));
    const groups = new Map();
    let alreadyKnown = 0;
    for (const f of found) {
      const url = apify.normalizeUrl(f.post.url);
      if (known.has(url)) { alreadyKnown++; continue; }
      known.add(url);
      const g = groups.get(f.account.key) ?? { platform: f.platform, account: f.account, posts: [] };
      g.posts.push({ ...f.post, term: f.term });
      groups.set(f.account.key, g);
    }

    const leads = db.prepare('SELECT * FROM leads').all();
    let classified = 0;
    for (const g of groups.values()) {
      g.existing = findExisting(leads, g);
      if (!g.existing && claudeConfigured()) {
        try {
          g.cls = await classifyLead({ platform: g.platform, handle: g.account.handle, displayName: g.account.displayName, posts: g.posts });
          classified++;
        } catch (err) { errors.push(`סיווג ${g.account.handle}: ${err.message}`); }
      }
    }

    const today = new Date().toLocaleDateString('he-IL');
    const fresh = [...groups.values()].filter((g) => !g.existing);
    const ids = await airtable.createRecords(env('AIRTABLE_ACCOUNTS_TABLE'), fresh.map((g) => withoutEmpty({
      [A.handle]: g.account.handle,
      [A.displayName]: g.account.displayName,
      [A.platforms]: [g.platform],
      [A.profileUrl]: g.account.profileUrl,
      [A.facebookUrl]: g.account.facebookUrl,
      [A.status]: 'לא נוצר קשר',
      [A.actorType]: g.cls?.actor_type,
      [A.potential]: g.cls?.potential,
      [A.priority]: g.cls?.priority,
      [A.approach]: g.cls?.approach,
      [A.notes]: `נוסף אוטומטית מאיסוף Apify ב-${today}, לפי "${[...new Set(g.posts.map((p) => p.term))].join('", "')}".${g.cls ? '' : ' ממתין לסיווג.'}`,
    })));
    fresh.forEach((g, i) => { g.recordId = ids[i]; });

    // An existing account found on a second network gets that network added.
    for (const g of groups.values()) {
      if (!g.existing) continue;
      g.recordId = g.existing.airtable_id;
      const platforms = g.existing.platforms ? g.existing.platforms.split(',') : [];
      if (!platforms.includes(g.platform)) {
        await airtable.updateAccountFields(g.recordId, { [A.platforms]: [...platforms, g.platform] });
        platforms.push(g.platform);
        g.existing.platforms = platforms.join(',');
      }
    }

    const postFields = [...groups.values()].flatMap((g) => g.posts.map((p, i) => withoutEmpty({
      [P.summary]: g.cls?.posts?.[i]?.summary || summarize(p.text),
      [P.account]: [g.recordId],
      [P.hashtag]: hashtagChoice(p.term),
      [P.contentType]: g.cls?.posts?.[i]?.content_type,
      [P.likes]: p.likes,
      [P.comments]: p.comments,
      [P.date]: p.date,
      [P.format]: p.format,
      [P.url]: p.url,
      [P.platform]: g.platform,
    })));
    await airtable.createRecords(env('AIRTABLE_POSTS_TABLE'), postFields);

    const after = await syncLeads();
    if (!after.ok) errors.push(`סנכרון אחרי האיסוף: ${after.error}`);
    result = {
      ok: true, startedAt, finishedAt: nowIso(), costUsd: Math.round(costUsd * 100) / 100,
      newAccounts: fresh.length, newPosts: postFields.length, alreadyKnown, classified, sources, errors,
    };
  } catch (err) {
    result = { ok: false, startedAt, finishedAt: nowIso(), error: err.message, sources, errors };
  }
  setState('last_collection', JSON.stringify(result));
  return result;
}
