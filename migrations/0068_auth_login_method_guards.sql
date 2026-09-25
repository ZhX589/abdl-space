-- 0068: 原子保护最后一种登录方式，避免 QQ 解绑与 Passkey 删除并发导致账户锁死。
PRAGMA foreign_keys = ON;

CREATE TRIGGER IF NOT EXISTS prevent_last_qq_identity_delete
BEFORE DELETE ON qq_identities
WHEN EXISTS (SELECT 1 FROM users WHERE id = OLD.user_id)
  AND NOT EXISTS (
    SELECT 1 FROM users
    WHERE id = OLD.user_id
      AND (
        length(COALESCE(password_hash, '')) > 0
        OR (email IS NOT NULL AND length(email) > 0 AND COALESCE(email_verified, 0) = 1)
        OR length(COALESCE(nbw_uid, '')) > 0
      )
  )
  AND NOT EXISTS (SELECT 1 FROM passkeys WHERE user_id = OLD.user_id)
BEGIN
  SELECT RAISE(ABORT, 'AUTH_LAST_LOGIN_METHOD');
END;

CREATE TRIGGER IF NOT EXISTS prevent_last_passkey_delete
BEFORE DELETE ON passkeys
WHEN EXISTS (SELECT 1 FROM users WHERE id = OLD.user_id)
  AND NOT EXISTS (
    SELECT 1 FROM passkeys
    WHERE user_id = OLD.user_id AND id <> OLD.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM users
    WHERE id = OLD.user_id
      AND (
        length(COALESCE(password_hash, '')) > 0
        OR (email IS NOT NULL AND length(email) > 0 AND COALESCE(email_verified, 0) = 1)
        OR length(COALESCE(nbw_uid, '')) > 0
      )
  )
  AND NOT EXISTS (SELECT 1 FROM qq_identities WHERE user_id = OLD.user_id)
BEGIN
  SELECT RAISE(ABORT, 'AUTH_LAST_LOGIN_METHOD');
END;
