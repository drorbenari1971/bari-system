// Entry point of the accounting / customers module, used by server.js.
import './schema.js';
import './sync.js'; // registers the sync job handlers
import { startWorker } from './worker.js';
import { startPolling } from './polling.js';
import { startWebhookReceiver } from './webhookReceiver.js';
import { alertOnChange } from './webhookHealth.js';

const HEALTH_CHECK_MS = 60_000;

export function startAccounting() {
  startWorker();
  startPolling();
  startWebhookReceiver();
  setInterval(() => {
    try { alertOnChange(); } catch (err) { console.error('[accounting] webhook health check failed:', err.message); }
  }, HEALTH_CHECK_MS);
  console.log('[accounting] queue worker and customer sync schedule running');
}
