CREATE TABLE private_books (
  id TEXT NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  format TEXT NOT NULL,
  object_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_md5 TEXT NOT NULL,
  declared_size INTEGER NOT NULL CHECK (declared_size > 0),
  verified_size INTEGER CHECK (verified_size IS NULL OR verified_size >= 0),
  parse_status TEXT NOT NULL DEFAULT 'pending' CHECK (parse_status IN ('pending', 'parsing', 'ready', 'failed')),
  upload_expires_at INTEGER NOT NULL,
  verification_started_at INTEGER,
  cleanup_status TEXT NOT NULL DEFAULT 'pending' CHECK (cleanup_status IN ('pending', 'deleting', 'done', 'failed')),
  cleanup_attempted_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER,
  PRIMARY KEY (owner_id, id),
  UNIQUE (owner_id, object_key)
);

CREATE TABLE novel_object_cleanup_jobs (
  object_key TEXT PRIMARY KEY NOT NULL,
  not_before INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'failed', 'done')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER NOT NULL,
  claim_token TEXT,
  attempted_at INTEGER,
  last_error_status INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_novel_object_cleanup_jobs_due
  ON novel_object_cleanup_jobs(status, next_attempt_at, attempted_at, object_key);

CREATE TRIGGER private_books_cleanup_before_delete
BEFORE DELETE ON private_books
BEGIN
  INSERT INTO novel_object_cleanup_jobs (object_key, not_before, status, next_attempt_at)
  VALUES (OLD.object_key, OLD.upload_expires_at + 900, 'pending', OLD.upload_expires_at + 900)
  ON CONFLICT(object_key) DO UPDATE SET
    not_before = MAX(novel_object_cleanup_jobs.not_before, excluded.not_before),
    status = 'pending',
    next_attempt_at = MAX(novel_object_cleanup_jobs.not_before, excluded.not_before),
    claim_token = NULL,
    updated_at = unixepoch();
END;

CREATE TRIGGER private_books_cleanup_after_soft_delete
AFTER UPDATE OF deleted_at ON private_books
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
BEGIN
  INSERT INTO novel_object_cleanup_jobs (object_key, not_before, status, next_attempt_at)
  VALUES (NEW.object_key, NEW.upload_expires_at + 900, 'pending', NEW.upload_expires_at + 900)
  ON CONFLICT(object_key) DO UPDATE SET
    not_before = MAX(novel_object_cleanup_jobs.not_before, excluded.not_before),
    status = 'pending',
    next_attempt_at = MAX(novel_object_cleanup_jobs.not_before, excluded.not_before),
    claim_token = NULL,
    updated_at = unixepoch();
END;

CREATE UNIQUE INDEX idx_private_books_owner_content_hash
  ON private_books(owner_id, content_hash)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_private_books_owner_created
  ON private_books(owner_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE novel_sync_items (
  book_id TEXT NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (item_type IN ('progress', 'bookmark', 'note')),
  item_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  client_updated_at INTEGER NOT NULL,
  server_updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (owner_id, item_type, item_id),
  FOREIGN KEY (owner_id, book_id) REFERENCES private_books(owner_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_novel_sync_items_owner_book_updated
  ON novel_sync_items(owner_id, book_id, server_updated_at);

CREATE TABLE novel_sync_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('progress', 'bookmark', 'note')),
  item_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  client_updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (owner_id, book_id) REFERENCES private_books(owner_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_novel_sync_changes_owner_seq ON novel_sync_changes(owner_id, seq);

CREATE TRIGGER novel_sync_items_change_insert
AFTER INSERT ON novel_sync_items
BEGIN
  INSERT INTO novel_sync_changes (owner_id, book_id, item_type, item_id, payload_json, client_updated_at, deleted_at)
  VALUES (NEW.owner_id, NEW.book_id, NEW.item_type, NEW.item_id, NEW.payload_json, NEW.client_updated_at, NEW.deleted_at);
END;

CREATE TRIGGER novel_sync_items_change_update
AFTER UPDATE ON novel_sync_items
BEGIN
  INSERT INTO novel_sync_changes (owner_id, book_id, item_type, item_id, payload_json, client_updated_at, deleted_at)
  VALUES (NEW.owner_id, NEW.book_id, NEW.item_type, NEW.item_id, NEW.payload_json, NEW.client_updated_at, NEW.deleted_at);
END;
