-- 推送配置表（存储 VAPID 密钥和 JPush 配置）
CREATE TABLE IF NOT EXISTS push_config (
  id INTEGER PRIMARY KEY DEFAULT 1,
  jpush_app_key TEXT,
  jpush_master_secret TEXT,
  jpush_enabled INTEGER DEFAULT 0,
  vapid_public_key TEXT,
  vapid_private_key TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

-- 推送订阅表（多平台支持：web + jpush）
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  platform TEXT NOT NULL DEFAULT 'web',
  endpoint TEXT,
  p256dh TEXT,
  auth TEXT,
  registration_id TEXT,
  alias TEXT,
  tags TEXT,
  device_info TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(user_id, platform, endpoint),
  UNIQUE(user_id, platform, registration_id)
);

CREATE INDEX IF NOT EXISTS idx_push_sub_user ON push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_push_sub_platform ON push_subscriptions(platform);

-- 推送记录表
CREATE TABLE IF NOT EXISTS push_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER,
  target_type TEXT NOT NULL,
  target_ids TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT,
  platform TEXT DEFAULT 'all',
  sent_count INTEGER DEFAULT 0,
  fail_count INTEGER DEFAULT 0,
  jpush_msg_id TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_push_logs_created ON push_logs(created_at);
