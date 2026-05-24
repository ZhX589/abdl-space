-- 添加 NewBabyWorld UID 字段用于第三方 OAuth 绑定
ALTER TABLE users ADD COLUMN nbw_uid TEXT DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_users_nbw_uid ON users(nbw_uid);
