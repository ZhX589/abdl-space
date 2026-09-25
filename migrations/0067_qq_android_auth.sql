-- 0067: Android QQ 登录第一阶段。仅持久化带域分隔的 HMAC，不保存原始 UnionID/OpenID/token/code。
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS qq_identities (
  unionid_hmac TEXT PRIMARY KEY NOT NULL CHECK (length(unionid_hmac) = 64),
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  nickname TEXT NOT NULL DEFAULT '' CHECK (length(nickname) <= 100),
  avatar TEXT NOT NULL DEFAULT '' CHECK (length(avatar) <= 2048),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_qq_identities_user ON qq_identities(user_id);

CREATE TABLE IF NOT EXISTS qq_app_subjects (
  app_id TEXT NOT NULL CHECK (length(app_id) BETWEEN 5 AND 32),
  openid_hmac TEXT NOT NULL CHECK (length(openid_hmac) = 64),
  unionid_hmac TEXT NOT NULL CHECK (length(unionid_hmac) = 64),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (app_id, openid_hmac),
  UNIQUE (app_id, unionid_hmac)
);
CREATE INDEX IF NOT EXISTS idx_qq_app_subjects_identity ON qq_app_subjects(unionid_hmac);
