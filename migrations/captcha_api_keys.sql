-- 验证码 API Keys 表
-- 执行方式: wrangler d1 execute abdl_space_db --remote --file=./migrations/captcha_api_keys.sql

CREATE TABLE IF NOT EXISTS captcha_api_keys (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key_prefix  TEXT NOT NULL UNIQUE,         -- 前缀 "cv_xxxx" (前8字符，用于展示)
  key_hash    TEXT NOT NULL,                -- SHA-256 完整 key
  label       TEXT,                         -- 备注名称
  permissions TEXT NOT NULL DEFAULT 'create,check', -- 逗号分隔权限
  rate_limit  INTEGER NOT NULL DEFAULT 100, -- 每小时最大请求次数
  active      INTEGER NOT NULL DEFAULT 1,   -- 0=已禁用
  last_used   INTEGER,                      -- 最后使用时间 (unix seconds)
  use_count   INTEGER NOT NULL DEFAULT 0,   -- 累计调用次数
  created_at  INTEGER NOT NULL,
  owner_id    INTEGER                       -- 创建者 user id
);

CREATE INDEX IF NOT EXISTS idx_captcha_api_keys_prefix ON captcha_api_keys(key_prefix);
CREATE INDEX IF NOT EXISTS idx_captcha_api_keys_owner ON captcha_api_keys(owner_id);
