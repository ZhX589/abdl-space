-- ============================================================
-- 邮件验证安全升级迁移（修正版）
-- 执行命令：wrangler d1 execute abdl-space-db --remote --file schemas/email-verifications-migrate.sql
-- ============================================================

-- 1. 删除旧表重建（数据为空，无需迁移）
DROP TABLE IF EXISTS email_verifications;

CREATE TABLE IF NOT EXISTS email_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  type TEXT NOT NULL,
  used INTEGER DEFAULT 0,
  attempts INTEGER DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_email_ver_email ON email_verifications(email);
CREATE INDEX IF NOT EXISTS idx_email_ver_lookup ON email_verifications(email, code_hash, type, used);

-- 2. 创建 D1 限流表
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER DEFAULT 1,
  window_start TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON rate_limits(expires_at);
