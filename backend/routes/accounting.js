// /api/accounting: provider connections, sync, webhooks, customers screen, queue, flags and audit log (local only).
import { Router } from 'express';
import { listProviders, getProvider } from '../accounting/providers/index.js';
import * as webhookConfig from '../accounting/webhookConfig.js';
import * as webhookHealth from '../accounting/webhookHealth.js';
import { describeProvider } from '../accounting/providers/base.js';
import * as connections from '../accounting/connections.js';
import * as queue from '../accounting/queue.js';
import * as audit from '../accounting/audit.js';
import { kick } from '../accounting/worker.js';
import * as sync from '../accounting/sync.js';
import * as flags from '../accounting/flags.js';
import * as customers from '../accounting/customersQuery.js';
import { dashboard } from '../accounting/bi.js';
import * as orders from '../accounting/orders.js';
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

// The webhook secret and address are never set here: only generated, through /connections/:id/webhook/*.
router.post('/connections', wrap(async (req, res) => {
  const { provider, label, environment, credentials } = req.body ?? {};
  res.status(201).json(connections.createConnection({ provider, label, environment, credentials: credentials ?? {} }));
}));

const EDITABLE_SETTINGS = ['customerSyncMinutes'];
router.put('/connections/:id', wrap(async (req, res) => {
  const { label, environment, credentials, enabled, settings } = req.body ?? {};
  if (settings !== undefined && (typeof settings !== 'object' || Object.keys(settings).some((k) => !EDITABLE_SETTINGS.includes(k)))) {
    throw new AccountingError('הגדרה לא נתמכת', { code: 'validation' });
  }
  if (settings?.customerSyncMinutes !== undefined && !CUSTOMER_SYNC_MINUTES.includes(Number(settings.customerSyncMinutes))) {
    throw new AccountingError('תדירות סנכרון לא נתמכת', { code: 'validation' });
  }
  res.json(connections.updateConnection(idParam(req), { label, environment, credentials, enabled, settings }));
}));

router.get('/connections/:id/webhook', wrap(async (req, res) => {
  const id = idParam(req);
  res.json({ ...webhookConfig.webhookView(id), health: webhookHealth.webhookHealth(id), deliveries: webhookHealth.listDeliveries({ connectionId: id, pageSize: 20 }).items });
}));

// Returns the new secret this one time; it cannot be read back later.
router.post('/connections/:id/webhook/secret', wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store').json(webhookConfig.createSecret(idParam(req)));
}));

router.post('/connections/:id/webhook/token', wrap(async (req, res) => {
  res.json(webhookConfig.rotateToken(idParam(req)));
}));

router.get('/webhook-deliveries', (req, res) => {
  const { connectionId, outcome, page, pageSize } = req.query;
  res.json(webhookHealth.listDeliveries({ connectionId, outcome, page, pageSize }));
});

// Runs the job of an accepted delivery again (the body is not kept; the job holds the referenced ID).
router.post('/webhook-deliveries/:id/replay', wrap(async (req, res) => {
  const delivery = webhookHealth.getDelivery(idParam(req));
  if (!delivery || delivery.outcome !== 'accepted') throw new AccountingError('אפשר להריץ שוב רק אירוע שהתקבל', { code: 'conflict' });
  const original = delivery.job_id ? queue.getJob(delivery.job_id) : null;
  if (!original) throw new AccountingError('המשימה המקורית כבר נמחקה מהתור (נשמרת 30 יום)', { code: 'conflict' });
  const { job } = queue.enqueue({ type: original.type, source: 'replay', connectionId: original.connection_id, payload: original.payload });
  kick();
  res.status(202).json({ jobId: job.id });
}));

router.get('/health', (req, res) => {
  const webhooks = connections.listConnections()
    .filter((c) => getProvider(c.provider).capabilities.webhooks)
    .map((c) => ({ connectionId: c.id, label: c.label, ...webhookHealth.webhookHealth(c.id) }));
  res.json({ queue: queue.counts(), webhooks });
});

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

const RUN_TYPES = ['customers', 'documents'];
router.get('/sync-runs', (req, res) => {
  const { connectionId, type, page, pageSize } = req.query;
  if (type && !RUN_TYPES.includes(type)) return res.status(400).json({ error: 'סוג סנכרון לא מוכר' });
  const result = sync.listRuns({ connectionId, type, page, pageSize });
  if (!connectionId) return res.json(result);
  const id = Number(connectionId);
  res.json({
    ...result,
    knownCustomers: sync.knownCustomers(id),
    knownDocuments: sync.knownDocuments(id),
    totalCustomers: sync.totalCustomers(),
    latest: Object.fromEntries(RUN_TYPES.map((t) => [t, sync.latestRun(id, t)])),
  });
});

// Customers screen (stage 4).
router.get('/customers', wrap(async (req, res) => {
  const { q, segment, sort, page, pageSize } = req.query;
  res.json({ ...customers.listCustomers({ q, segment, sort, page, pageSize }), summary: customers.customersSummary() });
}));

router.get('/customers/export.csv', wrap(async (req, res) => {
  const { q, segment, sort } = req.query;
  const csv = customers.exportCustomersCsv({ q, segment, sort });
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="customers-${new Date().toISOString().slice(0, 10)}.csv"`,
    'Cache-Control': 'no-store',
  }).send(csv);
}));

router.get('/customers/:id', wrap(async (req, res) => res.json(customers.getCustomerCard(idParam(req)))));

// Business dashboard (stage 5).
router.get('/bi/dashboard', wrap(async (req, res) => {
  const { from, to, granularity, product, method } = req.query;
  res.json(dashboard({ from, to, granularity, product, method }));
}));

// "הזמנה חדשה": catalog, preview, issue (create client + receipt at the provider), and orders.
const connectionParam = (v) => {
  const id = Number(v);
  if (!Number.isInteger(id) || id < 1) throw new AccountingError('חסר חיבור', { code: 'validation' });
  return id;
};
router.get('/orders/catalog', wrap(async (req, res) => res.json(await orders.catalog(connectionParam(req.query.connectionId)))));

router.post('/orders/preview', wrap(async (req, res) => {
  const { connectionId, order } = req.body ?? {};
  res.set('Cache-Control', 'no-store').json(await orders.previewOrder(connectionParam(connectionId), order));
}));

router.post('/orders', wrap(async (req, res) => {
  const { connectionId, orderKey, order } = req.body ?? {};
  res.json(await orders.submitOrder(connectionParam(connectionId), orderKey, order));
}));

router.get('/orders', (req, res) => {
  const { status, page, pageSize } = req.query;
  res.json(orders.listOrders({ status, page, pageSize }));
});

router.get('/orders/:id', wrap(async (req, res) => {
  const order = orders.getOrder(idParam(req));
  if (!order) throw new AccountingError('ההזמנה לא נמצאה', { code: 'not_found' });
  res.json(order);
}));

router.post('/orders/:id/reconcile', wrap(async (req, res) => res.json(await orders.reconcileOrder(idParam(req)))));

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
