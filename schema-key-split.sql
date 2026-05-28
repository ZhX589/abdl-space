-- Key Split 表结构
CREATE TABLE IF NOT EXISTS ks_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key_enc TEXT NOT NULL,
  models TEXT DEFAULT '[]',
  enabled INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS ks_sub_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  name TEXT DEFAULT '',
  channel_ids TEXT DEFAULT '[]',
  quota_tokens INTEGER DEFAULT -1,
  used_tokens INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch()),
  last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS ks_usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sub_key_id INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,
  model TEXT DEFAULT '',
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  request_at INTEGER DEFAULT (unixepoch()),
  status INTEGER DEFAULT 200,
  latency_ms INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ks_usage_sub_key ON ks_usage_logs(sub_key_id);
CREATE INDEX IF NOT EXISTS idx_ks_usage_request_at ON ks_usage_logs(request_at);
CREATE INDEX IF NOT EXISTS idx_ks_sub_keys_hash ON ks_sub_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_ks_channels_owner ON ks_channels(owner_id);
CREATE INDEX IF NOT EXISTS idx_ks_sub_keys_owner ON ks_sub_keys(owner_id);
