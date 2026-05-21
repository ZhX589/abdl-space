-- 为 oauth_clients 添加 token_endpoint_auth_method 字段
-- 支持公开客户端（PKCE，无 secret）
-- 执行方式: wrangler d1 execute abdl_space_db --remote --file=./migrations/oauth_add_auth_method.sql

ALTER TABLE oauth_clients ADD COLUMN token_endpoint_auth_method TEXT NOT NULL DEFAULT 'client_secret_post';
