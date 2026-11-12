// Airtable REST API: reads the Instagram leads base (filled by Apify) and writes back the outreach status.
// Fields are addressed by ID, so renaming a column in Airtable does not break the sync.
import { env } from '../config.js';

export const airtableConfigured = () =>
  !!(env('AIRTABLE_TOKEN') && env('AIRTABLE_BASE_ID') && env('AIRTABLE_ACCOUNTS_TABLE') && env('AIRTABLE_POSTS_TABLE'));

export const ACCOUNT_FIELDS = {
  handle: 'fldE6mbL9vIMAXoW9',
  displayName: 'fldr0NAoz2h5mLB9E',
  actorType: 'fldaHszm3V1nf50I2',
  profileUrl: 'fldQ0yDIonmuZqBP1',
  notes: 'fldi0lRBNWng4fLcH',
  postCount: 'fld1SyVSVgcQu3Ebj',
  totalLikes: 'fldwqhYVzUT9v2TfM',
  avgEngagement: 'fld08Rkoy3QOMpKVV',
  potential: 'fldyCevTehodMngU3',
  priority: 'fld6H9WxeBLXVlbE4',
  approach: 'fldVFTh50QffCBMan',
  status: 'fldXnlt8Gthis5B7L',
  platforms: 'fldgKrU0zrsN0jjZR',
  facebookUrl: 'fldDybIH51NL5j0Rp',
  phone: 'fldExb56Asw5AReW3',
  email: 'fldeQ3MyBRL0bML1r',
};

export const POST_FIELDS = {
  summary: 'fld6fCzd3vAK8WZ7v',
  account: 'fld2na2scM01j0Bwq',
  hashtag: 'fldXw1RnXzQ8SVexN',
  contentType: 'fldfqz9a0pPr1JWhb',
  likes: 'fldmOBKX9V99N7YW9',
  comments: 'fldPcnD7jjwJlCRAG',
  date: 'fld74fProeyn0DUc1',
  format: 'fldePh6imSLmjrejp',
  url: 'fldNwaetu1SmPg8lD',
  engagement: 'fldEgOjtdE7FbRFKO',
  platform: 'fldyc2Vv1lQWFZ31S',
};

// The choices of the "סטטוס פנייה" single select in Airtable, in order.
export const STATUS_CHOICES = ['לא נוצר קשר', 'נשלחה הודעה', 'בשיחה', 'סגור – עסקה', 'לא מעוניין'];

const tableUrl = (table) => `https://api.airtable.com/v0/${env('AIRTABLE_BASE_ID')}/${table}`;

async function request(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${env('AIRTABLE_TOKEN')}`, 'Content-Type': 'application/json', ...init.headers },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = json.error?.message ?? json.error?.type ?? json.error ?? res.status;
    throw new Error(res.status === 401 || res.status === 403
      ? `Airtable דחה את המפתח (${res.status}). בדקו שהמפתח תקף ושיש לו גישה לבסיס הזה.`
      : `שגיאת Airtable: ${message}`);
  }
  return json;
}

// All records of a table, following Airtable's 100-record pages.
export async function listAll(table) {
  const records = [];
  let offset;
  do {
    const url = new URL(tableUrl(table));
    url.searchParams.set('returnFieldsByFieldId', 'true');
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);
    const page = await request(url);
    records.push(...(page.records ?? []));
    offset = page.offset;
  } while (offset);
  return records;
}

export async function updateStatus(recordId, status) {
  await updateAccountFields(recordId, { [ACCOUNT_FIELDS.status]: status });
}

// fields: { fieldId: value }; null clears the cell.
export async function updateAccountFields(recordId, fields) {
  await request(`${tableUrl(env('AIRTABLE_ACCOUNTS_TABLE'))}/${recordId}`, {
    method: 'PATCH',
    body: JSON.stringify({ fields }),
  });
}

// Creates records 10 at a time (Airtable's limit) and returns their IDs in order.
// typecast lets a new search word appear as a new choice in the "האשטג" field.
export async function createRecords(table, fieldsList) {
  const ids = [];
  for (let i = 0; i < fieldsList.length; i += 10) {
    const r = await request(tableUrl(table), {
      method: 'POST',
      body: JSON.stringify({ records: fieldsList.slice(i, i + 10).map((fields) => ({ fields })), typecast: true }),
    });
    ids.push(...r.records.map((x) => x.id));
  }
  return ids;
}

// Cell values: selects arrive as a name (or {name}), links as IDs (or {id}).
export const text = (v) => (v == null ? '' : typeof v === 'object' ? String(v.name ?? '') : String(v));
export const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
// Multiple selects arrive as a list of names (or {name}); stored as "אינסטגרם,פייסבוק".
export const names = (v) => (Array.isArray(v) ? v.map(text).filter(Boolean).join(',') : text(v));
export const linkIds =(v) => (Array.isArray(v) ? v.map((x) => (typeof x === 'object' ? x.id : x)).filter(Boolean) : []);
