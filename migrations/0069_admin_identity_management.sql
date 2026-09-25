-- 0069: 管理员身份管理、会话失效边界和原子操作门禁。可安全重复执行。
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS auth_session_state (
  user_id INTEGER PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invalid_before INTEGER NOT NULL CHECK (invalid_before >= 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS admin_identity_operations (
  operation_id TEXT PRIMARY KEY NOT NULL,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  confirmed_username TEXT NOT NULL,
  expected_binding_version INTEGER NOT NULL CHECK (expected_binding_version >= 0),
  response_status INTEGER NOT NULL CHECK (response_status BETWEEN 100 AND 599),
  response_body TEXT NOT NULL CHECK (json_valid(response_body)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_admin_identity_operations_target ON admin_identity_operations(target_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_identity_audit (
  id TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_admin_identity_audit_target ON admin_identity_audit(target_user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_admin_identity_audit_actor ON admin_identity_audit(actor_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS admin_identity_rate_limits (
  bucket TEXT PRIMARY KEY NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0)
);
