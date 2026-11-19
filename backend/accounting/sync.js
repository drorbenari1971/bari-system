// Pull sync, entirely through the job queue, for each synced entity (customers, then documents):
//   <entity>_sync      opens a run and queues page 1 (one run per connection and entity at a time)
//   <entity>_page      reads one page, saves what changed, queues the next page or finalize
//   <entity>_finalize  closes the run (customers: marks those the provider no longer returns),
//                      then starts the next entity's run (customers -> documents)
//   fetch_customer / fetch_document  read and save one record (what a webhook queues)
// The provider cannot filter by update date, so every run reads all pages; only real changes are
// written and audited.
import './schema.js'; // tables must exist before statements are prepared
import { db, nowIso } from '../db.js';
import * as queue from './queue.js';
import { registerHandler, kick } from './worker.js';
import { getConnection } from './connections.js';
import { getProvider } from './providers/index.js';
import { upsertCustomerRecord, markMissingCustomers } from './customerStore.js';
import { upsertDocument, countDocuments } from './documentStore.js';
import { isRetryable } from './errors.js';
import { tx } from './tx.js';

export const PAGE_SIZE = 100;
const MAX_ITEM_ERRORS = 20;
// A run that returns far fewer customers than are known is treated as a provider glitch:
// nobody is marked removed on the strength of it.
const MIN_SHARE_FOR_REMOVALS = 0.5;
const AUTH_CODES = new Set(['auth_failed', 'auth_error', 'forbidden', 'bad_config']);
const LIVE_STATUSES = "('pending', 'processing', 'retry')";

// Injectable provider dependencies (fetch, sleep), for tests.
let providerDeps = {};
export const setProviderDeps = (deps = {}) => { providerDeps = deps; };

/** Customers finalize: mark records the provider stopped returning (never deletes). */
function finalizeCustomers(job, run) {
  const known = db.prepare('SELECT COUNT(*) AS n FROM acc_customer_records WHERE connection_id = ? AND removed_at IS NULL').get(job.connection_id).n;
  if (run.failed > 0) return { note: 'חלק מהלקוחות לא נשמרו, ולכן לא סומנו לקוחות שהוסרו ב-Morning בריצה הזו.', removed: 0 };
  if (known > 0 && run.fetched < known * MIN_SHARE_FOR_REMOVALS) {
    return { note: `Morning החזירה ${run.fetched} לקוחות מתוך ${known} מוכרים. סימון לקוחות שהוסרו דולג בריצה הזו.`, removed: 0 };
  }
  return { note: null, removed: markMissingCustomers(job.connection_id, run.id, { source: job.source, jobId: job.id }) };
}

/**
 * What differs between synced entities. Documents are never marked removed: accounting documents
 * are not deleted at the provider (a cancellation is a new document).
 */
const ENTITIES = {
  customers: {
    list: (provider, conn, opts) => provider.listCustomers(conn, opts, providerDeps),
    upsert: upsertCustomerRecord,
    finalize: finalizeCustomers,
    next: 'documents',
  },
  documents: {
    list: (provider, conn, opts) => provider.listDocuments(conn, opts, providerDeps),
    upsert: upsertDocument,
    finalize: () => ({ note: null, removed: 0 }),
    next: null,
  },
};

const parseRun = (r) => (r ? { ...r, item_errors: JSON.parse(r.item_errors) } : null);
const getRun = (id) => parseRun(db.prepare('SELECT * FROM acc_sync_runs WHERE id = ?').get(id));
const latestRunId = (connectionId, entity) => db.prepare('SELECT MAX(id) AS id FROM acc_sync_runs WHERE connection_id = ? AND type = ?').get(connectionId, entity).id;
export const latestRun = (connectionId, entity) => getRun(latestRunId(connectionId, entity));
export const latestCustomerRun = (connectionId) => latestRun(connectionId, 'customers');

const hasLiveRunJobs = (connectionId, entity) => !!db.prepare(
  `SELECT 1 FROM acc_jobs WHERE connection_id = ? AND type IN (?, ?) AND status IN ${LIVE_STATUSES} LIMIT 1`,
).get(connectionId, `${entity}_page`, `${entity}_finalize`);

function finishRun(runId, status, { error = null, removed = 0 } = {}) {
  db.prepare('UPDATE acc_sync_runs SET status = ?, finished_at = ?, error = ?, removed = ? WHERE id = ?')
    .run(status, nowIso(), error, removed, runId);
}

/** The connection, or why a job for it must not run. */
function usableConnection(id) {
  const conn = getConnection(id);
  if (!conn) return { stop: 'החיבור נמחק' };
  if (!conn.enabled) return { stop: 'החיבור מושבת' };
  return { conn };
}

/** A run stops for good when its job will not be tried again; bad credentials also mark the connection. */
function onPageFailure(job, runId, err) {
  const final = !isRetryable(err) || job.attempts >= job.max_attempts;
  if (!final) return;
  finishRun(runId, 'failed', { error: err.message });
  if (AUTH_CODES.has(err.code)) {
    db.prepare("UPDATE acc_connections SET status = 'error', last_check_at = ?, last_error = ? WHERE id = ?").run(nowIso(), err.message, job.connection_id);
  }
}

const requestRun = (entity, connectionId, source) => queue.enqueue({ type: `${entity}_sync`, source, connectionId, dedupeKey: `${entity}_sync:${connectionId}` });

/** Queues a full sync: customers first, then documents. A second request while one waits returns it. */
export function requestCustomerSync(connectionId, source) {
  const r = requestRun('customers', connectionId, source);
  kick();
  return r;
}

const startRun = (entity) => async (job) => {
  const { conn, stop } = usableConnection(job.connection_id);
  if (stop) return { skipped: stop };
  return tx(() => {
    const current = latestRun(conn.id, entity);
    if (current?.status === 'running') {
      if (hasLiveRunJobs(conn.id, entity)) return { skipped: 'סנכרון כבר רץ', runId: current.id };
      finishRun(current.id, 'failed', { error: 'הריצה נעצרה בלי לסיים' });
    }
    const runId = Number(db.prepare('INSERT INTO acc_sync_runs (connection_id, type, source, page_size) VALUES (?, ?, ?, ?)')
      .run(conn.id, entity, job.source, PAGE_SIZE).lastInsertRowid);
    queue.enqueue({ type: `${entity}_page`, source: job.source, connectionId: conn.id, payload: { runId, page: 1 }, dedupeKey: `${entity}_page:${runId}:1` });
    return { runId };
  });
};

const syncPage = (entity) => async (job) => {
  const { runId, page } = job.payload;
  const run = getRun(runId);
  if (!run) return { skipped: 'הריצה לא נמצאה' };
  if (latestRunId(job.connection_id, entity) !== runId) return { skipped: 'התחילה ריצה חדשה יותר' };
  if (run.pages >= page) return { skipped: 'הדף כבר עובד' }; // a repeat after a crash between commit and completion
  const { conn, stop } = usableConnection(job.connection_id);
  if (stop) { finishRun(runId, 'cancelled', { error: stop }); return { skipped: stop }; }
  if (run.status !== 'running') { // manual retry of the page that stopped the run: resume it
    db.prepare("UPDATE acc_sync_runs SET status = 'running', finished_at = NULL, error = NULL WHERE id = ?").run(runId);
  }

  let result;
  try {
    result = await ENTITIES[entity].list(getProvider(conn.provider), conn, { page, pageSize: run.page_size });
  } catch (err) {
    onPageFailure(job, runId, err);
    throw err;
  }

  const counts = { added: 0, updated: 0, unchanged: 0, failed: 0 };
  const errors = [];
  const last = page >= result.pages || !result.items.length;
  tx(() => {
    for (const item of result.items) {
      try {
        counts[ENTITIES[entity].upsert(conn.id, item, { source: job.source, jobId: job.id, runId })]++;
      } catch (err) { // one bad record must not stop the page; it is reported on the run
        counts.failed++;
        errors.push({ externalId: item.externalId, error: err.message });
      }
    }
    db.prepare(`
      UPDATE acc_sync_runs SET fetched = fetched + ?, added = added + ?, updated = updated + ?, unchanged = unchanged + ?,
        failed = failed + ?, pages = ?, item_errors = ? WHERE id = ?
    `).run(result.items.length, counts.added, counts.updated, counts.unchanged, counts.failed, page,
      JSON.stringify([...run.item_errors, ...errors].slice(0, MAX_ITEM_ERRORS)), runId);
    queue.enqueue(last
      ? { type: `${entity}_finalize`, source: job.source, connectionId: conn.id, payload: { runId }, dedupeKey: `${entity}_finalize:${runId}` }
      : { type: `${entity}_page`, source: job.source, connectionId: conn.id, payload: { runId, page: page + 1 }, dedupeKey: `${entity}_page:${runId}:${page + 1}` });
  });
  return { runId, page, pages: result.pages, ...counts };
};

const finalizeRun = (entity) => async (job) => {
  const { runId } = job.payload;
  const run = getRun(runId);
  if (!run || run.status !== 'running') return { skipped: 'הריצה לא פעילה' };
  if (latestRunId(job.connection_id, entity) !== runId) return { skipped: 'התחילה ריצה חדשה יותר' };
  const { note, removed } = ENTITIES[entity].finalize(job, run);
  const next = ENTITIES[entity].next;
  tx(() => {
    finishRun(runId, 'completed', { error: note, removed });
    if (next) requestRun(next, job.connection_id, job.source);
  });
  return { runId, removed, note, next };
};

const fetchOne = (getter, upsert) => async (job) => {
  const { conn, stop } = usableConnection(job.connection_id);
  if (stop) return { skipped: stop };
  const item = await getter(getProvider(conn.provider), conn, job.payload.externalId);
  if (!item) return { notFound: true };
  return { result: upsert(conn.id, item, { source: job.source, jobId: job.id }) };
};

for (const entity of Object.keys(ENTITIES)) {
  registerHandler(`${entity}_sync`, startRun(entity));
  registerHandler(`${entity}_page`, syncPage(entity));
  registerHandler(`${entity}_finalize`, finalizeRun(entity));
}
registerHandler('fetch_customer', fetchOne((p, conn, id) => p.getCustomer(conn, id, providerDeps), upsertCustomerRecord));
registerHandler('fetch_document', fetchOne((p, conn, id) => p.getDocument(conn, id, providerDeps), upsertDocument));

/** Sync run history, newest first, optionally for one entity. */
export function listRuns({ connectionId, type, page = 1, pageSize = 20 } = {}) {
  const size = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
  const current = Math.max(Number(page) || 1, 1);
  const where = [];
  const args = [];
  if (connectionId) { where.push('connection_id = ?'); args.push(Number(connectionId)); }
  if (type) { where.push('type = ?'); args.push(type); }
  const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM acc_sync_runs ${sqlWhere}`).get(...args).n;
  const items = db.prepare(`SELECT * FROM acc_sync_runs ${sqlWhere} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...args, size, (current - 1) * size).map(parseRun);
  return { items, total, page: current, pageSize: size };
}

/** Customers the connection's provider currently has (not marked removed). */
export const knownCustomers = (connectionId) => db.prepare(
  'SELECT COUNT(*) AS n FROM acc_customer_records WHERE connection_id = ? AND removed_at IS NULL',
).get(connectionId).n;

/** Documents synced from the connection. */
export const knownDocuments = countDocuments;

/** Local customers (from client cards and from documents). */
export const totalCustomers = () => db.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
