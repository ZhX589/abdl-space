-- Additive album protection storage; keep replay-safe migration 0071 unchanged.
-- A missing row is unprotected; a missing table is feature unavailability, never false.
CREATE TABLE IF NOT EXISTS album_protection (
  album_id TEXT PRIMARY KEY REFERENCES albums(id) ON DELETE CASCADE,
  download_protected INTEGER NOT NULL DEFAULT 0 CHECK(download_protected IN (0,1))
);

-- Attempt-bound authorization ledger. Retains original sponsor operations and audited
-- compensations; pending retries cannot obtain a URL or refund a completed authorization.
CREATE TABLE IF NOT EXISTS album_photo_authorizations (
  operation_id TEXT PRIMARY KEY REFERENCES sponsor_operations(id),
  attempt_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  media_key TEXT NOT NULL,
  day_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','authorized','refunded')),
  failure_code TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  finalized_at INTEGER
);
CREATE TRIGGER IF NOT EXISTS album_photo_authorization_validate BEFORE INSERT ON album_photo_authorizations
BEGIN
  SELECT CASE WHEN NEW.status!='pending' OR NOT EXISTS(SELECT 1 FROM sponsor_operations o
    WHERE o.id=NEW.operation_id AND o.kind='original' AND o.user_id=NEW.user_id
    AND o.actor_id=CAST(NEW.user_id AS TEXT) AND o.media_key=NEW.media_key AND o.day_key=NEW.day_key
    AND o.day_key=date('now','+8 hours')) THEN RAISE(ABORT,'album_authorization_invalid') END;
END;
CREATE TRIGGER IF NOT EXISTS album_photo_authorization_transition BEFORE UPDATE ON album_photo_authorizations
BEGIN
  SELECT CASE WHEN NEW.operation_id!=OLD.operation_id OR NEW.attempt_id!=OLD.attempt_id
    OR NEW.user_id!=OLD.user_id OR NEW.media_key!=OLD.media_key OR NEW.day_key!=OLD.day_key
    OR OLD.status!='pending' OR NEW.status NOT IN ('authorized','refunded')
    OR NEW.finalized_at IS NULL THEN RAISE(ABORT,'album_authorization_invalid') END;
  SELECT CASE WHEN NEW.status='refunded' AND (NEW.failure_code IS NULL OR NOT EXISTS(
    SELECT 1 FROM sponsor_operations o JOIN sponsor_daily_usage usage ON usage.user_id=o.user_id AND usage.day_key=o.day_key
    WHERE o.id=OLD.operation_id AND o.kind='original' AND o.user_id=OLD.user_id
      AND o.actor_id=CAST(OLD.user_id AS TEXT) AND o.media_key=OLD.media_key AND o.day_key=OLD.day_key AND usage.used>=1))
    THEN RAISE(ABORT,'album_authorization_invalid') END;
END;
CREATE TRIGGER IF NOT EXISTS album_photo_authorization_refund AFTER UPDATE OF status ON album_photo_authorizations
WHEN OLD.status='pending' AND NEW.status='refunded'
BEGIN
  -- Refund only the operation's charged Shanghai day, never unrelated current-day usage.
  UPDATE sponsor_daily_usage SET used=used-1 WHERE user_id=OLD.user_id AND day_key=OLD.day_key AND used>=1;
END;
