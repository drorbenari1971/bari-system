// Audit log: every change to module data, with the state before and after and a field-level diff.
// record() writes with the caller's statement, so it joins the caller's transaction.
import './schema.js'; // tables must exist before statements are prepared
import { db } from '../db.js';

export const SOURCES = ['webhook', 'polling', 'manual', 'replay', 'system'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Field-level differences between two JSON values: [{ field: 'a.b', from, to }]. Arrays compare as a whole. */
export function diff(before, after, prefix = '') {
  const changes = [];
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const key of [...keys].sort()) {
    const field = prefix ? `${prefix}.${key}` : key;
    const a = before?.[key];
    const b = after?.[key];
    if (isObject(a) && isObject(b)) changes.push(...diff(a, b, field));
    else if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ field, from: a ?? null, to: b ?? null });
  }
  return changes;
}

const insert = db.prepare(`
  INSERT INTO acc_audit_log (action, source, job_id, entity_type, entity_id, external_id, before, after, changes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

/**
 * @param {object} e
 * @param {string} e.action        e.g. 'document.updated', 'connection.created'
 * @param {string} e.source        one of SOURCES
 * @param {string} e.entityType    'document' | 'customer' | 'connection' | 'flag' | ...
 * @param {string|number} e.entityId
 * @param {string} [e.externalId]  the provider's ID
 * @param {number} [e.jobId]
 * @param {object|null} [e.before]
 * @param {object|null} [e.after]
 * @returns {number} the audit row id
 */
export function record({ action, source, entityType, entityId, externalId = null, jobId = null, before = null, after = null }) {
  if (!SOURCES.includes(source)) throw new Error(`Unknown audit source: ${source}`);
  const changes = diff(before ?? {}, after ?? {});
  const r = insert.run(action, source, jobId, entityType, String(entityId), externalId,
    before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, JSON.stringify(changes));
  return Number(r.lastInsertRowid);
}

const parse = (row) => ({
  ...row,
  before: row.before ? JSON.parse(row.before) : null,
  after: row.after ? JSON.parse(row.after) : null,
  changes: JSON.parse(row.changes),
});

/** Newest first, filtered and paged. */
export function list({ entityType, entityId, action, source, from, to, page = 1, pageSize = 50 } = {}) {
  const where = [];
  const args = [];
  const add = (sql, v) => { if (v !== undefined && v !== null && v !== '') { where.push(sql); args.push(v); } };
  add('entity_type = ?', entityType);
  add('entity_id = ?', entityId === undefined ? undefined : String(entityId));
  add('action = ?', action);
  add('source = ?', source);
  add('at >= ?', from);
  add('at <= ?', to);
  const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const size = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
  const current = Math.max(Number(page) || 1, 1);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM acc_audit_log ${sqlWhere}`).get(...args).n;
  const items = db.prepare(`SELECT * FROM acc_audit_log ${sqlWhere} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...args, size, (current - 1) * size).map(parse);
  return { items, total, page: current, pageSize: size };
}
