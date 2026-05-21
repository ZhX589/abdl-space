-- OAuth 2.0 三表迁移
-- 执行方式: wrangler d1 execute abdl_space_db --remote --file=./migrations/oauth.sql

-- 1. OAuth 客户端（第三方应用）
CREATE TABLE IF NOT EXISTS oauth_clients (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id     TEXT NOT NULL UNIQUE,          -- 公开标识: "oc_" + 32 hex
  client_secret TEXT NOT NULL,                 -- SHA-256 哈希存储，不存明文
  name          TEXT NOT NULL,                 -- 应用名称
  description   TEXT,                          -- 应用描述
  logo_url      TEXT,                          -- 应用 logo
  homepage_url  TEXT,                          -- 应用主页
  redirect_uris TEXT NOT NULL,                 -- JSON 数组: ["https://app.com/callback"]
  scopes        TEXT NOT NULL DEFAULT 'profile', -- 允许的 scope, 逗号分隔
  grant_types   TEXT NOT NULL DEFAULT 'authorization_code,refresh_token',
  owner_id      INTEGER NOT NULL,              -- 创建者 user id
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_clients_owner ON oauth_clients(owner_id);
CREATE INDEX IF NOT EXISTS idx_oauth_clients_cid ON oauth_clients(client_id);

-- 2. 授权码
CREATE TABLE IF NOT EXISTS oauth_codes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL UNIQUE,          -- 随机 48 hex
  client_id     TEXT NOT NULL,
  user_id       INTEGER NOT NULL,
  redirect_uri  TEXT NOT NULL,
  scopes        TEXT NOT NULL,
  code_challenge        TEXT,                  -- PKCE: S256 challenge
  code_challenge_method TEXT,                  -- 'S256'
  expires_at    INTEGER NOT NULL,              -- 10 分钟
  used          INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_codes_code ON oauth_codes(code);

-- 3. 访问令牌 + 刷新令牌（合一表）
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  access_token  TEXT NOT NULL UNIQUE,          -- 随机 48 hex
  refresh_token TEXT UNIQUE,                   -- 随机 48 hex, 可为空
  client_id     TEXT NOT NULL,
  user_id       INTEGER NOT NULL,
  scopes        TEXT NOT NULL,
  access_expires_at  INTEGER NOT NULL,         -- 1 小时
  refresh_expires_at INTEGER,                  -- 30 天
  revoked       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_at ON oauth_tokens(access_token);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_rt ON oauth_tokens(refresh_token);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON oauth_tokens(user_id, client_id);
