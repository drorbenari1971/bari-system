// Which local customer a provider record belongs to: the provider's ID first, then a normalized
// phone number (any provider). Names alone never merge customers: two people can share a name.
import './schema.js'; // tables must exist before statements are prepared
import { db } from '../db.js';
import { normalizePhone } from './model.js';

const byExternalId = db.prepare("SELECT customer_id FROM customer_identities WHERE connection_id = ? AND kind = 'external_id' AND value = ?");
const byPhone = db.prepare(`
  SELECT MIN(customer_id) AS customer_id FROM (
    SELECT customer_id FROM customer_identities WHERE kind = 'phone' AND value = ?
    UNION SELECT id FROM customers WHERE phone_norm = ?
  )
`);
const insertCustomer = db.prepare('INSERT INTO customers (display_name) VALUES (?)');
const insertIdentity = db.prepare('INSERT OR IGNORE INTO customer_identities (customer_id, connection_id, kind, value) VALUES (?, ?, ?, ?)');

/** Normalized phone numbers of a record: mobile first. */
export const phonesOf = (c) => [...new Set([c.mobile, c.phone].map(normalizePhone).filter(Boolean))];

/**
 * Finds or creates the local customer for a record, and records its identities.
 * Runs inside the caller's transaction.
 * @returns {{ customerId: number, matchedBy: 'external_id' | 'phone' | null }} null = a new customer
 */
export function resolveCustomer(connectionId, c) {
  let customerId = byExternalId.get(connectionId, c.externalId)?.customer_id;
  let matchedBy = customerId ? 'external_id' : null;
  if (!customerId) {
    for (const p of phonesOf(c)) {
      customerId = byPhone.get(p, p)?.customer_id;
      if (customerId) { matchedBy = 'phone'; break; }
    }
  }
  if (!customerId) customerId = Number(insertCustomer.run(c.name).lastInsertRowid);
  linkIdentities(customerId, connectionId, c);
  return { customerId, matchedBy };
}

/** Adds the record's ID and phones as identities of the customer (existing ones are kept). */
export function linkIdentities(customerId, connectionId, c) {
  insertIdentity.run(customerId, connectionId, 'external_id', c.externalId);
  for (const p of phonesOf(c)) insertIdentity.run(customerId, connectionId, 'phone', p);
}
