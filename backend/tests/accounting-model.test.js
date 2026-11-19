import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, contentHash, toAgorot, fromUnix } from '../accounting/model.js';
import { toCanonicalCustomer } from '../accounting/providers/morning/mapper.js';

test('phone numbers are normalized to one Israeli form', () => {
  for (const [input, expected] of [
    ['050-123-4567', '0501234567'],
    ['+972 50 123 4567', '0501234567'],
    ['972501234567', '0501234567'],
    ['501234567', '0501234567'],   // leading 0 lost
    ['03-1234567', '031234567'],
    ['31234567', '031234567'],
    ['1-800-123', ''],
    ['', ''],
    [null, ''],
  ]) assert.equal(normalizePhone(input), expected, String(input));
});

test('hash ignores key order; money and dates convert', () => {
  assert.equal(contentHash({ a: 1, b: { c: [1, 2] } }), contentHash({ b: { c: [1, 2] }, a: 1 }));
  assert.notEqual(contentHash({ a: 1 }), contentHash({ a: 2 }));
  assert.equal(toAgorot(19.99), 1999);
  assert.equal(toAgorot('0.29'), 29);
  assert.equal(toAgorot(undefined), 0);
  assert.equal(fromUnix(0), null);
  assert.equal(fromUnix(1_700_000_000), '2023-11-14T22:13:20.000Z');
});

test('a Morning client maps to the canonical customer without bank details', () => {
  const c = toCanonicalCustomer({
    id: 'x1', name: ' דנה ', phone: '050-1234567', emails: ['a@example.com', ''], active: false, labels: ['l1'],
    incomeAmount: 10.5, paymentAmount: 0, balanceAmount: -10.5, creationDate: 1_700_000_000, lastUpdateDate: 1_700_000_100,
    bankName: 'בנק', bankBranch: '1', bankAccount: '2', nameAliases: ['דנה כ'],
  });
  assert.equal(c.name, 'דנה');
  assert.deepEqual(c.emails, ['a@example.com']);
  assert.equal(c.active, false);
  assert.equal(c.mobile, '');
  assert.equal(c.incomeAgorot, 1050);
  assert.equal(c.balanceAgorot, -1050);
  assert.equal(c.updatedAt, '2023-11-14T22:15:00.000Z');
  assert.ok(!('bankAccount' in c.raw) && !('bankName' in c.raw) && !('bankBranch' in c.raw));
  assert.deepEqual(c.raw.nameAliases, ['דנה כ'], 'other fields stay in raw');
  assert.equal(toCanonicalCustomer({ id: 'y' }).active, true, 'active unless Morning says otherwise');
});
