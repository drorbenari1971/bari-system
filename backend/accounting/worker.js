// Background worker: takes jobs from the queue and runs the handler registered for their type.
// Runs inside the existing server process (no extra server).
import * as queue from './queue.js';
import { isRetryable } from './errors.js';

const handlers = new Map();
const CONCURRENCY = 2;
const TICK_MS = 2000;
const MAINTENANCE_MS = 60 * 60_000;

let timer = null;
let active = 0;
let lastMaintenance = 0;

/**
 * Registers the function that processes one job type.
 * @param {string} type
 * @param {(job: object) => Promise<object|void>} handler  returns a short result summary
 */
export function registerHandler(type, handler) {
  if (handlers.has(type)) throw new Error(`Handler already registered for job type: ${type}`);
  handlers.set(type, handler);
}

export const hasHandler = (type) => handlers.has(type);

async function runOne(job) {
  const handler = handlers.get(job.type);
  try {
    if (!handler) throw Object.assign(new Error(`אין מטפל לסוג משימה: ${job.type}`), { permanent: true });
    const result = await handler(job);
    queue.complete(job.id, result ?? null);
  } catch (err) {
    queue.fail(job.id, err, { retryable: !err.permanent && isRetryable(err), retryAfterMs: err.retryAfterMs });
    console.error(`[accounting] job #${job.id} (${job.type}) failed:`, err.message);
  }
}

/** Fills free worker slots with ready jobs. Safe to call any time, e.g. right after enqueue. */
export function kick() {
  if (Date.now() - lastMaintenance > MAINTENANCE_MS) {
    lastMaintenance = Date.now();
    queue.releaseStale();
    queue.cleanup();
  }
  while (active < CONCURRENCY) {
    const job = queue.claim();
    if (!job) break;
    active++;
    runOne(job).finally(() => { active--; kick(); });
  }
}

export function startWorker() {
  if (timer) return;
  queue.releaseStale(0); // anything still "processing" was interrupted by the previous shutdown
  timer = setInterval(kick, TICK_MS);
  kick();
}

export function stopWorker() {
  clearInterval(timer);
  timer = null;
}

/** For tests: resolves when no job is running. */
export async function idle() {
  while (active > 0) await new Promise((r) => setTimeout(r, 5));
}
