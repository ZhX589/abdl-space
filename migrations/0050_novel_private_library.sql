CREATE TABLE private_books (
  id TEXT NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  format TEXT NOT NULL,
  object_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  declared_size INTEGER NOT NULL CHECK (declared_size > 0),
  verified_size INTEGER CHECK (verified_size IS NULL OR verified_size >= 0),
  parse_status TEXT NOT NULL DEFAULT 'pending' CHECK (parse_status IN ('pending', 'parsing', 'ready', 'failed')),
  upload_expires_at INTEGER NOT NULL,
  verification_started_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER,
  PRIMARY KEY (owner_id, id),
  UNIQUE (owner_id, object_key)
);

CREATE UNIQUE INDEX idx_private_books_owner_content_hash
  ON private_books(owner_id, content_hash)
  WHERE deleted_at IS NULL;

CREATE TABLE novel_sync_items (
  book_id TEXT NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (item_type IN ('progress', 'bookmark', 'note')),
  item_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (owner_id, item_type, item_id),
  FOREIGN KEY (owner_id, book_id) REFERENCES private_books(owner_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_novel_sync_items_owner_book_updated
  ON novel_sync_items(owner_id, book_id, updated_at);
