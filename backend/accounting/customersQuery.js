// Read side of the customers screen (stage 4): list with purchase stats, customer card, CSV export.
//
// What counts as a purchase: money received - receipts and tax invoice/receipts. Tax invoices are
// shown on the card but not counted (when a business issues an invoice and then a receipt, counting
// both would double the sale). Credit notes reduce the total. Cancelled documents never count.
import './schema.js'; // tables must exist before statements are prepared
import { db } from '../db.js';
import { normalizeName } from './model.js';
import { AccountingError } from './errors.js';
import * as audit from './audit.js';

export const PURCHASE_KINDS = ['receipt', 'invoice_receipt'];
const KINDS_SQL = `('${PURCHASE_KINDS.join("', '")}')`;
const VALID_SQL = "status NOT IN ('cancelled', 'cancelling')";

export const SEGMENTS = {
  all: '1 = 1',
  buyers: 'purchases > 0',
  returning: 'purchases >= 2',
  one_time: 'purchases = 1',
  no_purchases: 'purchases = 0',
};
export const SORTS = {
  last_purchase: 'last_date IS NULL, last_date DESC, id DESC',
  total: 'total DESC, id DESC',
  purchases: 'purchases DESC, total DESC, id DESC',
  name: 'display_name COLLATE NOCASE ASC, id ASC',
  first_purchase: 'first_date IS NULL, first_date ASC, id ASC',
};

// One row per customer with purchase stats and how the customer is known.
const BASE = `
  WITH stats AS (
    SELECT customer_id,
      SUM(CASE WHEN kind IN ${KINDS_SQL} THEN 1 ELSE 0 END) AS purchases,
      SUM(CASE WHEN kind IN ${KINDS_SQL} THEN gross WHEN kind = 'credit_note' THEN -gross ELSE 0 END) AS total,
      MIN(CASE WHEN kind IN ${KINDS_SQL} THEN doc_date END) AS first_date,
      MAX(CASE WHEN kind IN ${KINDS_SQL} THEN doc_date END) AS last_date,
      COUNT(*) AS documents,
      MAX(CASE WHEN customer_match = 'name' THEN 1 ELSE 0 END) AS name_matched,
      MAX(CASE WHEN customer_match = 'email' THEN 1 ELSE 0 END) AS email_matched
    FROM acc_documents WHERE customer_id IS NOT NULL AND ${VALID_SQL}
    GROUP BY customer_id
  )
  SELECT * FROM (
    SELECT c.id, c.display_name, c.phone, c.email, c.created_at,
      COALESCE(s.purchases, 0) AS purchases, COALESCE(s.total, 0) AS total,
      s.first_date, s.last_date, COALESCE(s.documents, 0) AS documents, COALESCE(s.name_matched, 0) AS name_matched, COALESCE(s.email_matched, 0) AS email_matched,
      EXISTS (SELECT 1 FROM acc_customer_records r WHERE r.customer_id = c.id) AS has_card,
      (EXISTS (SELECT 1 FROM acc_customer_records r WHERE r.customer_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM acc_customer_records r WHERE r.customer_id = c.id AND r.removed_at IS NULL)) AS removed
    FROM customers c LEFT JOIN stats s ON s.customer_id = c.id
  )
`;

/** The payment method and app of each customer's latest purchase. */
function lastMethods(ids) {
  if (!ids.length) return new Map();
  const rows = db.prepare(`
    SELECT d.customer_id, d.primary_payment_method AS method,
      (SELECT p.app FROM acc_document_payments p WHERE p.document_id = d.id ORDER BY p.amount DESC LIMIT 1) AS app
    FROM acc_documents d
    WHERE d.id IN (
      SELECT (SELECT d2.id FROM acc_documents d2 WHERE d2.customer_id = c.value AND d2.kind IN ${KINDS_SQL} AND d2.${VALID_SQL}
              ORDER BY d2.doc_date DESC, d2.id DESC LIMIT 1)
      FROM json_each(?) c
    )
  `).all(JSON.stringify(ids));
  return new Map(rows.map((r) => [r.customer_id, { method: r.method, app: r.app ?? '' }]));
}

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

function shape(row, methods) {
  const last = methods.get(row.id);
  return {
    id: row.id,
    name: row.display_name,
    phone: row.phone,
    email: row.email,
    purchases: row.purchases,
    total: row.total,
    average: row.purchases ? Math.round(row.total / row.purchases) : 0,
    firstDate: row.first_date,
    lastDate: row.last_date,
    avgDaysBetween: row.purchases > 1 ? Math.round(daysBetween(row.first_date, row.last_date) / (row.purchases - 1)) : null,
    lastMethod: last?.method ?? null,
    lastApp: last?.app ?? '',
    // The weakest link wins: a customer with any receipt matched only by name shows as 'name'.
    identifiedBy: row.has_card ? 'card' : row.name_matched ? 'name' : row.email_matched ? 'email' : 'document',
    removed: !!row.removed,
  };
}

/** Builds the WHERE clause for the search text and segment. */
function filters({ q, segment }) {
  const where = [SEGMENTS[segment] ?? SEGMENTS.all];
  const args = [];
  const text = normalizeName(q);
  if (text) {
    const digits = text.replace(/\D/g, '');
    const parts = ['lower(display_name) LIKE ?', 'lower(email) LIKE ?'];
    args.push(`%${text}%`, `%${text}%`);
    if (digits.length >= 3) {
      parts.push("replace(replace(replace(phone, '-', ''), ' ', ''), '+972', '0') LIKE ?");
      args.push(`%${digits.startsWith('972') ? `0${digits.slice(3)}` : digits}%`);
    }
    where.push(`(${parts.join(' OR ')})`);
  }
  return { sql: `WHERE ${where.join(' AND ')}`, args };
}

/**
 * @param {{ q?: string, segment?: string, sort?: string, page?: number, pageSize?: number }} opts
 */
export function listCustomers({ q = '', segment = 'all', sort = 'last_purchase', page = 1, pageSize = 50 } = {}) {
  if (!SEGMENTS[segment]) throw new AccountingError('סינון לא מוכר', { code: 'validation' });
  if (!SORTS[sort]) throw new AccountingError('מיון לא מוכר', { code: 'validation' });
  const size = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
  const current = Math.max(Number(page) || 1, 1);
  const { sql, args } = filters({ q, segment });
  const total = db.prepare(`${BASE} ${sql}`.replace('SELECT * FROM (', 'SELECT COUNT(*) AS n FROM (')).get(...args).n;
  const rows = db.prepare(`${BASE} ${sql} ORDER BY ${SORTS[sort]} LIMIT ? OFFSET ?`).all(...args, size, (current - 1) * size);
  const methods = lastMethods(rows.map((r) => r.id));
  return { items: rows.map((r) => shape(r, methods)), total, page: current, pageSize: size };
}

/** Headline numbers for the whole customer base (not filtered). */
export function customersSummary() {
  const s = db.prepare(`
    SELECT COUNT(*) AS customers,
      SUM(CASE WHEN purchases > 0 THEN 1 ELSE 0 END) AS buyers,
      SUM(CASE WHEN purchases >= 2 THEN 1 ELSE 0 END) AS returning_customers,
      COALESCE(SUM(total), 0) AS revenue,
      COALESCE(SUM(purchases), 0) AS purchases
    FROM (${BASE})
  `).get();
  return {
    customers: s.customers,
    buyers: s.buyers ?? 0,
    returning: s.returning_customers ?? 0,
    revenue: s.revenue,
    purchases: s.purchases,
    returningShare: s.buyers ? Math.round(((s.returning_customers ?? 0) / s.buyers) * 100) : 0,
    averagePerBuyer: s.buyers ? Math.round(s.revenue / s.buyers) : 0,
  };
}

/** Everything about one customer: stats, Morning card, documents with payments, identities, history. */
export function getCustomerCard(id) {
  const row = db.prepare(`${BASE} WHERE id = ?`).get(Number(id));
  if (!row) throw new AccountingError('הלקוח לא נמצא', { code: 'not_found', status: 404 });
  const customer = shape(row, lastMethods([row.id]));

  const documents = db.prepare(`
    SELECT id, external_id, kind, status, number, doc_date, gross, net, vat, description, customer_match, pdf_url, primary_payment_method
    FROM acc_documents WHERE customer_id = ? ORDER BY doc_date DESC, id DESC
  `).all(row.id);
  const payments = db.prepare(`
    SELECT document_id, method, label, app, amount FROM acc_document_payments
    WHERE document_id IN (SELECT id FROM acc_documents WHERE customer_id = ?) ORDER BY document_id, row
  `).all(row.id);
  const lines = db.prepare(`
    SELECT document_id, description, quantity, total FROM acc_document_lines
    WHERE document_id IN (SELECT id FROM acc_documents WHERE customer_id = ?) ORDER BY document_id, row
  `).all(row.id);
  const byDoc = (list) => list.reduce((m, x) => m.set(x.document_id, [...(m.get(x.document_id) ?? []), x]), new Map());
  const payBy = byDoc(payments);
  const lineBy = byDoc(lines);

  const cards = db.prepare(`
    SELECT external_id, name, phone, mobile, emails, tax_id, address, city, contact_person, active, remarks,
      source_created_at, removed_at
    FROM acc_customer_records WHERE customer_id = ? ORDER BY id
  `).all(row.id).map((r) => ({ ...r, emails: JSON.parse(r.emails), active: !!r.active }));

  const methodTotals = Object.values(payments.reduce((m, p) => {
    const key = p.app || p.method;
    m[key] = { key, method: p.method, app: p.app, count: (m[key]?.count ?? 0) + 1, amount: (m[key]?.amount ?? 0) + p.amount };
    return m;
  }, {})).sort((a, b) => b.amount - a.amount);

  return {
    ...customer,
    createdAt: row.created_at,
    cards,
    identities: db.prepare('SELECT kind, value FROM customer_identities WHERE customer_id = ? ORDER BY kind, value').all(row.id),
    methods: methodTotals,
    documents: documents.map((d) => ({
      id: d.id, externalId: d.external_id, kind: d.kind, status: d.status, number: d.number, date: d.doc_date,
      gross: d.gross, net: d.net, vat: d.vat, description: d.description, customerMatch: d.customer_match, pdfUrl: d.pdf_url,
      counted: PURCHASE_KINDS.includes(d.kind) && !['cancelled', 'cancelling'].includes(d.status),
      payments: (payBy.get(d.id) ?? []).map(({ method, label, app, amount }) => ({ method, label, app, amount })),
      lines: (lineBy.get(d.id) ?? []).map(({ description, quantity, total }) => ({ description, quantity, total })),
    })),
    history: audit.list({ entityType: 'customer', entityId: row.id, pageSize: 50 }).items
      .map((a) => ({ at: a.at, action: a.action, source: a.source, changes: a.changes.map((c) => c.field), linkedBy: a.after?.linkedBy ?? null })),
  };
}

const METHOD_LABELS = { app: 'אפליקציה', bank_transfer: 'העברה בנקאית', cash: 'מזומן', card: 'כרטיס אשראי', cheque: "צ'ק", paypal: 'PayPal', withholding: 'ניכוי במקור', other: 'אחר' };
const IDENTIFIED_LABELS = { card: 'כרטיס לקוח ב-Morning', name: 'לפי שם בקבלה', email: 'לפי מייל בקבלה', document: 'מתוך קבלה' };

/** A spreadsheet cell: quoted, and never read by Excel as a formula. */
function cell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** All customers matching the filters, as CSV that opens in Excel (UTF-8 with BOM). */
export function exportCustomersCsv({ q = '', segment = 'all', sort = 'last_purchase' } = {}) {
  const items = [];
  for (let page = 1; ; page++) {
    const r = listCustomers({ q, segment, sort, page, pageSize: 200 });
    items.push(...r.items);
    if (items.length >= r.total || !r.items.length) break;
  }
  const header = ['שם', 'טלפון', 'מייל', 'רכישות', 'סה"כ (₪)', 'ממוצע לרכישה (₪)', 'רכישה ראשונה', 'רכישה אחרונה', 'ימים בממוצע בין רכישות', 'אמצעי תשלום אחרון', 'זיהוי', 'הוסר ב-Morning'];
  const lines = items.map((c) => [
    c.name, c.phone, c.email, c.purchases, (c.total / 100).toFixed(2), (c.average / 100).toFixed(2),
    c.firstDate ?? '', c.lastDate ?? '', c.avgDaysBetween ?? '', c.lastApp || METHOD_LABELS[c.lastMethod] || '',
    IDENTIFIED_LABELS[c.identifiedBy], c.removed ? 'כן' : '',
  ].map(cell).join(','));
  return `﻿${[header.map(cell).join(','), ...lines].join('\r\n')}\r\n`;
}
