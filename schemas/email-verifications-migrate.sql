-- ============================================================
-- 邮件验证安全升级迁移
-- 执行命令：wrangler d1 execute abdl-space-db --remote --file schemas/email-verifications-migrate.sql
-- ============================================================

-- 1. 重建 email_verifications 表（加 attempts 字段，code 改为 code_hash）
CREATE TABLE IF NOT EXISTS email_verifications_new (
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

-- 迁移旧数据（如果有）
INSERT INTO email_verifications_new (id, user_id, email, code_hash, type, used, attempts, expires_at, created_at)
SELECT id, user_id, email, code, type, used, 0, expires_at, created_at
FROM email_verifications
WHERE 1 = 1;

-- 替换表
DROP TABLE IF EXISTS email_verifications;
ALTER TABLE email_verifications_new RENAME TO email_verifications;

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
