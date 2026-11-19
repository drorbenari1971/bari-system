// Encryption of provider credentials at rest (AES-256-GCM).
// The key lives in backend/.env as ACCOUNTING_SECRET_KEY; it is created there on first use.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BACKEND_DIR, env } from '../config.js';

let cachedKey = null;

function loadKey() {
  if (cachedKey) return cachedKey;
  let encoded = env('ACCOUNTING_SECRET_KEY');
  if (!encoded) {
    encoded = crypto.randomBytes(32).toString('base64');
    const file = path.join(BACKEND_DIR, '.env');
    const line = `\n# Encrypts accounting credentials stored in the database. Do not change or share it.\nACCOUNTING_SECRET_KEY=${encoded}\n`;
    fs.appendFileSync(file, line, 'utf8');
    process.env.ACCOUNTING_SECRET_KEY = encoded;
    console.log('[accounting] created ACCOUNTING_SECRET_KEY in backend/.env');
  }
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('ACCOUNTING_SECRET_KEY must be 32 bytes, base64-encoded');
  cachedKey = key;
  return key;
}

/** @param {object} value any JSON value @returns {string} "v1.<iv>.<tag>.<ciphertext>" (base64 parts) */
export function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), data].map((p) => (typeof p === 'string' ? p : p.toString('base64'))).join('.');
}

/** @param {string} text output of encrypt() @returns {any} */
export function decrypt(text) {
  const [version, iv, tag, data] = String(text).split('.');
  if (version !== 'v1' || !data) throw new Error('Unknown encrypted value format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

/** "a1b2c3d4-...-5c5d" -> "a1b2…5c5d": enough to recognise a value without revealing it. */
export const mask = (value) => {
  const s = String(value ?? '');
  return s.length <= 8 ? '•'.repeat(s.length) : `${s.slice(0, 4)}…${s.slice(-4)}`;
};
