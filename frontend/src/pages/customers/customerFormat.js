// Labels and formatting shared by the customers list and the customer card.
export { fmtMoney } from '../../financeSummary.js';

export const SEGMENTS = [
  { id: 'all', label: 'הכול' },
  { id: 'buyers', label: 'קנו' },
  { id: 'returning', label: 'חוזרים' },
  { id: 'one_time', label: 'קנו פעם אחת' },
  { id: 'no_purchases', label: 'בלי רכישות' },
];

export const SORTS = [
  { id: 'last_purchase', label: 'רכישה אחרונה' },
  { id: 'total', label: 'סכום כולל' },
  { id: 'purchases', label: 'מספר רכישות' },
  { id: 'first_purchase', label: 'רכישה ראשונה' },
  { id: 'name', label: 'שם' },
];

export const IDENTIFIED = {
  card: { label: 'כרטיס Morning', cls: 'bg-sage-50 text-sage-700', hint: 'הלקוח קיים ככרטיס לקוח ב-Morning' },
  email: { label: 'לפי מייל', cls: 'bg-sky-50 text-sky-700', hint: 'קבלות זוהו כשל אותו לקוח לפי מייל זהה' },
  name: { label: 'לפי שם', cls: 'bg-amber-50 text-amber-700', hint: 'לפחות קבלה אחת שויכה ללקוח רק לפי שם זהה' },
  document: { label: 'מקבלה', cls: 'bg-charcoal-50 text-charcoal-600', hint: 'הלקוח נוצר מתוך קבלה, בלי כרטיס לקוח ב-Morning' },
};

export const MATCH = { external_id: 'כרטיס לקוח', phone: 'טלפון', email: 'מייל', name: 'שם', new: 'לקוח חדש', none: '—' };

export const KINDS = {
  receipt: 'קבלה', invoice_receipt: 'חשבונית מס/קבלה', invoice: 'חשבונית מס', credit_note: 'חשבונית זיכוי', quote: 'הצעת מחיר', other: 'מסמך',
};

export const DOC_STATUS = { open: 'פתוח', closed: 'סגור', cancelling: 'מבטל', cancelled: 'בוטל' };

const METHODS = {
  app: 'אפליקציה', bank_transfer: 'העברה בנקאית', cash: 'מזומן', card: 'כרטיס אשראי', cheque: "צ'ק", paypal: 'PayPal', withholding: 'ניכוי במקור', other: 'אחר',
};
export const methodLabel = (method, app) => app || METHODS[method] || '';

/** 2026-11-16 -> 16.11.2026 */
export const fmtDay = (d) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString('he-IL') : '—');

export const ACTIONS = {
  'customer.created': 'לקוח נוצר',
  'customer.updated': 'פרטים עודכנו',
  'customer.deactivated': 'סומן כלא פעיל',
  'customer.reactivated': 'חזר להיות פעיל',
  'customer.identity_linked': 'זוהה כלקוח קיים',
  'customer.removed_in_source': 'הוסר ב-Morning',
  'customer.restored_in_source': 'חזר ב-Morning',
};
export const SOURCES = { manual: 'ידני', polling: 'סנכרון תקופתי', system: 'מערכת', webhook: 'Webhook', replay: 'הרצה חוזרת' };
