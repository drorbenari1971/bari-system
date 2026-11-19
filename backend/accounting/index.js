// Entry point of the accounting / customers module, used by server.js.
import './schema.js';
import './sync.js'; // registers the sync job handlers
import { startWorker } from './worker.js';
import { startPolling } from './polling.js';

export function startAccounting() {
  startWorker();
  startPolling();
  console.log('[accounting] queue worker and customer sync schedule running');
}
