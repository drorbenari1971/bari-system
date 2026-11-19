// Morning records -> the canonical model (backend/accounting/model.js).
import { toAgorot, fromUnix } from '../../model.js';

// Never stored, not even in raw: not needed by the module, and sensitive.
const DROPPED_CLIENT_FIELDS = ['bankName', 'bankBranch', 'bankAccount'];

const text = (v) => (v === undefined || v === null ? '' : String(v).trim());

/** @returns {import('../../model.js').CanonicalCustomer} */
export function toCanonicalCustomer(client) {
  const raw = { ...client };
  for (const f of DROPPED_CLIENT_FIELDS) delete raw[f];
  return {
    externalId: text(client.id),
    name: text(client.name),
    phone: text(client.phone),
    mobile: text(client.mobile),
    emails: (Array.isArray(client.emails) ? client.emails : []).map(text).filter(Boolean),
    taxId: text(client.taxId),
    address: text(client.address),
    city: text(client.city),
    zip: text(client.zip),
    country: text(client.country),
    contactPerson: text(client.contactPerson),
    department: text(client.department),
    active: client.active !== false,
    labels: Array.isArray(client.labels) ? client.labels.map(String) : [],
    remarks: text(client.remarks),
    incomeAgorot: toAgorot(client.incomeAmount),
    paymentAgorot: toAgorot(client.paymentAmount),
    balanceAgorot: toAgorot(client.balanceAmount),
    createdAt: fromUnix(client.creationDate),
    updatedAt: fromUnix(client.lastUpdateDate),
    raw,
  };
}

// Morning document type and status codes (official spec) -> canonical values.
const KIND_BY_TYPE = { 305: 'invoice', 320: 'invoice_receipt', 400: 'receipt', 330: 'credit_note', 10: 'quote' };
const STATUS_BY_CODE = { 0: 'open', 1: 'closed', 2: 'closed', 3: 'cancelling', 4: 'cancelled' };
// Payment group codes -> canonical methods.
const METHOD_BY_TYPE = { 0: 'withholding', 1: 'cash', 2: 'cheque', 3: 'card', 4: 'bank_transfer', 5: 'paypal', 10: 'app', 11: 'other' };
const APP_BY_CODE = { 1: 'Bit', 2: 'Pay', 3: 'PayBox', 5: 'Google Pay', 6: 'Apple Pay' };
// A payment's free-text description can hold bank account details (e.g. on a transfer), so it is
// kept only for payment apps, where it names the app ("bit", "PayBox").
const APP_TYPE = 10;
const KNOWN_APPS = { bit: 'Bit', paybox: 'PayBox', pay: 'Pay', 'google pay': 'Google Pay', 'apple pay': 'Apple Pay' };

function appName(p) {
  if (APP_BY_CODE[p.appType]) return APP_BY_CODE[p.appType];
  if (Number(p.type) !== APP_TYPE) return '';
  const d = text(p.description).toLowerCase();
  return KNOWN_APPS[d] ?? '';
}

/** The document as Morning sent it, minus payment descriptions that are not an app name. */
function sanitizedRaw(doc) {
  return {
    ...doc,
    payment: (doc.payment ?? []).map((p) => {
      const { description, ...rest } = p;
      return Number(p.type) === APP_TYPE ? { ...rest, description } : rest;
    }),
  };
}

/** @returns {import('../../model.js').CanonicalDocument} */
export function toCanonicalDocument(doc) {
  const gross = toAgorot(doc.amountLocal ?? doc.amount);
  const vat = toAgorot(doc.vatLocal ?? doc.vat);
  const client = doc.client ?? {};
  return {
    externalId: text(doc.id),
    kind: KIND_BY_TYPE[doc.type] ?? 'other',
    typeCode: Number(doc.type),
    status: STATUS_BY_CODE[doc.status] ?? 'open',
    number: text(doc.number),
    date: text(doc.documentDate).slice(0, 10),
    createdAt: fromUnix(doc.creationDate),
    currency: text(doc.currency) || 'ILS',
    totals: { gross, vat, net: gross - vat },
    description: text(doc.description),
    customer: {
      externalId: text(client.id) || null,
      name: text(client.name),
      phone: text(client.phone ?? client.mobile),
      email: (Array.isArray(client.emails) ? client.emails : []).map(text).find(Boolean) ?? '',
    },
    lines: (doc.income ?? []).map((r) => ({
      sku: text(r.catalogNum),
      externalItemId: text(r.itemId),
      description: text(r.description),
      quantity: Number(r.quantity) || 0,
      unitPrice: toAgorot(r.price),
      total: toAgorot(r.amountTotal ?? (Number(r.price) || 0) * (Number(r.quantity) || 0)),
    })),
    payments: (doc.payment ?? []).map((p) => ({
      method: METHOD_BY_TYPE[p.type] ?? 'other',
      label: text(p.name),
      app: appName(p),
      amount: toAgorot(p.price ?? p.amount),
    })),
    pdfUrl: text(doc.url?.he ?? doc.url?.origin),
    linkedExternalIds: (doc.linkedDocuments ?? []).map((l) => text(l.id)).filter(Boolean),
    raw: sanitizedRaw(doc),
  };
}

// ---- Orders (customer intake + receipt): canonical order -> Morning requests ----
const PAYMENT_TYPE_BY_METHOD = { cash: 1, cheque: 2, card: 3, bank_transfer: 4, paypal: 5, app: 10, other: 11 };
const APP_CODE = { Bit: 1, Pay: 2, PayBox: 3, 'Google Pay': 5, 'Apple Pay': 6 };
const shekels = (agorot) => Math.round(agorot) / 100;

/**
 * A new Morning client from the order form. Bank details are never sent. `send: false`: Morning
 * does not email this client automatically; each receipt decides on its own whether to email.
 */
export function toMorningClientRequest(c) {
  const body = { name: c.name, send: false, country: 'IL' };
  if (c.mobile) body.mobile = c.mobile;
  if (c.phone) body.phone = c.phone;
  if (c.email) body.emails = [c.email];
  for (const k of ['address', 'city', 'taxId', 'remarks']) if (c[k]) body[k] = c[k];
  return body;
}

/** The receipt (type 400) for an order. Prices in shekels; VAT follows the business type. */
export function toMorningReceiptRequest(order) {
  const p = order.payment;
  const payment = { date: p.date, type: PAYMENT_TYPE_BY_METHOD[p.method], price: shekels(p.amount), currency: 'ILS' };
  if (p.method === 'app' && APP_CODE[p.app]) payment.appType = APP_CODE[p.app];
  if (p.reference && (p.method === 'app' || p.method === 'other' || p.method === 'paypal')) payment.transactionId = p.reference;
  const client = { id: order.customer.externalId, name: order.customer.name };
  // The download link goes to these addresses; without them the receipt is not emailed.
  client.emails = order.receipt.sendEmail && order.customer.email ? [order.customer.email] : [];
  const body = {
    type: 400,
    lang: 'he',
    currency: 'ILS',
    vatType: 0,
    signed: true,
    date: order.receipt.date,
    client,
    income: order.lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      price: shekels(l.unitPrice),
      currency: 'ILS',
      vatType: 0,
      ...(l.itemId ? { itemId: l.itemId } : {}),
      ...(l.sku ? { catalogNum: l.sku } : {}),
    })),
    payment: [payment],
  };
  if (order.receipt.description) body.description = order.receipt.description;
  if (order.receipt.remarks) body.remarks = order.receipt.remarks;
  return body;
}

/** A catalog item: { id, name, price (agorot), currency }. */
export const toCatalogItem = (i) => ({ id: text(i.id), name: text(i.name), description: text(i.description), price: toAgorot(i.price), currency: text(i.currency) || 'ILS' });
