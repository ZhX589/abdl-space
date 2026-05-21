-- 验证码会话表
-- 执行方式: wrangler d1 execute abdl_space_db --file=./migrations/captcha_sessions.sql

CREATE TABLE IF NOT EXISTS captcha_sessions (
  session_id    TEXT PRIMARY KEY,
  type          TEXT NOT NULL DEFAULT 'quantum',
  challenge     TEXT NOT NULL,
  answer_hash   TEXT NOT NULL,
  salt          TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 5,
  locked_until  INTEGER NOT NULL DEFAULT 0,
  ip            TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  used          INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_captcha_expires ON captcha_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_captcha_ip ON captcha_sessions(ip, created_at);
