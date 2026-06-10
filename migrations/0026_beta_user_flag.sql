-- ============================================================
-- 创始成员计划迁移 — 0026
-- 适用场景：创始成员计划 (Beta) 标识
-- 执行方式：wrangler d1 execute abdl-space-db --file=./migrations/0026_beta_user_flag.sql
-- 注意：ALTER TABLE ADD COLUMN 若列已存在会报错，可安全忽略
-- ============================================================

-- 1. users 表：创始成员标识 + 内测注册时间
ALTER TABLE users ADD COLUMN is_beta_user INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN beta_registered_at DATETIME;

-- 2. 索引：快速统计当前创始成员名额
CREATE INDEX IF NOT EXISTS idx_users_is_beta_user ON users(is_beta_user);
