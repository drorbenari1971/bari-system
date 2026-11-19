// Test setup: every test file gets its own empty data folder and encryption key,
// so tests never touch the real database or backend/.env.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export function isolate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bari-test-'));
  process.env.BARI_DATA_DIR = dir;
  process.env.ACCOUNTING_SECRET_KEY = crypto.randomBytes(32).toString('base64');
  process.env.SEED_DEMO = 'false';
  return async () => {
    // Windows cannot delete an open database file: close it first if this test file opened it.
    const { db } = await import('../db.js');
    if (db.isOpen) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
}

/** A fetch stub: routes(url, init) returns { status, body, headers } or throws. Records every call. */
export function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const r = await routes(call);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  };
  fn.calls = calls;
  return fn;
}

export const noSleep = async () => {};
