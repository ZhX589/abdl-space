-- ============================================================
-- Key Split — API Key 代理系统表结构
-- ============================================================

-- 渠道表（上游 API 服务商）
CREATE TABLE IF NOT EXISTS ks_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key_enc TEXT NOT NULL,              -- AES-GCM 加密后的 API Key
  models TEXT DEFAULT '[]',               -- JSON 数组，支持的模型列表（空=全部）
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 子 Key 表（分发给他人的 API Key）
CREATE TABLE IF NOT EXISTS ks_sub_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash TEXT NOT NULL UNIQUE,          -- SHA-256(raw_key)
  key_prefix TEXT NOT NULL,               -- 前 11 字符，用于展示
  name TEXT DEFAULT '',
  channel_ids TEXT DEFAULT '[]',          -- JSON 数组，绑定的渠道 ID（空=全部）
  quota_tokens INTEGER NOT NULL DEFAULT -1, -- 额度上限（-1=无限）
  used_tokens INTEGER NOT NULL DEFAULT 0,
  owner_id INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 用量日志表
CREATE TABLE IF NOT EXISTS ks_usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sub_key_id INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,
  model TEXT DEFAULT '',
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 200,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  request_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (sub_key_id) REFERENCES ks_sub_keys(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES ks_channels(id) ON DELETE CASCADE
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_ks_channels_owner ON ks_channels(owner_id);
CREATE INDEX IF NOT EXISTS idx_ks_sub_keys_owner ON ks_sub_keys(owner_id);
CREATE INDEX IF NOT EXISTS idx_ks_sub_keys_hash ON ks_sub_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_ks_sub_keys_hash_enabled ON ks_sub_keys(key_hash, enabled);
CREATE INDEX IF NOT EXISTS idx_ks_usage_logs_sub_key ON ks_usage_logs(sub_key_id);
CREATE INDEX IF NOT EXISTS idx_ks_usage_logs_channel ON ks_usage_logs(channel_id);
CREATE INDEX IF NOT EXISTS idx_ks_usage_logs_time ON ks_usage_logs(request_at);
