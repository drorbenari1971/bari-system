// Saving provider documents (with their item rows and payments): one write path for every source,
// with the audit entries in the same transaction. Only real changes are written.
import './schema.js'; // tables must exist before statements are prepared
import { db, nowIso } from '../db.js';
import { contentHash, productKey } from './model.js';
import { resolveDocumentCustomer } from './identity.js';
import { tx } from './tx.js';
import * as audit from './audit.js';

const getDoc = db.prepare('SELECT * FROM acc_documents WHERE connection_id = ? AND external_id = ?');

const hashOf = (d) => contentHash({ ...d, raw: undefined });

/** The method that carried most of the money (for lists and filters). */
const primaryMethod = (payments) => [...payments].sort((a, b) => b.amount - a.amount)[0]?.method ?? '';

/** What the audit log records about a document. */
const auditView = (d, customerName) => ({
  kind: d.kind, status: d.status, number: d.number, date: d.date, currency: d.currency,
  gross: d.totals.gross, net: d.totals.net, vat: d.totals.vat, description: d.description,
  name: customerName, customerExternalId: d.customer.externalId,
  lines: d.lines.map((l) => ({ description: l.description, quantity: l.quantity, total: l.total })),
  payments: d.payments.map((p) => ({ method: p.method, app: p.app, amount: p.amount })),
});

/** The stored row back in the audited shape. */
function storedView(row) {
  const lines = db.prepare('SELECT description, quantity, total FROM acc_document_lines WHERE document_id = ? ORDER BY row').all(row.id);
  const payments = db.prepare('SELECT method, app, amount FROM acc_document_payments WHERE document_id = ? ORDER BY row').all(row.id);
  return {
    kind: row.kind, status: row.status, number: row.number, date: row.doc_date, currency: row.currency,
    gross: row.gross, net: row.net, vat: row.vat, description: row.description,
    name: row.customer_name, customerExternalId: row.customer_external_id,
    lines: lines.map((l) => ({ ...l })), payments: payments.map((p) => ({ ...p })),
  };
}

const docColumns = (d, customerId, match) => [
  d.kind, d.typeCode, d.status, d.number, d.date, d.createdAt, d.currency, d.totals.gross, d.totals.net, d.totals.vat,
  d.description, customerId, d.customer.externalId, match, d.customer.name, d.customer.phone, d.customer.email,
  primaryMethod(d.payments), d.pdfUrl, JSON.stringify(d.linkedExternalIds), JSON.stringify(d.raw ?? {}), hashOf(d),
];

const insertDoc = db.prepare(`
  INSERT INTO acc_documents (
    connection_id, external_id, kind, type_code, status, number, doc_date, created_at_ext, currency, gross, net, vat,
    description, customer_id, customer_external_id, customer_match, customer_name, customer_phone, customer_email,
    primary_payment_method, pdf_url, linked_ids, raw, content_hash
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateDoc = db.prepare(`
  UPDATE acc_documents SET
    kind = ?, type_code = ?, status = ?, number = ?, doc_date = ?, created_at_ext = ?, currency = ?, gross = ?, net = ?, vat = ?,
    description = ?, customer_id = ?, customer_external_id = ?, customer_match = ?, customer_name = ?, customer_phone = ?, customer_email = ?,
    primary_payment_method = ?, pdf_url = ?, linked_ids = ?, raw = ?, content_hash = ?, changed_at = ?, synced_at = ?
  WHERE id = ?
`);
const touchDoc = db.prepare('UPDATE acc_documents SET synced_at = ? WHERE id = ?');
const insertLine = db.prepare(`
  INSERT INTO acc_document_lines (document_id, row, sku, external_item_id, description, product_key, quantity, unit_price, total)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertPayment = db.prepare('INSERT INTO acc_document_payments (document_id, row, method, label, app, amount) VALUES (?, ?, ?, ?, ?, ?)');

function writeRows(documentId, d) {
  db.prepare('DELETE FROM acc_document_lines WHERE document_id = ?').run(documentId);
  db.prepare('DELETE FROM acc_document_payments WHERE document_id = ?').run(documentId);
  d.lines.forEach((l, i) => insertLine.run(documentId, i + 1, l.sku, l.externalItemId, l.description, productKey(l), l.quantity, l.unitPrice, l.total));
  d.payments.forEach((p, i) => insertPayment.run(documentId, i + 1, p.method, p.label, p.app, p.amount));
}

/** Audit entries for a customer that a document created, or newly matched by phone, email or name. */
function auditCustomer(resolved, d, base) {
  if (resolved.created) {
    audit.record({ ...base, action: 'customer.created', entityType: 'customer', entityId: resolved.customerId, externalId: d.customer.externalId, after: { name: d.customer.name, email: d.customer.email || undefined, origin: 'document', document: d.number } });
  } else if (resolved.linked) {
    audit.record({ ...base, action: 'customer.identity_linked', entityType: 'customer', entityId: resolved.customerId, externalId: d.customer.externalId, after: { name: d.customer.name, linkedBy: resolved.matchedBy, document: d.number } });
  }
}

/**
 * Inserts or updates one provider document with its rows and payments.
 * @param {number} connectionId
 * @param {import('./model.js').CanonicalDocument} d
 * @param {{ source: string, jobId?: number }} ctx
 * @returns {'added' | 'updated' | 'unchanged'}
 */
export function upsertDocument(connectionId, d, { source, jobId = null }) {
  if (!d.externalId) throw new Error('מסמך בלי מזהה');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) throw new Error(`מסמך ${d.number}: תאריך לא תקין`);
  return tx(() => {
    const existing = getDoc.get(connectionId, d.externalId);
    const now = nowIso();
    const base = { source, jobId };

    if (existing?.content_hash === hashOf(d)) {
      touchDoc.run(now, existing.id);
      return 'unchanged';
    }

    const resolved = resolveDocumentCustomer(connectionId, d.customer);
    auditCustomer(resolved, d, base);

    if (!existing) {
      const id = Number(insertDoc.run(connectionId, d.externalId, ...docColumns(d, resolved.customerId, resolved.matchedBy)).lastInsertRowid);
      writeRows(id, d);
      audit.record({ ...base, action: 'document.created', entityType: 'document', entityId: id, externalId: d.externalId, after: { ...auditView(d, d.customer.name), customerMatch: resolved.matchedBy } });
      return 'added';
    }

    const before = storedView(existing);
    updateDoc.run(...docColumns(d, resolved.customerId, resolved.matchedBy), now, now, existing.id);
    writeRows(existing.id, d);
    const after = auditView(d, d.customer.name);
    if (audit.diff(before, after).length) {
      const action = before.status !== 'cancelled' && after.status === 'cancelled' ? 'document.cancelled' : 'document.updated';
      audit.record({ ...base, action, entityType: 'document', entityId: existing.id, externalId: d.externalId, before, after });
    }
    return 'updated';
  });
}

export const countDocuments = (connectionId) => db.prepare('SELECT COUNT(*) AS n FROM acc_documents WHERE connection_id = ?').get(connectionId).n;
