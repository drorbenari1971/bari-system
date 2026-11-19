// /api/accounting: provider connections, customer sync, queue, flags and audit log (local only).
import { Router } from 'express';
import { listProviders } from '../accounting/providers/index.js';
import { describeProvider } from '../accounting/providers/base.js';
import * as connections from '../accounting/connections.js';
import * as queue from '../accounting/queue.js';
import * as audit from '../accounting/audit.js';
import { kick } from '../accounting/worker.js';
import * as sync from '../accounting/sync.js';
import * as flags from '../accounting/flags.js';
import { CUSTOMER_SYNC_MINUTES } from '../accounting/polling.js';
import { AccountingError } from '../accounting/errors.js';

const router = Router();

// AccountingError carries its own HTTP status (or a code that maps to one).
const STATUS_BY_CODE = { validation: 400, not_found: 404, conflict: 409 };
const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof AccountingError) {
      return res.status(err.status && err.status < 500 ? err.status : STATUS_BY_CODE[err.code] ?? 502).json({ error: err.message, code: err.code });
    }
    next(err);
  }
};
const idParam = (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw new AccountingError('מזהה לא תקין', { code: 'validation' });
  return id;
};

router.get('/providers', (req, res) => res.json(listProviders().map(describeProvider)));

router.get('/connections', (req, res) => res.json(connections.listConnections()));

router.post('/connections', wrap(async (req, res) => {
  const { provider, label, environment, credentials, webhookSecret } = req.body ?? {};
  res.status(201).json(connections.createConnection({ provider, label, environment, credentials: credentials ?? {}, webhookSecret }));
}));

router.put('/connections/:id', wrap(async (req, res) => {
  const { label, environment, credentials, webhookSecret, enabled, settings } = req.body ?? {};
  if (settings?.customerSyncMinutes !== undefined && !CUSTOMER_SYNC_MINUTES.includes(Number(settings.customerSyncMinutes))) {
    throw new AccountingError('תדירות סנכרון לא נתמכת', { code: 'validation' });
  }
  res.json(connections.updateConnection(idParam(req), { label, environment, credentials, webhookSecret, enabled, settings }));
}));

router.delete('/connections/:id', wrap(async (req, res) => {
  connections.deleteConnection(idParam(req));
  res.json({ ok: true });
}));

router.post('/connections/:id/test', wrap(async (req, res) => {
  res.json(await connections.testConnection(idParam(req)));
}));

// Manual customer sync. Works even when the schedule is off (flags) - only a disabled connection blocks it.
router.post('/connections/:id/sync', wrap(async (req, res) => {
  const id = idParam(req);
  const conn = connections.getConnectionView(id);
  if (!conn) throw new AccountingError('החיבור לא נמצא', { code: 'not_found' });
  if (!conn.enabled) throw new AccountingError('החיבור מושבת. הפעילו אותו כדי לסנכרן.', { code: 'conflict' });
  const { job, created } = sync.requestCustomerSync(id, 'manual');
  res.status(created ? 202 : 200).json({ jobId: job.id, alreadyQueued: !created });
}));

router.get('/sync-runs', (req, res) => {
  const { connectionId, page, pageSize } = req.query;
  const result = sync.listRuns({ connectionId, page, pageSize });
  res.json(connectionId ? { ...result, knownCustomers: sync.knownCustomers(Number(connectionId)) } : result);
});

router.get('/flags', (req, res) => res.json(flags.listFlags()));

router.put('/flags/:key', wrap(async (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') throw new AccountingError('ערך לא תקין', { code: 'validation' });
  res.json(flags.setFlag(req.params.key, req.body.enabled));
}));

router.get('/jobs', (req, res) => {
  const { status, type, page, pageSize } = req.query;
  if (status && !queue.STATUSES.includes(status)) return res.status(400).json({ error: 'סטטוס לא מוכר' });
  res.json({ ...queue.list({ status, type, page, pageSize }), counts: queue.counts() });
});

router.post('/jobs/:id/retry', wrap(async (req, res) => {
  if (!queue.retryNow(idParam(req))) return res.status(409).json({ error: 'אפשר לנסות שוב רק משימה שנכשלה או ממתינה לניסיון חוזר' });
  kick();
  res.json(queue.getJob(idParam(req)));
}));

router.get('/audit', (req, res) => {
  const { entityType, entityId, action, source, from, to, page, pageSize } = req.query;
  res.json(audit.list({ entityType, entityId, action, source, from, to, page, pageSize }));
});

export default router;
