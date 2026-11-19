import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { isolate } from './helpers.js';

after(isolate());
const { db } = await import('../db.js');
const audit = await import('../accounting/audit.js');

test('diff lists changed fields, including nested ones; arrays compare whole', () => {
  const before = { status: 'open', totals: { gross: 100, vat: 17 }, lines: [1, 2], gone: 'x' };
  const after = { status: 'closed', totals: { gross: 100, vat: 18 }, lines: [1, 2], added: true };
  assert.deepEqual(audit.diff(before, after), [
    { field: 'added', from: null, to: true },
    { field: 'gone', from: 'x', to: null },
    { field: 'status', from: 'open', to: 'closed' },
    { field: 'totals.vat', from: 17, to: 18 },
  ]);
  assert.deepEqual(audit.diff({ a: [1] }, { a: [1, 2] }), [{ field: 'a', from: [1], to: [1, 2] }]);
});

test('record stores before, after and changes, and joins the caller transaction', () => {
  db.exec('BEGIN');
  audit.record({ action: 'document.updated', source: 'webhook', entityType: 'document', entityId: 5, externalId: 'ext-5', jobId: 9, before: { s: 1 }, after: { s: 2 } });
  db.exec('ROLLBACK');
  assert.equal(audit.list({ entityId: 5 }).total, 0, 'rolled back with the caller');

  const id = audit.record({ action: 'document.updated', source: 'webhook', entityType: 'document', entityId: 5, externalId: 'ext-5', jobId: 9, before: { s: 1 }, after: { s: 2 } });
  const [row] = audit.list({ entityType: 'document', entityId: 5 }).items;
  assert.equal(row.id, id);
  assert.equal(row.external_id, 'ext-5');
  assert.equal(row.job_id, 9);
  assert.deepEqual(row.before, { s: 1 });
  assert.deepEqual(row.after, { s: 2 });
  assert.deepEqual(row.changes, [{ field: 's', from: 1, to: 2 }]);
  assert.throws(() => audit.record({ action: 'x', source: 'cron', entityType: 'x', entityId: 1 }), /Unknown audit source/);
});

test('list filters by action and source, newest first, with paging', () => {
  for (let i = 0; i < 6; i++) {
    audit.record({ action: i % 2 ? 'customer.updated' : 'customer.created', source: i < 3 ? 'polling' : 'manual', entityType: 'customer', entityId: 100 + i });
  }
  const created = audit.list({ action: 'customer.created' });
  assert.equal(created.total, 3);
  assert.deepEqual(created.items.map((a) => a.entity_id), ['104', '102', '100']);
  assert.equal(audit.list({ source: 'manual', entityType: 'customer' }).total, 3);
  const page = audit.list({ entityType: 'customer', page: 2, pageSize: 4 });
  assert.equal(page.items.length, 2);
  assert.equal(page.pageSize, 4);
});
