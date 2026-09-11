-- Standalone, replay-safe stock state. Core code batches own encrypted raw codes.
CREATE TABLE IF NOT EXISTS sponsor_stock_settings (
  plan_id TEXT PRIMARY KEY NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
  low_water INTEGER NOT NULL DEFAULT 3 CHECK (low_water >= 0 AND low_water < target_stock),
  target_stock INTEGER NOT NULL DEFAULT 10 CHECK (target_stock BETWEEN 1 AND 200),
  batch_size INTEGER NOT NULL DEFAULT 5 CHECK (batch_size BETWEEN 1 AND 200),
  check_interval_seconds INTEGER NOT NULL DEFAULT 900 CHECK (check_interval_seconds BETWEEN 300 AND 86400),
  last_stock INTEGER,
  product_stock INTEGER,
  observed_line_count INTEGER,
  last_checked_at INTEGER,
  next_check_at INTEGER,
  last_error TEXT,
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0,1)),
  read_fingerprint TEXT,
  verified_fingerprint TEXT,
  CHECK (enabled = 0 OR verified = 1)
);
INSERT OR IGNORE INTO sponsor_stock_settings (plan_id) VALUES ('week'),('month'),('quarter'),('year'),('permanent');
CREATE INDEX IF NOT EXISTS idx_sponsor_stock_due ON sponsor_stock_settings (enabled, paused, next_check_at);

CREATE TABLE IF NOT EXISTS sponsor_stock_leases (
  sku_id TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sponsor_stock_batches (
  id TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  plan_id TEXT NOT NULL,
  afdian_plan_id TEXT NOT NULL,
  sku_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  code_batch_id TEXT UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('prepared','sending','confirmed','unknown','rejected')),
  count INTEGER NOT NULL CHECK (count BETWEEN 1 AND 200),
  initial_probe INTEGER NOT NULL CHECK (initial_probe IN (0,1)),
  actor_id TEXT,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  confirmed_at INTEGER,
  last_error TEXT,
  FOREIGN KEY (plan_id) REFERENCES sponsor_stock_settings(plan_id)
);
-- Durable barrier independent of lease time: never start another write while uncertain.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sponsor_stock_unresolved_sku ON sponsor_stock_batches (sku_id)
  WHERE state IN ('prepared','sending','unknown');
CREATE INDEX IF NOT EXISTS idx_sponsor_stock_batches_page ON sponsor_stock_batches (created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_sponsor_stock_batches_plan ON sponsor_stock_batches (plan_id, state);

-- Stock actions are audited through core recordSponsorAudit into sponsor_audit.
