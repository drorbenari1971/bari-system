// Income for "כספים ותזרים", read directly from the documents synced from the accounting provider
// (Morning). Nothing is copied into the finance table: the provider stays the only source, so a
// receipt is never counted twice and a cancelled one disappears on the next sync.
//
// Counted like the customers screen and the business dashboard: receipts and tax invoice/receipts
// that were not cancelled add income; a credit note reduces it. Invoices are not income yet.
import './schema.js'; // tables must exist before statements are prepared
import { db } from '../db.js';
import { PURCHASE_KINDS } from './customersQuery.js';
import { PRODUCT_RULES, productsOf } from './bi.js';

const KINDS = [...PURCHASE_KINDS, 'credit_note'];
const KIND_LABEL = { receipt: 'קבלה', invoice_receipt: 'חשבונית מס/קבלה', credit_note: 'חשבונית זיכוי' };
const OTHER_LABEL = { unspecified: 'קבלות Morning (לא מפורט)', none: 'קבלות Morning (ללא תיאור)' };
const LABEL_BY_ID = Object.fromEntries(PRODUCT_RULES.map((p) => [p.id, p.label]));

/** "ציר", "ציר + גהי" or a Morning bucket, from the item rows or, without them, the description. */
function categoryOf(kind, text) {
  if (kind === 'credit_note') return KIND_LABEL.credit_note;
  return productsOf(text).map((id) => LABEL_BY_ID[id] ?? OTHER_LABEL[id]).join(' + ');
}

/**
 * Income rows in the finance screen's shape, newest first.
 * @param {{ from?: string|null, to?: string|null }} range  'YYYY-MM-DD', inclusive
 */
export function providerIncome({ from = null, to = null } = {}) {
  const args = [...KINDS];
  let where = `kind IN (${KINDS.map(() => '?').join(', ')}) AND status NOT IN ('cancelled', 'cancelling')`;
  if (from) { where += ' AND doc_date >= ?'; args.push(from); }
  if (to) { where += ' AND doc_date <= ?'; args.push(to); }
  const docs = db.prepare(`
    SELECT d.id, d.kind, d.number, d.doc_date, d.gross, d.description, d.customer_name, d.pdf_url,
      (SELECT group_concat(description, ' ') FROM acc_document_lines l WHERE l.document_id = d.id) AS lines
    FROM acc_documents d WHERE ${where} ORDER BY d.doc_date DESC, d.id DESC
  `).all(...args);
  return docs.filter((d) => d.gross !== 0).map((d) => ({
    id: `morning-${d.id}`,
    source: 'morning',
    kind: 'income',
    date: d.doc_date,
    category: categoryOf(d.kind, d.lines || d.description),
    subcategory: [`${KIND_LABEL[d.kind]} ${d.number}`, d.customer_name].filter(Boolean).join(' · '),
    amount_agorot: d.kind === 'credit_note' ? -Math.abs(d.gross) : d.gross, // a credit note may be stored negative
    is_demo: false,
    pdf_url: d.pdf_url || null,
  }));
}
