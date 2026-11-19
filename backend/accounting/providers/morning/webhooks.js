// Morning webhook deliveries, per the official spec (OpenAPI 2.0.0, "Webhooks"):
// - configured in the Morning UI (Developer Tools -> Webhooks), with an optional secret of up to 32 characters
// - x-webhook-signature = hex HMAC-SHA256 of the RAW body, keyed with that secret (headers are not signed)
// - other headers: x-webhook-topic, x-webhook-id, x-webhook-delivery-id, x-webhook-timestamp, x-correlation-id
// - only 200/201/202/204 acknowledge; after 15 failed deliveries Morning makes the webhook inactive
// A delivery is only a trigger: the body is used for the referenced ID and nothing else.
import crypto from 'node:crypto';

/** Longest secret Morning accepts. */
export const SECRET_LENGTH = 32;

/** The headers kept in the archive (no cookies, no auth, nothing else). */
export const KEPT_HEADERS = [
  'x-webhook-topic', 'x-webhook-id', 'x-webhook-delivery-id', 'x-webhook-timestamp', 'x-correlation-id',
  'user-agent', 'content-type', 'content-length',
];

/**
 * Topics that create work, and how to read the referenced record from the body.
 * Only client/created is active. document/created is deliberately not listed yet: it will be
 * added here (one line) after it has been checked, together with the document sync.
 */
const TOPICS = {
  'client/created': (body) => (body?.id ? [{ kind: 'customer', externalId: String(body.id) }] : null),
};

export const supportedTopics = () => Object.keys(TOPICS);

/** Constant-time check of the signature over the exact received bytes. */
export function verifySignature(secret, rawBody, signature) {
  if (!secret || typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

/** Delivery metadata from the headers (lower-case header names). */
export const describeDelivery = (headers) => ({
  topic: headers['x-webhook-topic'] ?? null,
  deliveryId: headers['x-webhook-delivery-id'] ?? null,
  webhookId: headers['x-webhook-id'] ?? null,
  eventTimestamp: headers['x-webhook-timestamp'] ?? null,
  correlationId: headers['x-correlation-id'] ?? null,
});

/**
 * What a verified delivery asks us to fetch.
 * @returns {{ status: 'ok', refs: {kind: string, externalId: string}[] } | { status: 'ignored' } | { status: 'unreadable' }}
 */
export function readDelivery(topic, rawBody) {
  const read = TOPICS[topic];
  if (!read) return { status: 'ignored' };
  let body;
  try { body = JSON.parse(rawBody.toString('utf8')); } catch { return { status: 'unreadable' }; }
  const refs = read(body);
  return refs?.length ? { status: 'ok', refs } : { status: 'unreadable' };
}
