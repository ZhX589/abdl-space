-- JPush 注册表
CREATE TABLE IF NOT EXISTS jpush_registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  reg_id TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  last_active_at INTEGER DEFAULT (unixepoch())
);

-- 索引：按用户查询
CREATE INDEX IF NOT EXISTS idx_jpush_user ON jpush_registrations(user_id);

-- 索引：按 regId 查询
CREATE UNIQUE INDEX IF NOT EXISTS idx_jpush_regid ON jpush_registrations(reg_id);
