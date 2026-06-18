-- QR 登录会话表
CREATE TABLE IF NOT EXISTS qr_login_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER,
  status TEXT DEFAULT 'pending',  -- pending | scanned | authorized | expired
  created_at INTEGER DEFAULT (unixepoch()),
  expires_at INTEGER,
  ip TEXT,
  user_agent TEXT
);

-- 索引：按状态查询（轮询用）
CREATE INDEX IF NOT EXISTS idx_qr_sessions_status ON qr_login_sessions(status);

-- 索引：按过期时间清理
CREATE INDEX IF NOT EXISTS idx_qr_sessions_expires ON qr_login_sessions(expires_at);
