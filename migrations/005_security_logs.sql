-- security_logs 表：记录可疑行为
CREATE TABLE IF NOT EXISTS security_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  event_type TEXT NOT NULL,       -- low_behavior_score, context_mismatch, tamper_detected, etc.
  score INTEGER DEFAULT 0,        -- 行为评分 0-100
  ip TEXT,
  user_agent TEXT,
  details TEXT,                   -- JSON 详细数据
  created_at INTEGER NOT NULL     -- Unix timestamp
);

CREATE INDEX IF NOT EXISTS idx_security_logs_created ON security_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_security_logs_type ON security_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_security_logs_session ON security_logs(session_id);
