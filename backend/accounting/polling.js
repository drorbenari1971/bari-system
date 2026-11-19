// Schedule for the customer sync. Every minute it checks each enabled, working connection:
// no run yet -> the initial full sync; otherwise a new run once the chosen interval has passed.
// Controlled by the 'polling' and 'autoSync' flags; a manual sync from the screen always works.
import './schema.js'; // tables must exist before statements are prepared
import { db } from '../db.js';
import { isEnabled } from './flags.js';
import { latestCustomerRun, requestCustomerSync } from './sync.js';

export const CUSTOMER_SYNC_MINUTES = [15, 60, 360];
export const DEFAULT_CUSTOMER_SYNC_MINUTES = 60;
const TICK_MS = 60_000;

let timer = null;

export function customerSyncMinutes(settings) {
  const m = Number(settings?.customerSyncMinutes);
  return CUSTOMER_SYNC_MINUTES.includes(m) ? m : DEFAULT_CUSTOMER_SYNC_MINUTES;
}

/** Connections whose customer sync is due now: [{ connectionId, source }]. */
export function dueCustomerSyncs(now = Date.now()) {
  if (!isEnabled('autoSync') || !isEnabled('polling')) return [];
  // 'ok' = the last connection check (or sync) succeeded; after an auth failure nothing runs
  // until the connection is fixed and checked again.
  const connections = db.prepare("SELECT id, settings FROM acc_connections WHERE enabled = 1 AND status = 'ok'").all();
  const due = [];
  for (const c of connections) {
    const last = latestCustomerRun(c.id);
    if (!last) { due.push({ connectionId: c.id, source: 'system' }); continue; }
    if (last.status === 'running') continue;
    if (now - Date.parse(last.started_at) >= customerSyncMinutes(JSON.parse(c.settings)) * 60_000) {
      due.push({ connectionId: c.id, source: 'polling' });
    }
  }
  return due;
}

export function pollTick(now = Date.now()) {
  for (const { connectionId, source } of dueCustomerSyncs(now)) requestCustomerSync(connectionId, source);
}

export function startPolling() {
  if (timer) return;
  timer = setInterval(() => {
    try { pollTick(); } catch (err) { console.error('[accounting] polling failed:', err.message); }
  }, TICK_MS);
  try { pollTick(); } catch (err) { console.error('[accounting] polling failed:', err.message); }
}

export function stopPolling() {
  clearInterval(timer);
  timer = null;
}
