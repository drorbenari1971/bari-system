import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { isolate, fakeFetch, noSleep } from './helpers.js';

after(isolate());
const { MorningClient, clearTokenCache } = await import('../accounting/providers/morning/client.js');
const morning = (await import('../accounting/providers/morning/index.js')).default;
const { AccountingError } = await import('../accounting/errors.js');

const creds = { environment: 'sandbox', clientId: 'id-1', clientSecret: 'secret-1' };
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;
const tokenOk = (n = 1) => ({ body: { accessToken: `tok${n}`, tokenType: 'Bearer', expiresAt: inAnHour() } });

beforeEach(() => clearTokenCache());

test('gets a token with client credentials from the right environment', async () => {
  const fetch = fakeFetch(() => tokenOk());
  const token = await new MorningClient(creds, { fetch, sleep: noSleep }).token();
  assert.equal(token, 'tok1');
  assert.equal(fetch.calls[0].url, 'https://api.sandbox.morning.dev/idp/v1/oauth/token');
  assert.deepEqual(fetch.calls[0].body, { grant_type: 'client_credentials', client_id: 'id-1', client_secret: 'secret-1' });

  const prod = fakeFetch(() => tokenOk());
  await new MorningClient({ ...creds, environment: 'production' }, { fetch: prod }).token();
  assert.equal(prod.calls[0].url, 'https://api.morning.co/idp/v1/oauth/token');
});

test('reuses the token until a minute before it expires', async () => {
  let n = 0;
  const fetch = fakeFetch(() => ({ body: { accessToken: `tok${++n}`, expiresAt: n === 1 ? Math.floor(Date.now() / 1000) + 30 : inAnHour() } }));
  const c = new MorningClient(creds, { fetch });
  assert.equal(await c.token(), 'tok1');
  assert.equal(await c.token(), 'tok2', 'expires within a minute: renewed');
  assert.equal(await c.token(), 'tok2', 'valid: reused');
  assert.equal(fetch.calls.length, 2);
});

test('maps documented token errors to clear Hebrew messages', async () => {
  for (const [error, status, re, code] of [
    ['invalid_client', 401, /שגויים/, 'auth_failed'],
    ['unauthorized_client', 400, /מינוי/, 'auth_error'],
    ['invalid_grant', 400, /פג תוקף/, 'auth_error'],
  ]) {
    clearTokenCache();
    const fetch = fakeFetch(() => ({ status, body: { error, error_description: 'x' } }));
    await assert.rejects(new MorningClient(creds, { fetch }).token(), (e) => e instanceof AccountingError && re.test(e.message) && e.code === code && !e.retryable);
  }
});

test('data requests send the bearer token to the API host', async () => {
  const fetch = fakeFetch((c) => (c.url.includes('oauth') ? tokenOk() : { body: { total: 3, items: [] } }));
  const r = await new MorningClient(creds, { fetch }).request('POST', '/documents/search', { page: 1 });
  assert.equal(r.total, 3);
  const data = fetch.calls[1];
  assert.equal(data.url, 'https://sandbox.d.greeninvoice.co.il/api/v1/documents/search');
  assert.equal(data.headers.Authorization, 'Bearer tok1');
  assert.deepEqual(data.body, { page: 1 });
});

test('a 401 on data renews the token once and repeats the request', async () => {
  let tokens = 0;
  let data = 0;
  const fetch = fakeFetch((c) => {
    if (c.url.includes('oauth')) return tokenOk(++tokens);
    return ++data === 1 ? { status: 401, body: { errorCode: 401 } } : { body: { ok: true } };
  });
  assert.deepEqual(await new MorningClient(creds, { fetch }).request('GET', '/documents/x'), { ok: true });
  assert.equal(tokens, 2);
  assert.equal(fetch.calls.at(-1).headers.Authorization, 'Bearer tok2');

  const always401 = fakeFetch((c) => (c.url.includes('oauth') ? tokenOk() : { status: 401, body: {} }));
  clearTokenCache();
  await assert.rejects(new MorningClient(creds, { fetch: always401 }).request('GET', '/x'), (e) => e.code === 'auth_failed');
});

test('rate limits and server errors are retried with growing waits, honouring Retry-After', async () => {
  const waits = [];
  let data = 0;
  const fetch = fakeFetch((c) => {
    if (c.url.includes('oauth')) return tokenOk();
    data++;
    if (data === 1) return { status: 429, body: {}, headers: { 'retry-after': '20' } };
    if (data === 2) return { status: 503, body: {} };
    return { body: { done: true } };
  });
  const r = await new MorningClient(creds, { fetch, sleep: async (ms) => waits.push(ms) }).request('GET', '/x');
  assert.deepEqual(r, { done: true });
  assert.deepEqual(waits, [20000, 3000]);
});

test('gives up after the retries with a retryable error, and a 4xx is not retried', async () => {
  const fetch = fakeFetch((c) => (c.url.includes('oauth') ? tokenOk() : { status: 429, body: {} }));
  await assert.rejects(new MorningClient(creds, { fetch, sleep: noSleep }).request('GET', '/x'), (e) => e.code === 'rate_limited' && e.retryable);
  assert.equal(fetch.calls.length, 1 + 4, 'token + 1 try + 3 retries');

  clearTokenCache();
  const bad = fakeFetch((c) => (c.url.includes('oauth') ? tokenOk() : { status: 400, body: { errorCode: 1100, errorMessage: 'שדה לא תקין' } }));
  await assert.rejects(new MorningClient(creds, { fetch: bad, sleep: noSleep }).request('POST', '/x', {}), (e) => !e.retryable && /1100: שדה לא תקין/.test(e.message));
  assert.equal(bad.calls.length, 2);
});

test('network failures are retried, then reported as retryable', async () => {
  let failures = 0;
  const fetch = fakeFetch((c) => {
    if (c.url.includes('oauth')) return tokenOk();
    if (++failures <= 2) throw new TypeError('fetch failed');
    return { body: { ok: 1 } };
  });
  assert.deepEqual(await new MorningClient(creds, { fetch, sleep: noSleep }).request('GET', '/x'), { ok: 1 });

  clearTokenCache();
  const down = fakeFetch(() => { throw new TypeError('fetch failed'); });
  await assert.rejects(new MorningClient(creds, { fetch: down, sleep: noSleep }).token(), (e) => e.code === 'network' && e.retryable);
});

test('rejects missing credentials or an unknown environment up front', () => {
  assert.throws(() => new MorningClient({ ...creds, clientSecret: '' }), /חסרים/);
  assert.throws(() => new MorningClient({ ...creds, environment: 'test' }), /סביבה/);
});

test('provider test: forces a fresh token and reads one document page', async () => {
  const fetch = fakeFetch((c) => (c.url.includes('oauth') ? tokenOk() : { body: { total: 1234, items: [] } }));
  const r = await morning.testConnection({ environment: 'sandbox', credentials: { clientId: 'a', clientSecret: 'b' } }, { fetch });
  assert.equal(r.ok, true);
  assert.match(r.details, /1,234/);
  assert.deepEqual(fetch.calls[1].body, { page: 1, pageSize: 1 });
});
