// Webhook setup of a connection. Two separate values, with different jobs:
//
//   URL token   - identifies the endpoint: /<provider>/<token>. Random (32 URL-safe characters),
//                 shown in the screen as part of the address to paste into Morning, stored in the
//                 connection settings. It is not a credential: knowing it only lets a request
//                 reach the signature check. Rotating it changes the address.
//   HMAC secret - proves a delivery came from Morning (HMAC-SHA256 over the raw body). Random,
//                 32 characters (Morning's maximum), stored encrypted (AES-256-GCM), shown ONCE
//                 when created and never returned again by the API, logged or audited.
//
// Changing one never changes the other.
import './schema.js'; // tables must exist before statements are prepared
import crypto from 'node:crypto';
import { db, nowIso } from '../db.js';
import { env } from '../config.js';
import { encrypt, decrypt } from './crypto.js';
import { getProvider, hasProvider } from './providers/index.js';
import { AccountingError } from './errors.js';
import { tx } from './tx.js';
import * as audit from './audit.js';

const TOKEN_BYTES = 24; // 32 base64url characters
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** The public HTTPS address of the tunnel, e.g. https://example.ngrok-free.app (backend/.env). */
export const publicBaseUrl = () => env('WEBHOOK_PUBLIC_URL', '').replace(/\/+$/, '');

/** Uniformly random characters (rejection sampling, no modulo bias). */
function randomString(length) {
  let out = '';
  while (out.length < length) {
    for (const b of crypto.randomBytes(length * 2)) {
      if (b < 248 && out.length < length) out += ALPHABET[b % ALPHABET.length]; // 248 = 4 * 62
    }
  }
  return out;
}

const row = (id) => db.prepare('SELECT * FROM acc_connections WHERE id = ?').get(id);

function requireWebhookConnection(id) {
  const r = row(id);
  if (!r) throw new AccountingError('החיבור לא נמצא', { code: 'not_found', status: 404 });
  const provider = getProvider(r.provider);
  if (!provider.capabilities.webhooks) throw new AccountingError('הספק לא תומך ב-Webhooks', { code: 'validation' });
  return { r, provider };
}

const configOf = (r) => JSON.parse(r.settings).webhook ?? {};

function saveConfig(id, r, config) {
  const settings = { ...JSON.parse(r.settings), webhook: config };
  db.prepare('UPDATE acc_connections SET settings = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(settings), nowIso(), id);
}

/** What the screen may know. Never includes the secret. */
export function webhookView(id) {
  const { r, provider } = requireWebhookConnection(id);
  const config = configOf(r);
  const path = config.pathToken ? `/${provider.id}/${config.pathToken}` : null;
  const base = publicBaseUrl();
  return {
    path,
    url: path && base ? `${base}${path}` : null,
    publicUrlSet: !!base,
    secretSet: !!r.webhook_secret_enc,
    secretSetAt: config.secretSetAt ?? null,
    activatedAt: config.activatedAt ?? null,
    topics: provider.webhooks.supportedTopics(),
  };
}

/**
 * Creates (or replaces) the HMAC secret; creates the URL token too if there is none yet.
 * @returns {{ secret: string } & ReturnType<typeof webhookView>} the only time the secret is returned
 */
export function createSecret(id, source = 'manual') {
  const { r, provider } = requireWebhookConnection(id);
  const secret = randomString(provider.webhooks.SECRET_LENGTH);
  const before = configOf(r);
  const now = nowIso();
  tx(() => {
    db.prepare('UPDATE acc_connections SET webhook_secret_enc = ? WHERE id = ?').run(encrypt(secret), id);
    saveConfig(id, r, {
      ...before,
      pathToken: before.pathToken ?? crypto.randomBytes(TOKEN_BYTES).toString('base64url'),
      secretSetAt: now,
      activatedAt: before.activatedAt ?? now,
    });
    audit.record({
      action: r.webhook_secret_enc ? 'connection.webhook_secret_rotated' : 'connection.webhook_secret_created',
      source, entityType: 'connection', entityId: id,
      before: { secretSet: !!r.webhook_secret_enc }, after: { secretSet: true },
    });
  });
  return { secret, ...webhookView(id) };
}

/** A new endpoint address. The secret stays; Morning must get the new address. */
export function rotateToken(id, source = 'manual') {
  const { r } = requireWebhookConnection(id);
  const before = configOf(r);
  if (!before.pathToken) throw new AccountingError('עדיין לא הוגדר Webhook לחיבור הזה', { code: 'conflict', status: 409 });
  tx(() => {
    saveConfig(id, r, { ...before, pathToken: crypto.randomBytes(TOKEN_BYTES).toString('base64url') });
    audit.record({ action: 'connection.webhook_token_rotated', source, entityType: 'connection', entityId: id, before: { address: 'old' }, after: { address: 'new' } });
  });
  return webhookView(id);
}

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

/** The connection that owns an endpoint token (constant-time comparison), or null. */
export function findConnectionByToken(providerId, token) {
  if (!hasProvider(providerId) || !token) return null;
  const wanted = digest(token);
  let found = null;
  for (const c of db.prepare('SELECT id, settings FROM acc_connections WHERE provider = ?').all(providerId)) {
    const stored = JSON.parse(c.settings).webhook?.pathToken;
    if (stored && crypto.timingSafeEqual(digest(stored), wanted)) found = c.id;
  }
  return found;
}

/** The decrypted HMAC secret, for the receiver only. */
export function webhookSecret(id) {
  const r = row(id);
  return r?.webhook_secret_enc ? String(decrypt(r.webhook_secret_enc)) : null;
}
