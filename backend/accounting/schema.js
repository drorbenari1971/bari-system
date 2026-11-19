// Database tables of the customers / accounting module (docs/customers-module-design.md, section 10).
// Created on first import, in the same database file as the rest of the system. Money is in agorot.
import { db } from '../db.js';

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

db.exec(`
-- A connection to an accounting provider (Morning today; others later). Secrets are encrypted.
CREATE TABLE IF NOT EXISTS acc_connections (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  provider           TEXT NOT NULL,
  label              TEXT NOT NULL DEFAULT '',
  environment        TEXT NOT NULL DEFAULT 'production',
  credentials_enc    TEXT NOT NULL,
  webhook_secret_enc TEXT,
  settings           TEXT NOT NULL DEFAULT '{}',
  enabled            INTEGER NOT NULL DEFAULT 1,
  status             TEXT NOT NULL DEFAULT 'unchecked',  -- unchecked | ok | error
  last_check_at      TEXT,
  last_ok_at         TEXT,
  last_error         TEXT,
  created_at         TEXT NOT NULL DEFAULT ${NOW},
  updated_at         TEXT NOT NULL DEFAULT ${NOW}
);

-- Documents in the provider-neutral (canonical) model. (connection_id, external_id) prevents duplicates.
CREATE TABLE IF NOT EXISTS acc_documents (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id          INTEGER NOT NULL REFERENCES acc_connections(id),
  external_id            TEXT NOT NULL,
  kind                   TEXT NOT NULL,     -- invoice | invoice_receipt | receipt | credit_note | quote | other
  status                 TEXT NOT NULL,     -- open | closed | cancelled | cancelling
  number                 TEXT NOT NULL DEFAULT '',
  doc_date               TEXT NOT NULL,     -- YYYY-MM-DD
  created_at_ext         TEXT,              -- creation time at the provider (ISO)
  currency               TEXT NOT NULL DEFAULT 'ILS',
  gross                  INTEGER NOT NULL DEFAULT 0,
  net                    INTEGER NOT NULL DEFAULT 0,
  vat                    INTEGER NOT NULL DEFAULT 0,
  description            TEXT NOT NULL DEFAULT '',
  customer_id            INTEGER REFERENCES customers(id),
  customer_name          TEXT NOT NULL DEFAULT '',
  customer_phone         TEXT NOT NULL DEFAULT '',
  customer_email         TEXT NOT NULL DEFAULT '',
  primary_payment_method TEXT NOT NULL DEFAULT '',
  pdf_url                TEXT NOT NULL DEFAULT '',
  linked_ids             TEXT NOT NULL DEFAULT '[]',
  raw                    TEXT NOT NULL DEFAULT '{}',
  content_hash           TEXT NOT NULL DEFAULT '',
  first_seen_at          TEXT NOT NULL DEFAULT ${NOW},
  changed_at             TEXT NOT NULL DEFAULT ${NOW},
  synced_at              TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (connection_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_acc_documents_date ON acc_documents(doc_date);
CREATE INDEX IF NOT EXISTS idx_acc_documents_customer ON acc_documents(customer_id, doc_date);

CREATE TABLE IF NOT EXISTS acc_document_lines (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id      INTEGER NOT NULL REFERENCES acc_documents(id) ON DELETE CASCADE,
  row              INTEGER NOT NULL,
  sku              TEXT NOT NULL DEFAULT '',
  external_item_id TEXT NOT NULL DEFAULT '',
  description      TEXT NOT NULL DEFAULT '',
  product_key      TEXT NOT NULL DEFAULT '',
  quantity         REAL NOT NULL DEFAULT 0,
  unit_price       INTEGER NOT NULL DEFAULT 0,
  total            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_acc_lines_document ON acc_document_lines(document_id);
CREATE INDEX IF NOT EXISTS idx_acc_lines_product ON acc_document_lines(product_key);

CREATE TABLE IF NOT EXISTS acc_document_payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES acc_documents(id) ON DELETE CASCADE,
  row         INTEGER NOT NULL,
  method      TEXT NOT NULL,      -- cash | card | bank_transfer | cheque | app | paypal | withholding | other
  label       TEXT NOT NULL DEFAULT '',
  app         TEXT NOT NULL DEFAULT '',
  amount      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_acc_payments_document ON acc_document_payments(document_id);

-- Local customers. One customer can be known to several providers (customer_identities).
CREATE TABLE IF NOT EXISTS customers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT NOT NULL DEFAULT '',
  phone        TEXT NOT NULL DEFAULT '',
  phone_norm   TEXT NOT NULL DEFAULT '',
  email        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT ${NOW},
  updated_at   TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone_norm);
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(display_name);

CREATE TABLE IF NOT EXISTS customer_identities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  connection_id INTEGER NOT NULL REFERENCES acc_connections(id),
  kind          TEXT NOT NULL,     -- external_id | phone | name
  value         TEXT NOT NULL,
  UNIQUE (connection_id, kind, value)
);

-- Internal queue: every unit of work (webhook, polling, manual, replay) goes through it.
CREATE TABLE IF NOT EXISTS acc_jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id   INTEGER REFERENCES acc_connections(id),
  type            TEXT NOT NULL,
  source          TEXT NOT NULL,   -- webhook | polling | manual | replay | system
  priority        INTEGER NOT NULL DEFAULT 0,
  payload         TEXT NOT NULL DEFAULT '{}',
  dedupe_key      TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | processing | completed | failed | retry
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 8,
  next_attempt_at TEXT NOT NULL DEFAULT ${NOW},
  locked_at       TEXT,
  started_at      TEXT,
  finished_at     TEXT,
  duration_ms     INTEGER,
  last_error      TEXT,
  result          TEXT,
  created_at      TEXT NOT NULL DEFAULT ${NOW}
);
-- A dedupe key blocks a second job only while the first one is still waiting or running.
CREATE UNIQUE INDEX IF NOT EXISTS idx_acc_jobs_dedupe ON acc_jobs(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'processing', 'retry');
CREATE INDEX IF NOT EXISTS idx_acc_jobs_ready ON acc_jobs(status, next_attempt_at, priority);
CREATE INDEX IF NOT EXISTS idx_acc_jobs_created ON acc_jobs(created_at);

-- Every change to module data, with the state before and after.
CREATE TABLE IF NOT EXISTS acc_audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL DEFAULT ${NOW},
  action      TEXT NOT NULL,
  source      TEXT NOT NULL,
  job_id      INTEGER,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  external_id TEXT,
  before      TEXT,
  after       TEXT,
  changes     TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_acc_audit_entity ON acc_audit_log(entity_type, entity_id, at);
CREATE INDEX IF NOT EXISTS idx_acc_audit_at ON acc_audit_log(at);
CREATE INDEX IF NOT EXISTS idx_acc_audit_action ON acc_audit_log(action);

-- Raw webhook deliveries exactly as received. Read-only: business logic never reads it.
CREATE TABLE IF NOT EXISTS acc_webhook_archive (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id    INTEGER,
  received_at      TEXT NOT NULL DEFAULT ${NOW},
  delivery_id      TEXT,
  topic            TEXT,
  webhook_id       TEXT,
  event_timestamp  TEXT,
  correlation_id   TEXT,
  headers          TEXT NOT NULL DEFAULT '{}',
  body             BLOB,
  body_sha256      TEXT,
  body_truncated   INTEGER NOT NULL DEFAULT 0,
  remote_ip        TEXT,
  user_agent       TEXT,
  signature_valid  INTEGER NOT NULL DEFAULT 0,
  rejection_reason TEXT,
  job_id           INTEGER
);
CREATE INDEX IF NOT EXISTS idx_acc_archive_delivery ON acc_webhook_archive(delivery_id);
CREATE INDEX IF NOT EXISTS idx_acc_archive_received ON acc_webhook_archive(received_at);
CREATE INDEX IF NOT EXISTS idx_acc_archive_topic ON acc_webhook_archive(topic);

CREATE TABLE IF NOT EXISTS acc_sync_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER REFERENCES acc_connections(id),
  type          TEXT NOT NULL,
  source        TEXT NOT NULL,
  started_at    TEXT NOT NULL DEFAULT ${NOW},
  finished_at   TEXT,
  fetched       INTEGER NOT NULL DEFAULT 0,
  added         INTEGER NOT NULL DEFAULT 0,
  updated       INTEGER NOT NULL DEFAULT 0,
  unchanged     INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_acc_sync_runs_started ON acc_sync_runs(started_at);

CREATE TABLE IF NOT EXISTS acc_feature_flags (
  key        TEXT PRIMARY KEY,
  enabled    INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT ${NOW},
  updated_by TEXT NOT NULL DEFAULT 'manual'
);

-- ---- BI: facts (one row per counted sale) and incrementally maintained summaries ----
CREATE TABLE IF NOT EXISTS sales_facts (
  document_id INTEGER PRIMARY KEY REFERENCES acc_documents(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,
  customer_id INTEGER,
  gross       INTEGER NOT NULL,
  net         INTEGER NOT NULL,
  method      TEXT NOT NULL DEFAULT '',
  deal_count  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sales_facts_date ON sales_facts(date);
CREATE INDEX IF NOT EXISTS idx_sales_facts_customer ON sales_facts(customer_id, date);

CREATE TABLE IF NOT EXISTS sales_fact_lines (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES acc_documents(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,
  customer_id INTEGER,
  product_key TEXT NOT NULL,
  quantity    REAL NOT NULL,
  gross       INTEGER NOT NULL,
  net         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sales_fact_lines_document ON sales_fact_lines(document_id);
CREATE INDEX IF NOT EXISTS idx_sales_fact_lines_product ON sales_fact_lines(product_key, date);

CREATE TABLE IF NOT EXISTS bi_daily (
  date          TEXT PRIMARY KEY,
  gross         INTEGER NOT NULL DEFAULT 0,
  net           INTEGER NOT NULL DEFAULT 0,
  deals         INTEGER NOT NULL DEFAULT 0,
  customers     INTEGER NOT NULL DEFAULT 0,
  new_customers INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bi_daily_method (
  date   TEXT NOT NULL,
  method TEXT NOT NULL,
  gross  INTEGER NOT NULL DEFAULT 0,
  net    INTEGER NOT NULL DEFAULT 0,
  deals  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, method)
);
CREATE TABLE IF NOT EXISTS bi_daily_product (
  date        TEXT NOT NULL,
  product_key TEXT NOT NULL,
  quantity    REAL NOT NULL DEFAULT 0,
  gross       INTEGER NOT NULL DEFAULT 0,
  net         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, product_key)
);
CREATE TABLE IF NOT EXISTS bi_daily_customer (
  date        TEXT NOT NULL,
  customer_id INTEGER NOT NULL,
  deals       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, customer_id)
);
CREATE TABLE IF NOT EXISTS bi_customer_stats (
  customer_id   INTEGER PRIMARY KEY,
  deals         INTEGER NOT NULL DEFAULT 0,
  gross         INTEGER NOT NULL DEFAULT 0,
  net           INTEGER NOT NULL DEFAULT 0,
  first_date    TEXT,
  last_date     TEXT,
  last_method   TEXT NOT NULL DEFAULT '',
  gap_days_sum  INTEGER NOT NULL DEFAULT 0,
  gap_count     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bi_monthly_new_customers (
  month TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bi_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);
