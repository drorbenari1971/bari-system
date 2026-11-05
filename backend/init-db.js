// Creates backend/data/bari.db with the full schema and (optionally) demo data.
import { env } from './config.js';
import { db } from './db.js';
import { seedDemoIfEmpty, seedFinanceDemoIfEmpty } from './seed.js';

const seedEnabled = env('SEED_DEMO', 'true') === 'true';
const seeded = seedEnabled && seedDemoIfEmpty();
if (seedEnabled) seedFinanceDemoIfEmpty();
const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
console.log(`Database ready (backend/data/bari.db). posts=${count('posts')} tasks=${count('tasks')} comments=${count('comments')}${seeded ? ' [demo data seeded]' : ''}`);
