// Entry point of the accounting / customers module, used by server.js.
import './schema.js';
import { startWorker } from './worker.js';

export function startAccounting() {
  startWorker();
  console.log('[accounting] queue worker running');
}
