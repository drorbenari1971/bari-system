// Webhook receiver: its own tiny HTTP listener on 127.0.0.1 (WEBHOOK_PORT, default 4100), separate
// from the app, which stays local-only. A tunnel (ngrok / Cloudflare) points at this port only.
// It serves exactly one route, POST /<provider>/<url-token>, and never calls the provider: it checks,
// records metadata and queues a job, then answers at once. Fetching happens later in the worker,
// with the queue's retries; nothing is retried inside the HTTP request.
import './schema.js'; // tables must exist before statements are prepared
import http from 'node:http';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { env } from '../config.js';
import { getProvider } from './providers/index.js';
import { getConnection } from './connections.js';
import { findConnectionByToken, webhookSecret } from './webhookConfig.js';
import { isEnabled } from './flags.js';
import * as queue from './queue.js';
import { kick } from './worker.js';
import { tx } from './tx.js';

export const LIMITS = {
  maxBodyBytes: 1_000_000,
  perIpPerMinute: 60,
  globalPerMinute: 300,
  badSignaturesBeforeBlock: 10, // within the block window, from one address
  blockMs: 10 * 60_000,
};
const KEEP_ARCHIVE_DAYS = 30;
// Which job fetches each kind of referenced record (document will be added with the document sync).
const JOB_FOR_KIND = { customer: 'fetch_customer' };
const ROUTE = /^\/([a-z0-9-]{1,32})\/([A-Za-z0-9_-]{16,64})$/;

// In-memory protection state (resets on restart, by design).
const perIp = new Map();      // ip -> { windowStart, count }
const badSignatures = new Map(); // ip -> { windowStart, count, blockedUntil }
let globalWindow = { windowStart: 0, count: 0 };
/** Answers Morning would count as failures, per connection, since the last accepted answer (not archived: 429/403). */
export const unarchivedFailures = new Map();

export function resetProtection() {
  perIp.clear();
  badSignatures.clear();
  globalWindow = { windowStart: 0, count: 0 };
  unarchivedFailures.clear();
}

function overLimit(ip, now) {
  if (now - globalWindow.windowStart >= 60_000) globalWindow = { windowStart: now, count: 0 };
  let w = perIp.get(ip);
  if (!w || now - w.windowStart >= 60_000) { w = { windowStart: now, count: 0 }; perIp.set(ip, w); }
  globalWindow.count++;
  w.count++;
  if (perIp.size > 10_000) perIp.clear(); // bounded memory under a spread-out flood
  return w.count > LIMITS.perIpPerMinute || globalWindow.count > LIMITS.globalPerMinute;
}

const isBlocked = (ip, now) => (badSignatures.get(ip)?.blockedUntil ?? 0) > now;

function noteBadSignature(ip, now) {
  let b = badSignatures.get(ip);
  if (!b || now - b.windowStart >= LIMITS.blockMs) { b = { windowStart: now, count: 0, blockedUntil: 0 }; badSignatures.set(ip, b); }
  if (++b.count >= LIMITS.badSignaturesBeforeBlock) b.blockedUntil = now + LIMITS.blockMs;
}

const countUnarchived = (connectionId) => unarchivedFailures.set(connectionId, (unarchivedFailures.get(connectionId) ?? 0) + 1);

const insertArchive = db.prepare(`
  INSERT INTO acc_webhook_archive (connection_id, delivery_id, topic, webhook_id, event_timestamp, correlation_id,
    headers, body_sha256, body_size, remote_ip, user_agent, signature_valid, outcome, rejection_reason, job_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const acceptedBefore = db.prepare("SELECT 1 FROM acc_webhook_archive WHERE connection_id = ? AND delivery_id = ? AND outcome = 'accepted'");

/**
 * Handles one delivery whose route matched. No provider calls, no waiting on the network.
 * @returns {{ status: number, outcome: string, reason?: string, jobIds?: number[] }}
 */
export function ingest({ connectionId, provider, headers, rawBody, remoteIp }) {
  const hooks = provider.webhooks;
  const meta = hooks.describeDelivery(headers);
  const keptHeaders = Object.fromEntries(hooks.KEPT_HEADERS.filter((h) => headers[h] !== undefined).map((h) => [h, String(headers[h]).slice(0, 500)]));
  const archive = (outcome, { valid, reason = null, jobId = null }) => insertArchive.run(
    connectionId, meta.deliveryId, meta.topic, meta.webhookId, meta.eventTimestamp, meta.correlationId,
    JSON.stringify(keptHeaders), crypto.createHash('sha256').update(rawBody).digest('hex'), rawBody.length,
    remoteIp, keptHeaders['user-agent'] ?? null, valid ? 1 : 0, outcome, reason, jobId,
  );
  const done = (status, outcome, extra = {}) => {
    if (status < 300) unarchivedFailures.delete(connectionId);
    return { status, outcome, ...extra };
  };

  const secret = webhookSecret(connectionId);
  if (!secret) { archive('rejected', { valid: false, reason: 'no_secret' }); return done(401, 'rejected', { reason: 'no_secret' }); }
  if (!hooks.verifySignature(secret, rawBody, headers['x-webhook-signature'])) {
    archive('rejected', { valid: false, reason: 'bad_signature' });
    return done(401, 'rejected', { reason: 'bad_signature' });
  }

  // From here the delivery is genuine: always acknowledge, so Morning does not count a failure.
  if (meta.deliveryId && acceptedBefore.get(connectionId, meta.deliveryId)) { archive('duplicate', { valid: true }); return done(200, 'duplicate'); }
  if (!isEnabled('webhooks')) { archive('disabled', { valid: true, reason: 'flag_off' }); return done(200, 'disabled', { reason: 'flag_off' }); }
  const conn = getConnection(connectionId);
  if (!conn?.enabled) { archive('disabled', { valid: true, reason: 'connection_disabled' }); return done(200, 'disabled', { reason: 'connection_disabled' }); }

  const read = hooks.readDelivery(meta.topic, rawBody);
  if (read.status !== 'ok') { archive(read.status, { valid: true }); return done(200, read.status); }

  const jobIds = tx(() => {
    const ids = read.refs.filter((ref) => JOB_FOR_KIND[ref.kind]).map((ref) => queue.enqueue({
      type: JOB_FOR_KIND[ref.kind], source: 'webhook', connectionId,
      payload: { externalId: ref.externalId }, dedupeKey: `${JOB_FOR_KIND[ref.kind]}:${connectionId}:${ref.externalId}`,
    }).job.id);
    archive('accepted', { valid: true, jobId: ids[0] ?? null });
    return ids;
  });
  kick();
  return done(200, 'accepted', { jobIds });
}

const clientIp = (req) => String(req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '')
  .split(',')[0].trim().slice(0, 64);

function reply(res, status) {
  // After a refusal the rest of the request is discarded and the connection is not reused.
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...(status >= 300 ? { Connection: 'close' } : {}) });
  res.end(status < 300 ? 'ok' : 'rejected');
}

/** Reads the body up to the limit; resolves null (and discards the rest) when it is too large. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > LIMITS.maxBodyBytes) { req.resume(); resolve(null); return; }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > LIMITS.maxBodyBytes) { tooLarge = true; chunks.length = 0; resolve(null); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handle(req, res, now) {
  const match = ROUTE.exec(new URL(req.url, 'http://receiver').pathname);
  const connectionId = match ? findConnectionByToken(match[1], match[2]) : null;
  if (!connectionId) { req.resume(); return reply(res, 404); }
  if (req.method !== 'POST') { req.resume(); return reply(res, 405); }
  const provider = getProvider(match[1]);
  const ip = clientIp(req);
  const t = now();
  if (isBlocked(ip, t)) { req.resume(); countUnarchived(connectionId); return reply(res, 403); }
  if (overLimit(ip, t)) { req.resume(); countUnarchived(connectionId); return reply(res, 429); }

  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
  const archiveRejected = (reason, size = 0) => insertArchive.run(connectionId, headers['x-webhook-delivery-id'] ?? null, headers['x-webhook-topic'] ?? null,
    null, null, null, '{}', null, size, ip, String(headers['user-agent'] ?? '').slice(0, 200), 0, 'rejected', reason, null);
  if (!String(headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    req.resume();
    archiveRejected('content_type');
    return reply(res, 415);
  }
  const rawBody = await readBody(req);
  if (!rawBody) { archiveRejected('too_large', LIMITS.maxBodyBytes); return reply(res, 413); }

  const result = ingest({ connectionId, provider, headers, rawBody, remoteIp: ip });
  if (result.reason === 'bad_signature') noteBadSignature(ip, t);
  return reply(res, result.status);
}

/** @param {{ now?: () => number }} [options] injectable clock for tests */
export function createReceiver({ now = Date.now } = {}) {
  return http.createServer((req, res) => {
    handle(req, res, now).catch((err) => {
      console.error('[accounting] webhook receiver error:', err.message);
      if (!res.headersSent) reply(res, 500);
    });
  });
}

/** Removes archive rows older than the retention period (metadata only; bodies are never stored). */
export const cleanupArchive = (days = KEEP_ARCHIVE_DAYS) => db.prepare('DELETE FROM acc_webhook_archive WHERE received_at < ?')
  .run(new Date(Date.now() - days * 86_400_000).toISOString()).changes;

let server = null;
let maintenance = null;

export function startWebhookReceiver() {
  if (server) return;
  const port = Number(env('WEBHOOK_PORT', '4100'));
  server = createReceiver();
  server.on('error', (err) => console.error(`[accounting] webhook receiver could not start on port ${port}: ${err.message}`));
  server.listen(port, '127.0.0.1', () => console.log(`[accounting] webhook receiver on http://127.0.0.1:${port} (for the tunnel only)`));
  cleanupArchive();
  maintenance = setInterval(cleanupArchive, 60 * 60_000);
}

export function stopWebhookReceiver() {
  clearInterval(maintenance);
  server?.close();
  server = null;
}

