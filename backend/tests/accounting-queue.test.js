import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { isolate } from './helpers.js';

after(isolate());
const { db } = await import('../db.js');
const queue = await import('../accounting/queue.js');
const worker = await import('../accounting/worker.js');
const { AccountingError } = await import('../accounting/errors.js');

beforeEach(() => db.exec('DELETE FROM acc_jobs'));
const ago = (ms) => new Date(Date.now() - ms).toISOString();

test('enqueue de-duplicates only while a job with the key is waiting or running', () => {
  const a = queue.enqueue({ type: 'fetch_document', source: 'webhook', payload: { id: 'd1' }, dedupeKey: 'doc:d1' });
  const b = queue.enqueue({ type: 'fetch_document', source: 'polling', payload: { id: 'd1' }, dedupeKey: 'doc:d1' });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(b.job.id, a.job.id);
  queue.claim();
  queue.complete(a.job.id);
  assert.equal(queue.enqueue({ type: 'fetch_document', source: 'polling', dedupeKey: 'doc:d1' }).created, true, 'after completion a new job is allowed');
});

test('claim takes the highest priority first, then the oldest, and marks it processing', () => {
  queue.enqueue({ type: 't', source: 'polling', payload: { n: 1 } });
  queue.enqueue({ type: 't', source: 'webhook', payload: { n: 2 } });
  queue.enqueue({ type: 't', source: 'polling', payload: { n: 3 } });
  const first = queue.claim();
  assert.equal(first.payload.n, 2);
  assert.equal(first.status, 'processing');
  assert.equal(first.attempts, 1);
  assert.equal(queue.claim().payload.n, 1);
  assert.equal(queue.claim().payload.n, 3);
  assert.equal(queue.claim(), null);
});

test('a temporary failure goes to retry with a growing delay; then failed after max attempts', () => {
  const { job } = queue.enqueue({ type: 't', source: 'manual', maxAttempts: 2 });
  queue.claim();
  queue.fail(job.id, new Error('boom'));
  let j = queue.getJob(job.id);
  assert.equal(j.status, 'retry');
  assert.equal(j.last_error, 'boom');
  const delay = Date.parse(j.next_attempt_at) - Date.now();
  assert.ok(delay > 8000 && delay <= 10_000, `first wait ~10s, got ${delay}`);
  assert.equal(queue.claim(), null, 'not ready before next_attempt_at');

  db.prepare('UPDATE acc_jobs SET next_attempt_at = ? WHERE id = ?').run(ago(1), job.id);
  queue.claim();
  queue.fail(job.id, new Error('boom again'));
  j = queue.getJob(job.id);
  assert.equal(j.status, 'failed');
  assert.equal(j.attempts, 2);
});

test('a permanent error fails at once; a provider retry-after is respected', () => {
  const a = queue.enqueue({ type: 't', source: 'manual' }).job;
  queue.claim();
  queue.fail(a.id, new Error('bad'), { retryable: false });
  assert.equal(queue.getJob(a.id).status, 'failed');

  const b = queue.enqueue({ type: 't', source: 'manual' }).job;
  queue.claim();
  queue.fail(b.id, new Error('slow down'), { retryAfterMs: 120_000 });
  const wait = Date.parse(queue.getJob(b.id).next_attempt_at) - Date.now();
  assert.ok(wait > 110_000, `waits for retry-after, got ${wait}`);
});

test('manual retry brings a failed job back with fresh attempts', () => {
  const { job } = queue.enqueue({ type: 't', source: 'manual' });
  queue.claim();
  queue.fail(job.id, new Error('x'), { retryable: false });
  assert.equal(queue.retryNow(job.id), true);
  const j = queue.getJob(job.id);
  assert.equal(j.status, 'pending');
  assert.equal(j.attempts, 0);
  assert.equal(queue.retryNow(job.id), false, 'only failed or retry jobs');
});

test('jobs stuck in processing are released; old completed jobs are cleaned up; counts', () => {
  const stuck = queue.enqueue({ type: 't', source: 'manual' }).job;
  queue.claim();
  db.prepare('UPDATE acc_jobs SET locked_at = ? WHERE id = ?').run(ago(10 * 60_000), stuck.id);
  assert.equal(queue.releaseStale(), 1);
  assert.equal(queue.getJob(stuck.id).status, 'retry');
  assert.match(queue.getJob(stuck.id).last_error, /נעצר באמצע/);

  const old = queue.enqueue({ type: 't', source: 'manual' }).job;
  db.prepare("UPDATE acc_jobs SET status = 'completed', finished_at = ? WHERE id = ?").run(ago(31 * 86_400_000), old.id);
  assert.equal(queue.cleanup(), 1);
  assert.deepEqual(queue.counts(), { pending: 0, processing: 0, completed: 0, failed: 0, retry: 1 });
});

test('the worker runs handlers, records results and duration, and handles failures', async () => {
  const seen = [];
  worker.registerHandler('echo', async (job) => { seen.push(job.payload.v); return { echoed: job.payload.v }; });
  worker.registerHandler('limited', async () => { throw new AccountingError('rate', { code: 'rate_limited', retryable: true, retryAfterMs: 60_000 }); });
  worker.registerHandler('broken', async () => { throw new AccountingError('bad config', { code: 'auth_failed', retryable: false }); });
  assert.throws(() => worker.registerHandler('echo', async () => {}), /already registered/);

  const ok = queue.enqueue({ type: 'echo', source: 'manual', payload: { v: 42 } }).job;
  const limited = queue.enqueue({ type: 'limited', source: 'manual' }).job;
  const broken = queue.enqueue({ type: 'broken', source: 'manual' }).job;
  const unknown = queue.enqueue({ type: 'nobody-handles-this', source: 'manual' }).job;
  worker.kick();
  await worker.idle();
  worker.kick();
  await worker.idle();

  assert.deepEqual(seen, [42]);
  const done = queue.getJob(ok.id);
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.result, { echoed: 42 });
  assert.ok(done.duration_ms >= 0);
  assert.equal(queue.getJob(limited.id).status, 'retry');
  assert.equal(queue.getJob(broken.id).status, 'failed');
  assert.equal(queue.getJob(unknown.id).status, 'failed');
  assert.match(queue.getJob(unknown.id).last_error, /אין מטפל/);
});

test('list filters by status and pages newest first', () => {
  for (let i = 0; i < 5; i++) queue.enqueue({ type: 't', source: 'manual', payload: { i } });
  const page = queue.list({ status: 'pending', pageSize: 2, page: 2 });
  assert.equal(page.total, 5);
  assert.deepEqual(page.items.map((j) => j.payload.i), [2, 1]);
});
