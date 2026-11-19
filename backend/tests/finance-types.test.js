// "הוספת סוג הוצאה חדש": a type added in the finance form is saved for next time; types already used
// in entries are listed too. Data is fictional.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { isolate } from './helpers.js';

const cleanup = isolate();
const router = (await import('../routes/finance.js')).default;

const app = express();
app.use(express.json());
app.use('/api/finance', router);
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}/api/finance`;
after(async () => { await new Promise((r) => server.close(r)); await cleanup(); });

const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
const types = (kind) => fetch(`${base}/types?kind=${kind}`).then((r) => r.json());

test('a new expense type is saved once, trimmed, and listed with types already used', async () => {
  assert.deepEqual(await types('expense'), []);
  await post('/transactions', { kind: 'expense', date: '2026-11-01', category: 'דלק', amount_agorot: 15000 });

  const r = await post('/types', { kind: 'expense', name: '  ביטוח   עסק ' });
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'ביטוח עסק');
  assert.deepEqual(r.body.types, ['ביטוח עסק', 'דלק']);

  await post('/types', { kind: 'expense', name: 'ביטוח עסק' }); // again: no duplicate
  assert.deepEqual(await types('expense'), ['ביטוח עסק', 'דלק']);
  assert.deepEqual(await types('income'), [], 'expense types stay out of income');
});

test('invalid names and kinds are rejected in Hebrew', async () => {
  assert.equal((await post('/types', { kind: 'expense', name: '   ' })).body.error, 'יש להקליד שם');
  assert.equal((await post('/types', { kind: 'expense', name: 'א'.repeat(61) })).status, 400);
  assert.equal((await post('/types', { kind: 'other', name: 'x' })).status, 400);
  assert.equal((await fetch(`${base}/types?kind=other`)).status, 400);
});
