// Provider-neutral helpers shared by every provider and the store.
import crypto from 'node:crypto';

/** Shekels (number) to agorot (integer). */
export const toAgorot = (n) => Math.round((Number(n) || 0) * 100);

/** Unix seconds to ISO, or null. */
export const fromUnix = (s) => (Number(s) > 0 ? new Date(Number(s) * 1000).toISOString() : null);

/**
 * Israeli phone number in one comparable form: digits only, +972 / 972 becomes 0.
 * Returns '' when what is left is too short to be a phone number.
 */
export function normalizePhone(value) {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.startsWith('972')) digits = `0${digits.slice(3)}`;
  // Leading 0 dropped (e.g. stored as a number): a 9-digit mobile starting with 5, or an 8-digit landline.
  else if ((digits.length === 9 && digits.startsWith('5')) || (digits.length === 8 && /^[234789]/.test(digits))) digits = `0${digits}`;
  return digits.startsWith('0') && digits.length >= 9 && digits.length <= 10 ? digits : '';
}

/** Stable hash of a JSON value (key order does not matter). */
export function contentHash(value) {
  const stable = (v) => (Array.isArray(v) ? v.map(stable)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v);
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

/**
 * @typedef {Object} CanonicalCustomer
 * @property {string} externalId
 * @property {string} name
 * @property {string} phone
 * @property {string} mobile
 * @property {string[]} emails
 * @property {string} taxId
 * @property {string} address
 * @property {string} city
 * @property {string} zip
 * @property {string} country
 * @property {string} contactPerson
 * @property {string} department
 * @property {boolean} active
 * @property {string[]} labels
 * @property {string} remarks
 * @property {number} incomeAgorot    computed by the provider from documents
 * @property {number} paymentAgorot   computed by the provider from documents
 * @property {number} balanceAgorot   computed by the provider from documents
 * @property {string|null} createdAt  ISO
 * @property {string|null} updatedAt  ISO
 * @property {object} raw             the provider's record, without bank details
 */

/**
 * @typedef {Object} CanonicalDocument
 * @property {string} externalId
 * @property {'invoice'|'invoice_receipt'|'receipt'|'credit_note'|'quote'|'other'} kind
 * @property {number} typeCode          the provider's own type code
 * @property {'open'|'closed'|'cancelling'|'cancelled'} status
 * @property {string} number
 * @property {string} date              YYYY-MM-DD
 * @property {string|null} createdAt    ISO
 * @property {string} currency
 * @property {{ gross: number, vat: number, net: number }} totals  agorot, local currency
 * @property {string} description
 * @property {{ externalId: string|null, name: string, phone: string, email: string }} customer
 * @property {{ sku: string, externalItemId: string, description: string, quantity: number, unitPrice: number, total: number }[]} lines
 * @property {{ method: string, label: string, app: string, amount: number }[]} payments
 * @property {string} pdfUrl
 * @property {string[]} linkedExternalIds
 * @property {object} raw               without payment descriptions that could hold bank details
 */

/** Names compared as written, ignoring case and extra spaces. */
export const normalizeName = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** Emails compared case-insensitively. */
export const normalizeEmail = (value) => {
  const v = String(value ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : '';
};

/** A stable key for product analysis: catalog number, item id, or the cleaned description. */
export const productKey = (line) => (line.sku ? `sku:${line.sku}` : line.externalItemId ? `item:${line.externalItemId}` : `text:${normalizeName(line.description)}`);
