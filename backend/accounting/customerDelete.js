// Deleting a customer (customers tab, "מחיקת לקוח"), as the owner chose:
//   - the customer's Morning card is deleted too, when Morning allows it: Morning deletes only a card
//     with no documents, so a card that has receipts stays in Morning (receipts are legal documents);
//   - the customer's receipts are deleted from this system only, never from Morning.
// Every deleted provider ID is kept in acc_deleted_records, so the next sync does not bring the
// customer or the receipts back. Morning is called first: if it refuses, nothing is deleted here.
import './schema.js'; // tables must exist before statements are prepared
import { db } from '../db.js';
import { getConnection } from './connections.js';
import { getProvider } from './providers/index.js';
import { AccountingError } from './errors.js';
import { tx } from './tx.js';
import * as audit from './audit.js';

// Injectable provider dependencies (fetch, sleep), for tests.
let providerDeps = {};
export const setDeleteDeps = (deps = {}) => { providerDeps = deps; };

const isDeletedStmt = db.prepare('SELECT 1 FROM acc_deleted_records WHERE connection_id = ? AND kind = ? AND external_id = ?');
const markDeleted = db.prepare('INSERT OR IGNORE INTO acc_deleted_records (connection_id, kind, external_id, customer_id) VALUES (?, ?, ?, ?)');

/** True when the owner deleted this provider record here: syncs and webhooks skip it. */
export const isDeleted = (connectionId, kind, externalId) => !!externalId && !!isDeletedStmt.get(connectionId, kind, String(externalId));

const documentsOnCard = db.prepare('SELECT COUNT(*) AS n FROM acc_documents WHERE connection_id = ? AND customer_external_id = ?');

/** What deleting the customer would do, for the confirmation dialog and as the plan for deleteCustomer. */
export function deletePlan(customerId) {
  const customer = db.prepare('SELECT id, display_name, phone, email FROM customers WHERE id = ?').get(Number(customerId));
  if (!customer) throw new AccountingError('הלקוח לא נמצא', { code: 'not_found', status: 404 });
  const documents = db.prepare('SELECT COUNT(*) AS n FROM acc_documents WHERE customer_id = ?').get(customer.id).n;
  const cards = db.prepare('SELECT connection_id, external_id, name, active, removed_at FROM acc_customer_records WHERE customer_id = ? ORDER BY id')
    .all(customer.id)
    .map((r) => ({
      connectionId: r.connection_id,
      externalId: r.external_id,
      name: r.name,
      active: !!r.active,
      // already_removed: Morning no longer has it; has_documents: Morning keeps it; delete: deleted in Morning
      morning: r.removed_at ? 'already_removed' : documentsOnCard.get(r.connection_id, r.external_id).n ? 'has_documents' : 'delete',
    }));
  return { customer: { id: customer.id, name: customer.display_name, phone: customer.phone, email: customer.email }, documents, cards };
}

async function deleteAtProvider(card) {
  const conn = getConnection(card.connectionId);
  if (!conn?.enabled) throw new AccountingError('החיבור ל-Morning מושבת. הפעילו אותו כדי למחוק את כרטיס הלקוח.', { code: 'conflict', status: 409 });
  const provider = getProvider(conn.provider);
  if (typeof provider.deleteCustomer !== 'function') throw new AccountingError('הספק לא תומך במחיקת לקוחות', { code: 'validation' });
  try {
    return await provider.deleteCustomer(conn, card.externalId, { active: card.active }, providerDeps);
  } catch (err) {
    if (!(err instanceof AccountingError)) throw err;
    const reason = err.code === 'request_error'
      ? 'Morning לא אישרה את המחיקה (כנראה יש לכרטיס מסמכים, אסימון תשלום או חיוב חוזר ב-Morning).'
      : err.message;
    throw new AccountingError(`${reason} הלקוח לא נמחק.`, { code: err.code === 'request_error' ? 'conflict' : err.code, status: err.code === 'request_error' ? 409 : err.status, retryable: err.retryable });
  }
}

/**
 * Deletes the customer: Morning card(s) first (only those Morning allows), then everything local in
 * one transaction, with an audit entry.
 * @returns {{ id: number, name: string, documents: number, cards: { externalId: string, morning: string }[] }}
 */
export async function deleteCustomer(customerId, { source = 'manual' } = {}) {
  const plan = deletePlan(customerId);
  const id = plan.customer.id;

  for (const card of plan.cards) {
    if (card.morning !== 'delete') continue;
    const outcome = await deleteAtProvider(card);
    if (outcome === 'not_found') card.morning = 'already_removed';
  }

  return tx(() => {
    if (!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(id)) throw new AccountingError('הלקוח כבר נמחק', { code: 'not_found', status: 404 });
    const docs = db.prepare('SELECT id, connection_id, external_id FROM acc_documents WHERE customer_id = ?').all(id);
    for (const d of docs) markDeleted.run(d.connection_id, 'document', d.external_id, id);
    for (const c of plan.cards) markDeleted.run(c.connectionId, 'customer', c.externalId, id);
    db.prepare('DELETE FROM acc_documents WHERE customer_id = ?').run(id); // item rows, payments and facts cascade
    db.prepare('DELETE FROM acc_customer_records WHERE customer_id = ?').run(id);
    db.prepare('UPDATE acc_orders SET customer_id = NULL WHERE customer_id = ?').run(id); // orders stay as history
    db.prepare('DELETE FROM customers WHERE id = ?').run(id); // identities cascade
    const cards = plan.cards.map((c) => ({ externalId: c.externalId, morning: c.morning }));
    audit.record({
      action: 'customer.deleted', source, entityType: 'customer', entityId: id,
      before: { ...plan.customer, documents: docs.length },
      after: { deleted: true, cards },
    });
    return { id, name: plan.customer.name, documents: docs.length, cards };
  });
}
