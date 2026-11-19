// Customer sync (stage 2), entirely through the job queue:
//   customers_sync      opens a run and queues page 1 (one run per connection at a time)
//   customers_page      reads one page, saves what changed, queues the next page or finalize
//   customers_finalize  closes the run and marks customers the provider no longer returns
//   fetch_customer      reads and saves one customer (also what a future webhook will queue)
// The provider cannot filter by update date, so every run reads all pages; only real changes are
// written and audited.
import './schema.js'; // tables must exist before statements are prepared
import { db, nowIso } from '../db.js';
import * as queue from './queue.js';
import { registerHandler, kick } from './worker.js';
import { getConnection } from './connections.js';
import { getProvider } from './providers/index.js';
import { upsertCustomerRecord, markMissingCustomers } from './customerStore.js';
import { isRetryable } from './errors.js';
import { tx } from './tx.js';

export const PAGE_SIZE = 100;
const MAX_ITEM_ERRORS = 20;
// A run that returns far fewer customers than are known is treated as a provider glitch:
// nobody is marked removed on the strength of it.
const MIN_SHARE_FOR_REMOVALS = 0.5;
const AUTH_CODES = new Set(['auth_failed', 'auth_error', 'forbidden', 'bad_config']);
const RUN_JOB_TYPES = "('customers_page', 'customers_finalize')";
const LIVE_STATUSES = "('pending', 'processing', 'retry')";

// Injectable provider dependencies (fetch, sleep), for tests.
let providerDeps = {};
export const setProviderDeps = (deps = {}) => { providerDeps = deps; };

const parseRun = (r) => (r ? { ...r, item_errors: JSON.parse(r.item_errors) } : null);
const getRun = (id) => parseRun(db.prepare('SELECT * FROM acc_sync_runs WHERE id = ?').get(id));
const latestRunId = (connectionId) => db.prepare("SELECT MAX(id) AS id FROM acc_sync_runs WHERE connection_id = ? AND type = 'customers'").get(connectionId).id;
export const latestCustomerRun = (connectionId) => getRun(latestRunId(connectionId));

const hasLiveRunJobs = (connectionId) => !!db.prepare(
  `SELECT 1 FROM acc_jobs WHERE connection_id = ? AND type IN ${RUN_JOB_TYPES} AND status IN ${LIVE_STATUSES} LIMIT 1`,
).get(connectionId);

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

/** Queues a customer sync. A second request while one is waiting returns the waiting one. */
export function requestCustomerSync(connectionId, source) {
  const r = queue.enqueue({ type: 'customers_sync', source, connectionId, dedupeKey: `customers_sync:${connectionId}` });
  kick();
  return r;
}

async function startRun(job) {
  const { conn, stop } = usableConnection(job.connection_id);
  if (stop) return { skipped: stop };
  return tx(() => {
    const current = latestCustomerRun(conn.id);
    if (current?.status === 'running') {
      if (hasLiveRunJobs(conn.id)) return { skipped: 'סנכרון כבר רץ', runId: current.id };
      finishRun(current.id, 'failed', { error: 'הריצה נעצרה בלי לסיים' });
    }
    const runId = Number(db.prepare("INSERT INTO acc_sync_runs (connection_id, type, source, page_size) VALUES (?, 'customers', ?, ?)")
      .run(conn.id, job.source, PAGE_SIZE).lastInsertRowid);
    queue.enqueue({ type: 'customers_page', source: job.source, connectionId: conn.id, payload: { runId, page: 1 }, dedupeKey: `customers_page:${runId}:1` });
    return { runId };
  });
}

async function syncPage(job) {
  const { runId, page } = job.payload;
  const run = getRun(runId);
  if (!run) return { skipped: 'הריצה לא נמצאה' };
  if (latestRunId(job.connection_id) !== runId) return { skipped: 'התחילה ריצה חדשה יותר' };
  if (run.pages >= page) return { skipped: 'הדף כבר עובד' }; // a repeat after a crash between commit and completion
  const { conn, stop } = usableConnection(job.connection_id);
  if (stop) { finishRun(runId, 'cancelled', { error: stop }); return { skipped: stop }; }
  if (run.status !== 'running') { // manual retry of the page that stopped the run: resume it
    db.prepare("UPDATE acc_sync_runs SET status = 'running', finished_at = NULL, error = NULL WHERE id = ?").run(runId);
  }

  let result;
  try {
    result = await getProvider(conn.provider).listCustomers(conn, { page, pageSize: run.page_size }, providerDeps);
  } catch (err) {
    onPageFailure(job, runId, err);
    throw err;
  }

  const counts = { added: 0, updated: 0, unchanged: 0, failed: 0 };
  const errors = [];
  const last = page >= result.pages || !result.items.length;
  tx(() => {
    for (const c of result.items) {
      try {
        counts[upsertCustomerRecord(conn.id, c, { source: job.source, jobId: job.id, runId })]++;
      } catch (err) { // one bad record must not stop the page; it is reported on the run
        counts.failed++;
        errors.push({ externalId: c.externalId, error: err.message });
      }
    }
    db.prepare(`
      UPDATE acc_sync_runs SET fetched = fetched + ?, added = added + ?, updated = updated + ?, unchanged = unchanged + ?,
        failed = failed + ?, pages = ?, item_errors = ? WHERE id = ?
    `).run(result.items.length, counts.added, counts.updated, counts.unchanged, counts.failed, page,
      JSON.stringify([...run.item_errors, ...errors].slice(0, MAX_ITEM_ERRORS)), runId);
    queue.enqueue(last
      ? { type: 'customers_finalize', source: job.source, connectionId: conn.id, payload: { runId }, dedupeKey: `customers_finalize:${runId}` }
      : { type: 'customers_page', source: job.source, connectionId: conn.id, payload: { runId, page: page + 1 }, dedupeKey: `customers_page:${runId}:${page + 1}` });
  });
  return { runId, page, pages: result.pages, ...counts };
}

async function finalizeRun(job) {
  const { runId } = job.payload;
  const run = getRun(runId);
  if (!run || run.status !== 'running') return { skipped: 'הריצה לא פעילה' };
  if (latestRunId(job.connection_id) !== runId) return { skipped: 'התחילה ריצה חדשה יותר' };

  const known = db.prepare('SELECT COUNT(*) AS n FROM acc_customer_records WHERE connection_id = ? AND removed_at IS NULL').get(job.connection_id).n;
  let note = null;
  let removed = 0;
  if (run.failed > 0) note = 'חלק מהלקוחות לא נשמרו, ולכן לא סומנו לקוחות שהוסרו ב-Morning בריצה הזו.';
  else if (known > 0 && run.fetched < known * MIN_SHARE_FOR_REMOVALS) note = `Morning החזירה ${run.fetched} לקוחות מתוך ${known} מוכרים. סימון לקוחות שהוסרו דולג בריצה הזו.`;
  else removed = markMissingCustomers(job.connection_id, runId, { source: job.source, jobId: job.id });
  finishRun(runId, 'completed', { error: note, removed });
  return { runId, removed, note };
}

async function fetchCustomer(job) {
  const { conn, stop } = usableConnection(job.connection_id);
  if (stop) return { skipped: stop };
  const c = await getProvider(conn.provider).getCustomer(conn, job.payload.externalId, providerDeps);
  if (!c) return { notFound: true };
  return { result: upsertCustomerRecord(conn.id, c, { source: job.source, jobId: job.id }) };
}

registerHandler('customers_sync', startRun);
registerHandler('customers_page', syncPage);
registerHandler('customers_finalize', finalizeRun);
registerHandler('fetch_customer', fetchCustomer);

/** Sync run history, newest first. */
export function listRuns({ connectionId, page = 1, pageSize = 20 } = {}) {
  const size = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
  const current = Math.max(Number(page) || 1, 1);
  const where = connectionId ? 'WHERE connection_id = ?' : '';
  const args = connectionId ? [Number(connectionId)] : [];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM acc_sync_runs ${where}`).get(...args).n;
  const items = db.prepare(`SELECT * FROM acc_sync_runs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...args, size, (current - 1) * size).map(parseRun);
  return { items, total, page: current, pageSize: size };
}

/** Customers the connection's provider currently has (not marked removed). */
export const knownCustomers = (connectionId) => db.prepare(
  'SELECT COUNT(*) AS n FROM acc_customer_records WHERE connection_id = ? AND removed_at IS NULL',
).get(connectionId).n;
