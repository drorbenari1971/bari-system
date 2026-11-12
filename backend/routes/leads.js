import { Router } from 'express';
import { db, nowIso } from '../db.js';
import { env } from '../config.js';
import * as airtable from '../services/airtable.js';
import * as apify from '../services/apify.js';
import { LEAD_CHOICES } from '../services/claude.js';

const router = Router();
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
const { ACCOUNT_FIELDS: A, POST_FIELDS: P } = airtable;

export const getState = (key) => db.prepare('SELECT value FROM app_state WHERE key = ?').get(key)?.value ?? null;
export const setState =(key, value) => db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

let running = null;

// 1) push local status changes that were not saved yet, 2) pull everything from Airtable.
// Runs one at a time; a second call while one runs waits for the same result.
export function syncLeads() {
  running ??= doSync().finally(() => { running = null; });
  return running;
}

async function doSync() {
  if (!airtable.airtableConfigured()) return { skipped: true, reason: 'Airtable לא מחובר' };
  const errors = [];

  let pushed = 0;
  for (const lead of db.prepare('SELECT airtable_id, status FROM leads WHERE status_pending = 1').all()) {
    try {
      await airtable.updateStatus(lead.airtable_id, lead.status);
      db.prepare('UPDATE leads SET status_pending = 0 WHERE airtable_id = ?').run(lead.airtable_id);
      pushed++;
    } catch (err) { errors.push(err.message); }
  }

  let accounts;
  let posts;
  try {
    [accounts, posts] = await Promise.all([
      airtable.listAll(env('AIRTABLE_ACCOUNTS_TABLE')),
      airtable.listAll(env('AIRTABLE_POSTS_TABLE')),
    ]);
  } catch (err) {
    setState('leads_sync_error', err.message);
    return { skipped: false, ok: false, error: err.message, pushed, errors };
  }

  const upsertLead = db.prepare(`
    INSERT INTO leads (airtable_id, handle, display_name, actor_type, profile_url, notes, potential, priority, approach, status,
                       post_count, total_likes, avg_engagement, synced_at, platforms, facebook_url, phone, email)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(airtable_id) DO UPDATE SET
      handle = excluded.handle, display_name = excluded.display_name, actor_type = excluded.actor_type,
      profile_url = excluded.profile_url, notes = excluded.notes, potential = excluded.potential,
      platforms = excluded.platforms, facebook_url = excluded.facebook_url, phone = excluded.phone, email = excluded.email,
      priority = excluded.priority, approach = excluded.approach,
      status = CASE WHEN leads.status_pending = 1 THEN leads.status ELSE excluded.status END,
      post_count = excluded.post_count, total_likes = excluded.total_likes,
      avg_engagement = excluded.avg_engagement, synced_at = excluded.synced_at
  `);
  const insertPost = db.prepare(`
    INSERT INTO lead_posts (airtable_id, lead_id, summary, hashtag, content_type, format, likes, comments, engagement, date, url, platform)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = nowIso();
  const keep = new Set(accounts.map((r) => r.id));

  db.exec('BEGIN');
  try {
    for (const r of accounts) {
      const f = r.fields ?? {};
      upsertLead.run(r.id, airtable.text(f[A.handle]), airtable.text(f[A.displayName]), airtable.text(f[A.actorType]),
        airtable.text(f[A.profileUrl]), airtable.text(f[A.notes]), airtable.text(f[A.potential]), airtable.text(f[A.priority]),
        airtable.text(f[A.approach]), airtable.text(f[A.status]), airtable.num(f[A.postCount]), airtable.num(f[A.totalLikes]),
        airtable.num(f[A.avgEngagement]), now, airtable.names(f[A.platforms]), airtable.text(f[A.facebookUrl]),
        airtable.text(f[A.phone]), airtable.text(f[A.email]));
    }
    // Accounts deleted in Airtable are removed here too.
    for (const { airtable_id: id } of db.prepare('SELECT airtable_id FROM leads').all()) {
      if (!keep.has(id)) db.prepare('DELETE FROM leads WHERE airtable_id = ?').run(id);
    }
    db.exec('DELETE FROM lead_posts');
    for (const r of posts) {
      const f = r.fields ?? {};
      insertPost.run(r.id, airtable.linkIds(f[P.account])[0] ?? null, airtable.text(f[P.summary]), airtable.text(f[P.hashtag]),
        airtable.text(f[P.contentType]), airtable.text(f[P.format]), airtable.num(f[P.likes]), airtable.num(f[P.comments]),
        airtable.num(f[P.engagement]), airtable.text(f[P.date]) || null, airtable.text(f[P.url]), airtable.text(f[P.platform]));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  setState('leads_synced_at', now);
  setState('leads_sync_error', errors.length ? errors[errors.length - 1] : '');
  return { skipped: false, ok: true, accounts: accounts.length, posts: posts.length, pushed, errors };
}

router.get('/', wrap(async (req, res) => {
  const posts = db.prepare('SELECT * FROM lead_posts ORDER BY date DESC').all();
  const byLead = new Map();
  for (const p of posts) byLead.set(p.lead_id, [...(byLead.get(p.lead_id) ?? []), p]);
  const leads = db.prepare("SELECT * FROM leads ORDER BY priority = '', priority, avg_engagement DESC").all()
    .map((l) => ({ ...l, status_pending: !!l.status_pending, posts: byLead.get(l.airtable_id) ?? [] }));
  const collect = await import('../collect.js'); // loaded here: collect.js imports this file
  res.json({
    configured: airtable.airtableConfigured(),
    syncedAt: getState('leads_synced_at'),
    syncError: getState('leads_sync_error') || null,
    statuses: airtable.STATUS_CHOICES,
    choices: classificationChoices(),
    collection: {
      configured: apify.apifyConfigured(),
      running: collect.collectionRunning(),
      last: collect.lastCollection(),
      estimateUsd: apify.estimateUsd(getSearchTerms()),
      everyHours: 6,
    },
    leads,
  });
}));

router.post('/sync', wrap(async (req, res) => res.json(await syncLeads())));

// Starts a collection and returns right away (it takes a few minutes); the screen polls GET /.
router.post('/collect', wrap(async (req, res) => {
  if (!apify.apifyConfigured()) return res.status(400).json({ error: 'Apify לא מחובר. הוסיפו APIFY_TOKEN לקובץ backend\\.env' });
  if (!airtable.airtableConfigured()) return res.status(400).json({ error: 'Airtable לא מחובר' });
  const { collectLeads } = await import('../collect.js');
  collectLeads().catch((err) => console.error('[collect]', err));
  res.json({ started: true });
}));

// ---- search words per platform (used by the Apify collection) ----

// The words used in the Apify runs so far: Instagram hashtags, and Facebook post searches.
export const DEFAULT_SEARCH_TERMS = {
  instagram: ['ציר_עצמות', 'גהי', 'טאלו'],
  facebook: ['ציר עצמות', 'גהי', 'טאלו', 'קיטו', 'פליאו', 'ציר עצמות של בריא'],
};
const MAX_TERMS = 20;
const MAX_TERM_LENGTH = 40;

export function getSearchTerms() {
  try {
    return { ...DEFAULT_SEARCH_TERMS, ...JSON.parse(getState('lead_search_terms') ?? '{}') };
  } catch {
    return DEFAULT_SEARCH_TERMS;
  }
}

function cleanTerms(list, platform) {
  if (!Array.isArray(list)) return { error: 'רשימה לא תקינה' };
  // Instagram hashtags have no spaces or '#': "ציר עצמות" becomes "ציר_עצמות".
  const clean = list.map((t) => String(t ?? '').trim().replace(/^#+/, ''))
    .map((t) => (platform === 'instagram' ? t.replace(/\s+/g, '_') : t.replace(/\s+/g, ' ')))
    .filter(Boolean);
  if (clean.some((t) => t.length > MAX_TERM_LENGTH)) return { error: `עד ${MAX_TERM_LENGTH} תווים למילה` };
  const unique = [...new Set(clean)];
  if (unique.length > MAX_TERMS) return { error: `עד ${MAX_TERMS} מילים לכל פלטפורמה` };
  return { terms: unique };
}

router.get('/search-terms', (req, res) => res.json(getSearchTerms()));

router.put('/search-terms', (req, res) => {
  const next = {};
  for (const platform of Object.keys(DEFAULT_SEARCH_TERMS)) {
    const r = cleanTerms(req.body[platform], platform);
    if (r.error) return res.status(400).json({ error: r.error });
    next[platform] = r.terms;
  }
  setState('lead_search_terms', JSON.stringify(next));
  res.json(next);
});

// ---- editing a classification: priority, potential, actor type ----

const CLEARABLE = { actor_type: A.actorType, potential: A.potential, priority: A.priority };
const CHOICE_KEYS = { actor_type: 'actorType', potential: 'potential', priority: 'priority' };

// The Airtable choices known to the system, plus any value already used in the data
// (e.g. "שגריר/ה של בריא", added in Airtable).
export function classificationChoices() {
  return Object.fromEntries(Object.entries(CHOICE_KEYS).map(([field, key]) => {
    const used = db.prepare(`SELECT DISTINCT ${field} AS v FROM leads WHERE ${field} != ''`).all().map((r) => r.v);
    return [field, [...new Set([...LEAD_CHOICES[key], ...used])].sort()];
  }));
}

// Saves in Airtable first, so the next sync keeps it; only then here. An empty value clears the field.
// Limited to these three names so PUT /:id/status still reaches its own route below.
router.put('/:id/:field(actor_type|potential|priority)', wrap(async (req, res) => {
  const field = req.params.field;
  const fieldId = CLEARABLE[field];
  if (!fieldId) return res.status(400).json({ error: 'אי אפשר לערוך את השדה הזה' });
  const lead = db.prepare('SELECT * FROM leads WHERE airtable_id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'הליד לא נמצא' });
  const value = String(req.body.value ?? '').trim();
  if (value && !classificationChoices()[field].includes(value)) return res.status(400).json({ error: 'ערך לא מוכר. ערך חדש מוסיפים ב-Airtable.' });
  if (!airtable.airtableConfigured()) return res.status(400).json({ error: 'Airtable לא מחובר' });
  await airtable.updateAccountFields(lead.airtable_id, { [fieldId]: value || null });
  db.prepare(`UPDATE leads SET ${field} = ? WHERE airtable_id = ?`).run(value, lead.airtable_id);
  const updated = db.prepare('SELECT * FROM leads WHERE airtable_id = ?').get(lead.airtable_id);
  res.json({ lead: { ...updated, status_pending: !!updated.status_pending } });
}));

// ---- clearing a classification (e.g. "שגריר/ה של בריא") ----

// Clears it in Airtable first, so the next sync doesn't bring it back; only then here.
router.delete('/:id/:field', wrap(async (req, res) => {
  const fieldId = CLEARABLE[req.params.field];
  if (!fieldId) return res.status(400).json({ error: 'אי אפשר להסיר את השדה הזה' });
  const lead = db.prepare('SELECT * FROM leads WHERE airtable_id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'הליד לא נמצא' });
  if (!airtable.airtableConfigured()) return res.status(400).json({ error: 'Airtable לא מחובר' });
  await airtable.updateAccountFields(lead.airtable_id, { [fieldId]: null });
  db.prepare(`UPDATE leads SET ${req.params.field} = '' WHERE airtable_id = ?`).run(lead.airtable_id);
  const updated = db.prepare('SELECT * FROM leads WHERE airtable_id = ?').get(lead.airtable_id);
  res.json({ lead: { ...updated, status_pending: !!updated.status_pending } });
}));

// Saves the status locally right away, then writes it to Airtable. If Airtable can't be
// reached, the change stays marked as pending and is sent again on the next sync.
router.put('/:id/status', wrap(async (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE airtable_id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'הליד לא נמצא' });
  const { status } = req.body;
  if (!airtable.STATUS_CHOICES.includes(status)) return res.status(400).json({ error: 'סטטוס לא חוקי' });

  db.prepare('UPDATE leads SET status = ?, status_pending = 1 WHERE airtable_id = ?').run(status, lead.airtable_id);
  let warning = null;
  if (!airtable.airtableConfigured()) {
    warning = 'Airtable לא מחובר, הסטטוס נשמר רק כאן.';
  } else {
    try {
      await airtable.updateStatus(lead.airtable_id, status);
      db.prepare('UPDATE leads SET status_pending = 0 WHERE airtable_id = ?').run(lead.airtable_id);
    } catch (err) {
      warning = `הסטטוס נשמר כאן, אבל עדיין לא ב-Airtable. ננסה שוב בסנכרון הבא. (${err.message})`;
    }
  }
  const updated = db.prepare('SELECT * FROM leads WHERE airtable_id = ?').get(lead.airtable_id);
  res.json({ lead: { ...updated, status_pending: !!updated.status_pending }, warning });
}));

export default router;
