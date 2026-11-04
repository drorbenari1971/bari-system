// Loads backend/.env regardless of the directory the server is started from.
// Must be the first import in server.js / init-db.js.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const BACKEND_DIR = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(BACKEND_DIR, '.env') });

export const env = (key, fallback = '') => (process.env[key] ?? '').trim() || fallback;
