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
