// The contract every accounting provider implements (docs/customers-module-design.md, section 5).
// The rest of the module talks only to this contract, never to a provider's API directly.

/**
 * @typedef {Object} ProviderEnvironment
 * @property {string} label            shown in the settings screen
 *
 * @typedef {Object} CredentialField
 * @property {string} key              key inside the credentials object
 * @property {string} label
 * @property {boolean} secret          never sent back to the screen
 * @property {string} [placeholder]
 *
 * @typedef {Object} ProviderCapabilities
 * @property {boolean} webhooks              provider can push events
 * @property {boolean} lineItems             documents include item rows
 * @property {boolean} pdfLinks              documents include a PDF link
 * @property {boolean} updatedSinceFilter    documents can be searched by "updated since"
 * @property {boolean} documentUpdateEvents  provider sends an event when a document changes
 *
 * @typedef {Object} Connection            a row of acc_connections, with decrypted credentials
 * @property {number} id
 * @property {string} environment
 * @property {Record<string, string>} credentials
 *
 * @typedef {Object} AccountingProvider
 * @property {string} id
 * @property {string} label
 * @property {Record<string, ProviderEnvironment>} environments
 * @property {CredentialField[]} credentialFields
 * @property {ProviderCapabilities} capabilities
 * @property {(conn: Connection) => Promise<{ ok: true, details: string }>} testConnection
 *   Throws AccountingError when the connection does not work.
 * @property {(conn: Connection, opts: { page: number, pageSize: number }) =>
 *   Promise<{ items: import('../model.js').CanonicalCustomer[], page: number, pageSize: number, total: number, pages: number }>} listCustomers
 *   One page of customers, in the provider's own order.
 * @property {(conn: Connection, externalId: string) => Promise<import('../model.js').CanonicalCustomer|null>} getCustomer
 *   null when the provider no longer has the customer.
 * @property {(conn: Connection, opts: { page: number, pageSize: number }) =>
 *   Promise<{ items: import('../model.js').CanonicalDocument[], page: number, pageSize: number, total: number, pages: number }>} listDocuments
 *   One page of documents, in a stable order.
 * @property {(conn: Connection, externalId: string) => Promise<import('../model.js').CanonicalDocument|null>} getDocument
 * @property {object} [webhooks]  required when capabilities.webhooks is true:
 *   { SECRET_LENGTH, KEPT_HEADERS, supportedTopics(), verifySignature(secret, rawBody, signature),
 *     describeDelivery(headers), readDelivery(topic, rawBody) } (see providers/morning/webhooks.js)
 */

const REQUIRED_FUNCTIONS = ['testConnection', 'listCustomers', 'getCustomer', 'listDocuments', 'getDocument'];
const WEBHOOK_FUNCTIONS = ['supportedTopics', 'verifySignature', 'describeDelivery', 'readDelivery'];
const CAPABILITY_KEYS = ['webhooks', 'lineItems', 'pdfLinks', 'updatedSinceFilter', 'documentUpdateEvents'];

/** Fails fast at startup if a provider does not implement the contract. */
export function assertProvider(p) {
  const problems = [];
  if (!p?.id || !p.label) problems.push('id/label');
  if (!p?.environments || !Object.keys(p.environments).length) problems.push('environments');
  if (!Array.isArray(p?.credentialFields) || !p.credentialFields.length) problems.push('credentialFields');
  for (const key of CAPABILITY_KEYS) if (typeof p?.capabilities?.[key] !== 'boolean') problems.push(`capabilities.${key}`);
  for (const fn of REQUIRED_FUNCTIONS) if (typeof p?.[fn] !== 'function') problems.push(fn);
  if (p?.capabilities?.webhooks) {
    for (const fn of WEBHOOK_FUNCTIONS) if (typeof p.webhooks?.[fn] !== 'function') problems.push(`webhooks.${fn}`);
  }
  if (problems.length) throw new Error(`Accounting provider "${p?.id ?? '?'}" is missing: ${problems.join(', ')}`);
  return p;
}

/** What the settings screen may know about a provider (no functions). */
export const describeProvider = (p) => ({
  id: p.id,
  label: p.label,
  environments: p.environments,
  credentialFields: p.credentialFields,
  capabilities: p.capabilities,
});
