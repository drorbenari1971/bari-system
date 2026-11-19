// Which local customer a record belongs to.
// - Customer records (stage 2): the provider's ID, then a normalized phone. Never by name.
// - Documents (stage 2b): the client ID on the document, then phone, then email, then the exact
//   name (approved by the owner: most receipts carry only a name). Each document stores how its
//   customer was identified, so name-based matches are always visible.
import './schema.js'; // tables must exist before statements are prepared
import { db } from '../db.js';
import { normalizePhone, normalizeEmail, normalizeName } from './model.js';

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

const byIdentity = db.prepare('SELECT customer_id FROM customer_identities WHERE connection_id = ? AND kind = ? AND value = ?');
const byEmail = db.prepare(`
  SELECT MIN(customer_id) AS customer_id FROM (
    SELECT customer_id FROM customer_identities WHERE kind = 'email' AND value = ?
    UNION SELECT id FROM customers WHERE lower(trim(email)) = ?
  )
`);
const customersNamed = db.prepare('SELECT id FROM customers WHERE lower(trim(display_name)) = ? LIMIT 2');
const insertDocCustomer = db.prepare('INSERT INTO customers (display_name, phone, phone_norm, email) VALUES (?, ?, ?, ?)');

/**
 * Finds or creates the customer of a document. Runs inside the caller's transaction.
 * @param {number} connectionId
 * @param {{ externalId: string|null, name: string, phone: string, email: string }} c
 * @returns {{ customerId: number|null, matchedBy: 'external_id'|'phone'|'email'|'name'|'new'|'none', created: boolean, linked: boolean }}
 *   linked = a phone, email or name was attached to an existing customer for the first time
 */
export function resolveDocumentCustomer(connectionId, c) {
  const phone = normalizePhone(c.phone);
  const email = normalizeEmail(c.email);
  const name = normalizeName(c.name);
  if (!c.externalId && !phone && !email && !name) return { customerId: null, matchedBy: 'none', created: false, linked: false };

  let customerId = null;
  let matchedBy = null;
  if (c.externalId) customerId = byExternalId.get(connectionId, c.externalId)?.customer_id ?? null;
  if (customerId) matchedBy = 'external_id';
  if (!customerId && phone) {
    customerId = byPhone.get(phone, phone)?.customer_id ?? null;
    if (customerId) matchedBy = 'phone';
  }
  if (!customerId && email) {
    customerId = byEmail.get(email, email)?.customer_id ?? null;
    if (customerId) matchedBy = 'email';
  }
  if (!customerId && name) {
    customerId = byIdentity.get(connectionId, 'name', name)?.customer_id ?? null;
    if (!customerId) {
      const named = customersNamed.all(name);
      if (named.length === 1) customerId = named[0].id; // two customers with this name: do not guess
    }
    if (customerId) matchedBy = 'name';
  }

  let created = false;
  if (!customerId) {
    customerId = Number(insertDocCustomer.run(c.name, c.phone, phone, email).lastInsertRowid);
    matchedBy = 'new';
    created = true;
  }

  let linked = false;
  const add = (kind, value) => {
    const added = value && insertIdentity.run(customerId, connectionId, kind, value).changes;
    if (added && kind === matchedBy) linked = true; // e.g. the first receipt matched to a customer by name
  };
  add('external_id', c.externalId);
  add('phone', phone);
  add('email', email);
  add('name', name);
  return { customerId, matchedBy, created, linked };
}
