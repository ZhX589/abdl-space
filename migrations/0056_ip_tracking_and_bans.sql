-- 定向 IP 追踪与全局封禁：管理员只可通过受保护的管理接口操作。
CREATE TABLE IF NOT EXISTS ip_tracking_rules (
  user_id INTEGER PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS ip_tracking_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  ip TEXT NOT NULL,
  user_agent TEXT,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_ip_tracking_events_user_created
  ON ip_tracking_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ip_tracking_events_ip
  ON ip_tracking_events(ip);

CREATE TABLE IF NOT EXISTS ip_bans (
  ip TEXT PRIMARY KEY,
  source_user_id INTEGER,
  reason TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (source_user_id) REFERENCES users(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);
