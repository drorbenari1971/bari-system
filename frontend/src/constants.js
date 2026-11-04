export const PRODUCTS = [
  { id: 'bone_broth', label: 'ציר עצמות', color: '#b5835a' },
  { id: 'chicken_broth', label: 'ציר עוף', color: '#d9a441' },
  { id: 'ghee', label: 'גהי', color: '#e3c26b' },
  { id: 'tallow', label: 'טאלו', color: '#8a9a7b' },
];
export const productLabel = (id) => PRODUCTS.find((p) => p.id === id)?.label ?? id;

export const TONES = [
  { id: 'educational', label: 'חינוכי', hint: 'ערך, ידע וטיפים' },
  { id: 'sales', label: 'מכירתי', hint: 'יתרון ברור והנעה לפעולה' },
  { id: 'storytelling', label: 'סיפורי', hint: 'רגש, מסורת ורגע מהחיים' },
];
export const toneLabel = (id) => TONES.find((t) => t.id === id)?.label ?? id;

export const STATUS = {
  draft: { label: 'טיוטה', cls: 'bg-charcoal-100 text-charcoal-700' },
  scheduled: { label: 'מתוזמן', cls: 'bg-amber-100 text-amber-800' },
  publishing: { label: 'בפרסום…', cls: 'bg-sky-100 text-sky-800' },
  published: { label: 'פורסם', cls: 'bg-sage-100 text-sage-800' },
  failed: { label: 'נכשל', cls: 'bg-red-100 text-red-700' },
};

export const PLATFORMS = [
  { id: 'facebook', label: 'פייסבוק' },
  { id: 'instagram', label: 'אינסטגרם' },
];

export const fmtNum = (n) => new Intl.NumberFormat('he-IL').format(n ?? 0);
export const fmtDateTime = (iso) =>
  iso ? new Date(iso).toLocaleString('he-IL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('he-IL', { day: 'numeric', month: 'short' }) : '');

export function timeAgo(iso) {
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'עכשיו';
  const m = Math.round(s / 60);
  if (m < 60) return `לפני ${m} דק׳`;
  const h = Math.round(m / 60);
  if (h < 24) return `לפני ${h} שע׳`;
  return `לפני ${Math.round(h / 24)} ימים`;
}

// 'YYYY-MM-DDTHH:mm' in local time, for <input type="datetime-local">
export function toLocalInput(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
