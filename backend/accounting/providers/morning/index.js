// The Morning (Green Invoice) provider.
import { MorningClient, ENVIRONMENTS } from './client.js';
import {
  toCanonicalCustomer, toCanonicalDocument, toMorningClientRequest, toMorningReceiptRequest, toCatalogItem,
} from './mapper.js';
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
    issuesReceipts: true,
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

  /**
   * One page of documents, sorted by document date so the order stays stable between pages.
   * The search already includes item rows and payments, so no per-document request is needed.
   */
  async listDocuments(conn, { page = 1, pageSize = 100 } = {}, deps) {
    const r = await clientFor(conn, deps).request('POST', '/documents/search', { page, pageSize, sort: 'documentDate' });
    const items = (r?.items ?? []).map(toCanonicalDocument);
    const pages = Number(r?.pages) || (items.length < pageSize ? page : page + 1);
    return { items, page, pageSize, total: Number(r?.total ?? items.length), pages };
  },

  /** One document (includes linked documents), or null when Morning does not have it. */
  async getDocument(conn, externalId, deps) {
    try {
      return toCanonicalDocument(await clientFor(conn, deps).request('GET', `/documents/${encodeURIComponent(externalId)}`));
    } catch (err) {
      if (err.code === 'not_found') return null;
      throw err;
    }
  },

  // ---- Orders: creating clients and receipts (writes to Morning) ----

  /** The product catalog (Morning "items"), all pages. */
  async listItems(conn, deps) {
    const client = clientFor(conn, deps);
    const items = [];
    for (let page = 1; page <= 20; page++) {
      const r = await client.request('POST', '/items/search', { page, pageSize: 100 });
      items.push(...(r?.items ?? []).map(toCatalogItem));
      if (!r?.pages || page >= r.pages) break;
    }
    return items;
  },

  /** Creates a client card. Never retried after a network or server failure (err.uncertain). */
  async createCustomer(conn, customer, deps) {
    return toCanonicalCustomer(await clientFor(conn, deps).request('POST', '/clients', toMorningClientRequest(customer), { creates: true }));
  },

  /** The receipt as a PDF (base64) without creating anything. */
  async previewReceipt(conn, order, deps) {
    const r = await clientFor(conn, deps).request('POST', '/documents/preview', toMorningReceiptRequest(order));
    return { pdfBase64: r?.file ?? '' };
  },

  /** Issues the receipt. Never retried after a network or server failure (err.uncertain). */
  async createReceipt(conn, order, deps) {
    const r = await clientFor(conn, deps).request('POST', '/documents', toMorningReceiptRequest(order), { creates: true });
    return { externalId: String(r?.id ?? ''), number: String(r?.number ?? ''), pdfUrl: r?.url?.he ?? r?.url?.origin ?? '' };
  },

  /** Receipts of a client on a date, to check whether an uncertain issue went through. */
  async findReceipts(conn, { clientId, date }, deps) {
    const r = await clientFor(conn, deps).request('POST', '/documents/search', { page: 1, pageSize: 50, type: [400], clientId, fromDate: date, toDate: date });
    return (r?.items ?? []).map(toCanonicalDocument);
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
