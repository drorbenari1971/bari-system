// The Morning (Green Invoice) provider.
import { MorningClient, ENVIRONMENTS } from './client.js';
import { toCanonicalCustomer } from './mapper.js';
import * as webhooks from './webhooks.js';

/** @param {import('../base.js').Connection} conn @param {object} [deps] */
export const clientFor = (conn, deps) => new MorningClient({
  environment: conn.environment,
  clientId: conn.credentials.clientId,
  clientSecret: conn.credentials.clientSecret,
}, deps);

/** @type {import('../base.js').AccountingProvider} */
const morning = {
  id: 'morning',
  label: 'Morning (חשבונית ירוקה)',
  environments: Object.fromEntries(Object.entries(ENVIRONMENTS).map(([k, v]) => [k, { label: v.label }])),
  credentialFields: [
    { key: 'clientId', label: 'Client ID', secret: false, placeholder: 'a1b2c3d4-e5f6-…' },
    { key: 'clientSecret', label: 'Client Secret', secret: true },
  ],
  // From the official spec: webhooks exist only for creation events; documents have no
  // "last updated" field or filter.
  capabilities: {
    webhooks: true,
    lineItems: true,
    pdfLinks: true,
    updatedSinceFilter: false,
    documentUpdateEvents: false,
  },

  webhooks,

  /** Gets a token, then reads one document page to prove data access. */
  async testConnection(conn, deps) {
    const client = clientFor(conn, deps);
    await client.token({ force: true });
    const page = await client.request('POST', '/documents/search', { page: 1, pageSize: 1 });
    return { ok: true, details: `החיבור תקין. בחשבון ${Number(page?.total ?? 0).toLocaleString('he-IL')} מסמכים.` };
  },

  /** One page of clients. Morning cannot filter or sort by update date, so a sync reads all pages. */
  async listCustomers(conn, { page = 1, pageSize = 100 } = {}, deps) {
    const r = await clientFor(conn, deps).request('POST', '/clients/search', { page, pageSize });
    const items = (r?.items ?? []).map(toCanonicalCustomer);
    const pages = Number(r?.pages) || (items.length < pageSize ? page : page + 1);
    return { items, page, pageSize, total: Number(r?.total ?? items.length), pages };
  },

  /** One client, or null when Morning no longer has it. */
  async getCustomer(conn, externalId, deps) {
    try {
      return toCanonicalCustomer(await clientFor(conn, deps).request('GET', `/clients/${encodeURIComponent(externalId)}`));
    } catch (err) {
      if (err.code === 'not_found') return null;
      throw err;
    }
  },
};

export default morning;
