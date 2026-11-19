// "הזמנה חדשה": customer intake + an order + a receipt issued at the provider (Morning).
//
// A receipt is a legal document: it cannot be deleted, only cancelled with another document, and the
// provider offers no idempotency key. So:
//   - every opened form has its own order key; repeating a submit returns the same order;
//   - the order row (and its step) is saved BEFORE each provider call;
//   - a create call that failed without a clear answer (network, timeout, server error) is never
//     retried automatically: the order becomes 'uncertain' until reconcileOrder() checks the provider.
// Steps: draft -> client_created -> issuing -> issued | failed | uncertain.
import './schema.js'; // tables must exist before statements are prepared
import { db, nowIso } from '../db.js';
import { getConnection } from './connections.js';
import { getProvider } from './providers/index.js';
import { upsertCustomerRecord } from './customerStore.js';
import { upsertDocument } from './documentStore.js';
import { linkIdentities } from './identity.js';
import { normalizePhone, normalizeEmail, normalizeName } from './model.js';
import * as queue from './queue.js';
import { kick } from './worker.js';
import { AccountingError } from './errors.js';
import { tx } from './tx.js';
import * as audit from './audit.js';

export const METHODS = ['app', 'bank_transfer', 'cash', 'card', 'other'];
export const APPS = ['Bit', 'PayBox', 'Pay', 'Google Pay', 'Apple Pay'];
const MAX_LINES = 30;
const MAX_PRICE_AGOROT = 10_000_000; // 100,000 ₪ per unit
const CATALOG_TTL_MS = 5 * 60_000;
const ORDER_KEY_RE = /^[A-Za-z0-9-]{8,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISSUE_MATCH_WINDOW_MS = 10 * 60_000;

// Injectable provider dependencies (fetch, sleep), for tests.
let providerDeps = {};
export const setOrderDeps = (deps = {}) => { providerDeps = deps; };

const invalid = (message) => new AccountingError(message, { code: 'validation' });
const text = (v, max, label) => {
  const s = String(v ?? '').trim();
  if (s.length > max) throw invalid(`${label}: עד ${max} תווים`);
  return s;
};
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
function validDate(v, label, today) {
  const s = String(v ?? '').trim();
  if (!DATE_RE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`)) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) throw invalid(`${label}: תאריך לא תקין`);
  if (s > today) throw invalid(`${label}: אי אפשר תאריך עתידי`);
  return s;
}

function requireConnection(connectionId) {
  const conn = getConnection(connectionId);
  if (!conn) throw new AccountingError('החיבור לא נמצא', { code: 'not_found', status: 404 });
  if (!conn.enabled) throw new AccountingError('החיבור מושבת. הפעילו אותו כדי להפיק קבלות.', { code: 'conflict', status: 409 });
  const provider = getProvider(conn.provider);
  if (!provider.capabilities.issuesReceipts) throw invalid('הספק לא תומך בהפקת קבלות');
  return { conn, provider };
}

/** The local customer for an existing-customer order, with its provider card (if any) and email. */
function existingCustomer(connectionId, customerId) {
  const c = db.prepare('SELECT id, display_name, phone, email FROM customers WHERE id = ?').get(Number(customerId));
  if (!c) throw invalid('הלקוח לא נמצא');
  const card = db.prepare(`
    SELECT r.external_id, r.removed_at FROM customer_identities i
    JOIN acc_customer_records r ON r.connection_id = i.connection_id AND r.external_id = i.value
    WHERE i.connection_id = ? AND i.customer_id = ? AND i.kind = 'external_id'
    ORDER BY r.removed_at IS NOT NULL, r.id DESC LIMIT 1
  `).get(connectionId, c.id);
  return {
    mode: 'existing', customerId: c.id, externalId: card && !card.removed_at ? card.external_id : null,
    name: c.display_name, mobile: c.phone, email: normalizeEmail(c.email),
  };
}

/**
 * Validates the form and returns the canonical order. Throws Hebrew validation errors.
 * Money is in agorot. Card and bank numbers are not accepted at all.
 */
export function normalizeOrder(connectionId, input = {}, today = localToday()) {
  const ci = input.customer ?? {};
  let customer;
  if (ci.mode === 'existing') {
    customer = existingCustomer(connectionId, ci.customerId);
  } else if (ci.mode === 'new') {
    const name = text(ci.name, 100, 'שם הלקוח');
    if (!name) throw invalid('חסר שם לקוח');
    const mobileRaw = text(ci.mobile, 30, 'נייד');
    const mobile = mobileRaw ? normalizePhone(mobileRaw) : '';
    if (mobileRaw && !mobile) throw invalid('מספר הנייד לא תקין');
    const emailRaw = text(ci.email, 120, 'מייל');
    const email = emailRaw ? normalizeEmail(emailRaw) : '';
    if (emailRaw && !email) throw invalid('כתובת המייל לא תקינה');
    const taxId = text(ci.taxId, 12, 'ח.פ/ת.ז');
    if (taxId && !/^\d{5,9}$/.test(taxId)) throw invalid('ח.פ/ת.ז: 5 עד 9 ספרות');
    customer = {
      mode: 'new', customerId: null, externalId: null, name, mobile, email, taxId,
      address: text(ci.address, 120, 'כתובת'), city: text(ci.city, 60, 'עיר'), remarks: text(ci.remarks, 300, 'הערות ללקוח'),
    };
  } else {
    throw invalid('בחרו לקוח קיים או לקוח חדש');
  }

  if (!Array.isArray(input.lines) || !input.lines.length) throw invalid('הוסיפו לפחות מוצר אחד');
  if (input.lines.length > MAX_LINES) throw invalid(`עד ${MAX_LINES} שורות בהזמנה`);
  const lines = input.lines.map((l, i) => {
    const description = text(l?.description, 120, `שורה ${i + 1}`);
    if (!description) throw invalid(`שורה ${i + 1}: חסר תיאור`);
    const quantity = Number(l?.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1000 || Math.round(quantity * 1000) !== quantity * 1000) throw invalid(`שורה ${i + 1}: כמות לא תקינה`);
    const unitPrice = Number(l?.unitPrice);
    if (!Number.isInteger(unitPrice) || unitPrice < 0 || unitPrice > MAX_PRICE_AGOROT) throw invalid(`שורה ${i + 1}: מחיר לא תקין`);
    return { description, quantity, unitPrice, itemId: text(l?.itemId, 64, 'מזהה מוצר') || null, sku: text(l?.sku, 40, 'מק"ט') || null };
  });
  const total = lines.reduce((n, l) => n + Math.round(l.quantity * l.unitPrice), 0);
  if (total <= 0) throw invalid('סכום ההזמנה חייב להיות גדול מאפס');

  const pi = input.payment ?? {};
  if (!METHODS.includes(pi.method)) throw invalid('בחרו אמצעי תשלום');
  if (pi.method === 'app' && !APPS.includes(pi.app)) throw invalid('בחרו את אפליקציית התשלום');
  if (Number(pi.amount) !== total) throw invalid('סכום התשלום חייב להיות שווה לסכום ההזמנה');
  const payment = {
    method: pi.method, app: pi.method === 'app' ? pi.app : '', amount: total,
    date: validDate(pi.date, 'תאריך התשלום', today), reference: text(pi.reference, 60, 'אסמכתה'),
  };

  const ri = input.receipt ?? {};
  const receipt = {
    date: validDate(ri.date, 'תאריך הקבלה', today),
    description: text(ri.description, 120, 'תיאור הקבלה'),
    remarks: text(ri.remarks, 300, 'הערות בקבלה'),
    sendEmail: ri.sendEmail === true,
  };
  if (receipt.sendEmail && !customer.email) throw invalid('כדי לשלוח את הקבלה במייל צריך כתובת מייל של הלקוח');
  return { customer, lines, payment, receipt, total };
}

// ---- catalog
const catalogCache = new Map();
export async function catalog(connectionId) {
  const { conn, provider } = requireConnection(connectionId);
  const hit = catalogCache.get(conn.id);
  if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.items;
  const items = await provider.listItems(conn, providerDeps);
  catalogCache.set(conn.id, { at: Date.now(), items });
  return items;
}
export const clearCatalogCache = () => catalogCache.clear();

/** The receipt as a PDF before issuing it (nothing is created). */
export async function previewOrder(connectionId, input) {
  const { conn, provider } = requireConnection(connectionId);
  const order = normalizeOrder(conn.id, input);
  return provider.previewReceipt(conn, order, providerDeps);
}

// ---- orders
const parse = (r) => (r ? { ...r, data: JSON.parse(r.data) } : null);
const getRow = (id) => parse(db.prepare('SELECT * FROM acc_orders WHERE id = ?').get(id));
const byKey = (key) => parse(db.prepare('SELECT * FROM acc_orders WHERE order_key = ?').get(key));

/** What the screen sees. */
export function orderView(row) {
  if (!row) return null;
  const d = row.data;
  return {
    id: row.id, orderKey: row.order_key, status: row.status, customerId: row.customer_id, customerName: row.customer_name,
    total: row.total, payment: { method: d.payment.method, app: d.payment.app }, lines: d.lines.map(({ description, quantity, unitPrice }) => ({ description, quantity, unitPrice })),
    receiptDate: d.receipt.date, sendEmail: d.receipt.sendEmail,
    documentNumber: row.document_number, pdfUrl: row.pdf_url, error: row.error,
    createdAt: row.created_at, issuedAt: row.issued_at,
  };
}

function setStatus(id, fields, auditEntry) {
  const keys = Object.keys(fields);
  tx(() => {
    db.prepare(`UPDATE acc_orders SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => fields[k]), nowIso(), id);
    if (auditEntry) audit.record({ source: 'manual', entityType: 'order', entityId: id, ...auditEntry });
  });
}

/** After a client creation whose answer was lost: look for that client before creating another. */
async function findCreatedClient(provider, conn, customer) {
  const phone = normalizePhone(customer.mobile);
  for (let page = 1; page <= 50; page++) {
    const r = await provider.listCustomers(conn, { page, pageSize: 100 }, providerDeps);
    const hit = r.items.find((c) => normalizeName(c.name) === normalizeName(customer.name)
      && ((phone && (normalizePhone(c.mobile) === phone || normalizePhone(c.phone) === phone)) || (customer.email && c.emails.includes(customer.email))));
    if (hit) return hit;
    if (page >= r.pages) return null;
  }
  return null;
}

/** Brings the issued receipt into the local data now; if that fails, the queue fetches it later. */
async function importDocument(provider, conn, externalId, orderId) {
  try {
    const doc = await provider.getDocument(conn, externalId, providerDeps);
    if (doc) upsertDocument(conn.id, doc, { source: 'manual' });
  } catch {
    queue.enqueue({ type: 'fetch_document', source: 'manual', connectionId: conn.id, payload: { externalId, orderId }, dedupeKey: `fetch_document:${conn.id}:${externalId}` });
    kick();
  }
}

/**
 * Creates (or continues) the order with this key: the client card if needed, then the receipt.
 * @returns {object} orderView
 */
export async function submitOrder(connectionId, orderKey, input) {
  if (!ORDER_KEY_RE.test(String(orderKey ?? ''))) throw invalid('מזהה הזמנה לא תקין');
  const { conn, provider } = requireConnection(connectionId);

  let row = byKey(orderKey);
  if (row && ['issued', 'issuing', 'uncertain'].includes(row.status)) return orderView(row); // never issue twice
  const order = normalizeOrder(conn.id, input);
  if (row) {
    // A failed or interrupted order is continued: keep the client already created at the provider.
    if (row.customer_external_id && order.customer.mode === 'new') {
      order.customer = { ...order.customer, mode: 'existing', externalId: row.customer_external_id, customerId: row.customer_id };
    }
    db.prepare('UPDATE acc_orders SET data = ?, total = ?, customer_name = ?, error = NULL, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(order), order.total, order.customer.name, nowIso(), row.id);
  } else {
    const id = tx(() => {
      const newId = Number(db.prepare(`
        INSERT INTO acc_orders (order_key, connection_id, status, customer_id, customer_external_id, customer_name, data, total)
        VALUES (?, ?, 'draft', ?, ?, ?, ?, ?)
      `).run(orderKey, conn.id, order.customer.customerId, order.customer.externalId, order.customer.name, JSON.stringify(order), order.total).lastInsertRowid);
      audit.record({ action: 'order.created', source: 'manual', entityType: 'order', entityId: newId, after: { name: order.customer.name, total: order.total, lines: order.lines.length, method: order.payment.app || order.payment.method } });
      return newId;
    });
    row = getRow(id);
  }

  // 1. The client card at the provider (new customers, and receipt-only customers without a card).
  if (!order.customer.externalId) {
    let created = row.client_uncertain ? await findCreatedClient(provider, conn, order.customer) : null;
    if (!created) {
      try {
        created = await provider.createCustomer(conn, order.customer, providerDeps);
      } catch (err) {
        setStatus(row.id, { status: 'failed', error: err.message, client_uncertain: err.uncertain ? 1 : 0 }, { action: 'order.failed', after: { step: 'client', error: err.message, uncertain: !!err.uncertain } });
        return orderView(getRow(row.id));
      }
    }
    // An existing local customer (e.g. known only from receipts) keeps its history: the new card joins it.
    if (order.customer.customerId) linkIdentities(order.customer.customerId, conn.id, created);
    upsertCustomerRecord(conn.id, created, { source: 'manual' });
    const customerId = db.prepare("SELECT customer_id FROM customer_identities WHERE connection_id = ? AND kind = 'external_id' AND value = ?").get(conn.id, created.externalId).customer_id;
    order.customer = { ...order.customer, externalId: created.externalId, customerId };
    setStatus(row.id, { status: 'client_created', customer_external_id: created.externalId, customer_id: customerId, client_uncertain: 0, data: JSON.stringify(order) },
      { action: 'order.client_created', externalId: created.externalId, after: { name: order.customer.name } });
  }

  // 2. The receipt. The 'issuing' step is saved first; a lost answer leaves the order uncertain.
  setStatus(row.id, { status: 'issuing', issuing_at: nowIso(), error: null });
  let issued;
  try {
    issued = await provider.createReceipt(conn, order, providerDeps);
  } catch (err) {
    const status = err.uncertain ? 'uncertain' : 'failed';
    const error = err.uncertain ? `לא ידוע אם הקבלה נוצרה ב-Morning (${err.message}). לחצו "בדיקה" לפני כל ניסיון נוסף.` : err.message;
    setStatus(row.id, { status, error }, { action: `order.${status}`, after: { step: 'receipt', error: err.message } });
    return orderView(getRow(row.id));
  }
  setStatus(row.id, { status: 'issued', document_external_id: issued.externalId, document_number: issued.number, pdf_url: issued.pdfUrl, issued_at: nowIso() },
    { action: 'order.issued', externalId: issued.externalId, after: { number: issued.number, total: order.total, name: order.customer.name } });
  await importDocument(provider, conn, issued.externalId, row.id);
  return orderView(getRow(row.id));
}

/**
 * For an uncertain order: looks at the provider for a receipt of this client, date and amount created
 * since the issue started. Found: the order is issued. Not found: it is failed and can be tried again.
 */
export async function reconcileOrder(orderId) {
  const row = getRow(Number(orderId));
  if (!row) throw new AccountingError('ההזמנה לא נמצאה', { code: 'not_found', status: 404 });
  if (row.status !== 'uncertain' && row.status !== 'issuing') throw new AccountingError('רק הזמנה במצב "לא ודאי" נבדקת', { code: 'conflict', status: 409 });
  const { conn, provider } = requireConnection(row.connection_id);
  const since = Date.parse(row.issuing_at ?? row.updated_at) - ISSUE_MATCH_WINDOW_MS;
  const candidates = (await provider.findReceipts(conn, { clientId: row.customer_external_id, date: row.data.receipt.date }, providerDeps))
    .filter((d) => d.kind === 'receipt' && d.totals.gross === row.total && (!d.createdAt || Date.parse(d.createdAt) >= since))
    .filter((d) => !db.prepare("SELECT 1 FROM acc_orders WHERE document_external_id = ? AND status = 'issued'").get(d.externalId));
  if (!candidates.length) {
    setStatus(row.id, { status: 'failed', error: 'הקבלה לא נוצרה ב-Morning. אפשר לנסות שוב.' }, { action: 'order.reconciled', after: { found: false } });
    return orderView(getRow(row.id));
  }
  const doc = candidates.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
  setStatus(row.id, { status: 'issued', document_external_id: doc.externalId, document_number: doc.number, pdf_url: doc.pdfUrl, issued_at: nowIso(), error: null },
    { action: 'order.reconciled', externalId: doc.externalId, after: { found: true, number: doc.number } });
  upsertDocument(conn.id, doc, { source: 'manual' });
  return orderView(getRow(row.id));
}

export const getOrder = (id) => orderView(getRow(Number(id)));

export function listOrders({ status, page = 1, pageSize = 20 } = {}) {
  const size = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
  const current = Math.max(Number(page) || 1, 1);
  const where = status ? 'WHERE status = ?' : '';
  const args = status ? [status] : [];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM acc_orders ${where}`).get(...args).n;
  const items = db.prepare(`SELECT * FROM acc_orders ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, size, (current - 1) * size).map((r) => orderView(parse(r)));
  return { items, total, page: current, pageSize: size };
}
