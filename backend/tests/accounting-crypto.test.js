import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { isolate } from './helpers.js';

after(isolate());
const { encrypt, decrypt, mask } = await import('../accounting/crypto.js');

test('encrypts and decrypts any JSON value', () => {
  const value = { clientId: 'abc', clientSecret: 'סוד-1234', n: 5 };
  const enc = encrypt(value);
  assert.ok(enc.startsWith('v1.'));
  assert.ok(!enc.includes('abc') && !enc.includes('1234'), 'no plain text in the stored value');
  assert.deepEqual(decrypt(enc), value);
  assert.notEqual(encrypt(value), enc, 'a fresh IV every time');
});

test('a changed value is rejected', () => {
  const parts = encrypt({ a: 1 }).split('.');
  const data = Buffer.from(parts[3], 'base64');
  data[0] ^= 1;
  parts[3] = data.toString('base64');
  assert.throws(() => decrypt(parts.join('.')));
  assert.throws(() => decrypt('v0.x.y.z'), /format/);
});

test('mask shows only the edges', () => {
  assert.equal(mask('a1b2c3d4-e5f6-4a7b'), 'a1b2…4a7b');
  assert.equal(mask('short'), '•••••');
  assert.equal(mask(''), '');
});
