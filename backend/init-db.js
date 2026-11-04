// Creates backend/data/bari.db with the full schema and (optionally) demo data.
import { env } from './config.js';
import { db } from './db.js';
import { seedDemoIfEmpty } from './seed.js';

const seeded = env('SEED_DEMO', 'true') === 'true' && seedDemoIfEmpty();
const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
console.log(`Database ready (backend/data/bari.db). posts=${count('posts')} tasks=${count('tasks')} comments=${count('comments')}${seeded ? ' [demo data seeded]' : ''}`);
