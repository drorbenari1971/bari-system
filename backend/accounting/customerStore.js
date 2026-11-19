// Saving provider customer records: one write path for every source (sync, webhook, manual),
// with the audit entry in the same transaction.
import './schema.js'; // tables must exist before statements are prepared
import { db, nowIso } from '../db.js';
import { contentHash, normalizePhone } from './model.js';
import { resolveCustomer, linkIdentities } from './identity.js';
import { tx } from './tx.js';
import { isDeleted } from './customerDelete.js';
import * as audit from './audit.js';

const getRecord = db.prepare('SELECT * FROM acc_customer_records WHERE connection_id = ? AND external_id = ?');

/**
 * The fields that are audited. Income, payments and balance are left out: the provider computes
 * them from documents, which are audited themselves; auditing them would log every invoice twice.
 */
const auditView = (c) => ({
  name: c.name, phone: c.phone, mobile: c.mobile, emails: c.emails, taxId: c.taxId,
  address: c.address, city: c.city, zip: c.zip, country: c.country,
  contactPerson: c.contactPerson, department: c.department, active: c.active, labels: c.labels, remarks: c.remarks,
});

/** A stored row back in the canonical shape. */
export const fromRow = (r) => ({
  externalId: r.external_id, name: r.name, phone: r.phone, mobile: r.mobile, emails: JSON.parse(r.emails),
  taxId: r.tax_id, address: r.address, city: r.city, zip: r.zip, country: r.country,
  contactPerson: r.contact_person, department: r.department, active: !!r.active, labels: JSON.parse(r.labels),
  remarks: r.remarks, incomeAgorot: r.income_agorot, paymentAgorot: r.payment_agorot, balanceAgorot: r.balance_agorot,
  createdAt: r.source_created_at, updatedAt: r.source_updated_at,
});

const hashOf = (c) => contentHash({ ...c, raw: undefined });

const columns = (c) => [
  c.name, c.phone, c.mobile, JSON.stringify(c.emails), c.taxId, c.address, c.city, c.zip, c.country,
  c.contactPerson, c.department, c.active ? 1 : 0, JSON.stringify(c.labels), c.remarks,
  c.incomeAgorot, c.paymentAgorot, c.balanceAgorot, c.createdAt, c.updatedAt, JSON.stringify(c.raw ?? {}), hashOf(c),
];

const insertRecord = db.prepare(`
  INSERT INTO acc_customer_records (
    connection_id, external_id, customer_id,
    name, phone, mobile, emails, tax_id, address, city, zip, country, contact_person, department, active, labels, remarks,
    income_agorot, payment_agorot, balance_agorot, source_created_at, source_updated_at, raw, content_hash, last_seen_run_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateRecord = db.prepare(`
  UPDATE acc_customer_records SET
    name = ?, phone = ?, mobile = ?, emails = ?, tax_id = ?, address = ?, city = ?, zip = ?, country = ?,
    contact_person = ?, department = ?, active = ?, labels = ?, remarks = ?,
    income_agorot = ?, payment_agorot = ?, balance_agorot = ?, source_created_at = ?, source_updated_at = ?,
    raw = ?, content_hash = ?, synced_at = ?, last_seen_run_id = COALESCE(?, last_seen_run_id), missing_runs = 0, removed_at = NULL
  WHERE id = ?
`);
const touchRecord = db.prepare(`
  UPDATE acc_customer_records SET synced_at = ?, last_seen_run_id = COALESCE(?, last_seen_run_id), missing_runs = 0, removed_at = NULL
  WHERE id = ?
`);
const bestRecord = db.prepare(`
  SELECT * FROM acc_customer_records WHERE customer_id = ?
  ORDER BY removed_at IS NOT NULL, source_updated_at DESC, id DESC LIMIT 1
`);
const getCustomerRow = db.prepare('SELECT display_name, phone, phone_norm, email FROM customers WHERE id = ?');
const setCustomer = db.prepare('UPDATE customers SET display_name = ?, phone = ?, phone_norm = ?, email = ?, updated_at = ? WHERE id = ?');

/**
 * The customer's name, phone and email come from its most recently updated record that the
 * provider still has (a customer can have several records, e.g. merged by phone).
 */
export function refreshCustomer(customerId) {
  const best = bestRecord.get(customerId);
  if (!best) return;
  const phone = best.mobile || best.phone;
  const next = { display_name: best.name, phone, phone_norm: normalizePhone(phone), email: JSON.parse(best.emails)[0] ?? '' };
  const current = getCustomerRow.get(customerId);
  if (Object.keys(next).every((k) => current[k] === next[k])) return;
  setCustomer.run(next.display_name, next.phone, next.phone_norm, next.email, nowIso(), customerId);
}

const restoredEntry = (base, customerId) => ({ ...base, action: 'customer.restored_in_source', entityId: customerId, before: { removed: true }, after: { removed: false } });

/**
 * Inserts or updates one provider record. Only real changes are written to the audit log.
 * @param {number} connectionId
 * @param {import('./model.js').CanonicalCustomer} c
 * @param {{ source: string, jobId?: number, runId?: number }} ctx
 * A record of a customer the owner deleted here is skipped ('unchanged').
 * @returns {'added' | 'updated' | 'unchanged'}
 */
export function upsertCustomerRecord(connectionId, c, { source, jobId = null, runId = null }) {
  if (!c.externalId) throw new Error('רשומת לקוח בלי מזהה');
  if (isDeleted(connectionId, 'customer', c.externalId)) return 'unchanged';
  return tx(() => {
    const existing = getRecord.get(connectionId, c.externalId);
    const now = nowIso();
    const base = { source, jobId, entityType: 'customer', externalId: c.externalId };

    if (!existing) {
      const { customerId, matchedBy } = resolveCustomer(connectionId, c);
      insertRecord.run(connectionId, c.externalId, customerId, ...columns(c), runId);
      refreshCustomer(customerId);
      audit.record({
        ...base,
        action: matchedBy ? 'customer.identity_linked' : 'customer.created',
        entityId: customerId,
        after: { ...auditView(c), ...(matchedBy ? { linkedBy: matchedBy } : {}) },
      });
      return 'added';
    }

    if (existing.content_hash === hashOf(c)) {
      touchRecord.run(now, runId, existing.id);
      if (existing.removed_at) {
        refreshCustomer(existing.customer_id);
        audit.record(restoredEntry(base, existing.customer_id));
      }
      return 'unchanged';
    }

    const before = auditView(fromRow(existing));
    const after = auditView(c);
    updateRecord.run(...columns(c), now, runId, existing.id);
    linkIdentities(existing.customer_id, connectionId, c);
    refreshCustomer(existing.customer_id);
    if (audit.diff(before, after).length) {
      const action = before.active && !after.active ? 'customer.deactivated'
        : !before.active && after.active ? 'customer.reactivated' : 'customer.updated';
      audit.record({ ...base, action, entityId: existing.customer_id, before, after });
    }
    if (existing.removed_at) audit.record(restoredEntry(base, existing.customer_id));
    return 'updated';
  });
}

/**
 * After a complete sync run: records the run did not return get one more "missing" mark; after
 * two complete runs in a row they are marked removed at the provider. Nothing is deleted.
 * @returns {number} records newly marked removed
 */
export function markMissingCustomers(connectionId, runId, { source, jobId = null }) {
  return tx(() => {
    db.prepare(`
      UPDATE acc_customer_records SET missing_runs = missing_runs + 1
      WHERE connection_id = ? AND removed_at IS NULL AND (last_seen_run_id IS NULL OR last_seen_run_id <> ?)
    `).run(connectionId, runId);
    const gone = db.prepare('SELECT * FROM acc_customer_records WHERE connection_id = ? AND removed_at IS NULL AND missing_runs >= 2').all(connectionId);
    const now = nowIso();
    for (const r of gone) {
      db.prepare('UPDATE acc_customer_records SET removed_at = ? WHERE id = ?').run(now, r.id);
      refreshCustomer(r.customer_id);
      audit.record({
        action: 'customer.removed_in_source', source, jobId, entityType: 'customer', entityId: r.customer_id,
        externalId: r.external_id, before: { removed: false, name: r.name }, after: { removed: true, name: r.name },
      });
    }
    return gone.length;
  });
}
