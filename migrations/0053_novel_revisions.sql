CREATE TABLE IF NOT EXISTS chapter_revisions (
  id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL,
  chapter_id TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(body) <= 500000),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review_pending', 'approved', 'rejected', 'published', 'superseded')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  create_idempotency_key TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (chapter_id) REFERENCES novel_chapters(id) ON DELETE CASCADE,
  UNIQUE (owner_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chapter_revisions_create_idempotency
  ON chapter_revisions(chapter_id, create_idempotency_key) WHERE create_idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chapter_revisions_chapter
  ON chapter_revisions(chapter_id, updated_at DESC, id);

CREATE TABLE IF NOT EXISTS novel_revision_operations (
  owner_id INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  request_body TEXT NOT NULL,
  request_base_version INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  response_chapter_id TEXT NOT NULL,
  response_status TEXT NOT NULL,
  response_version INTEGER NOT NULL,
  response_created_at INTEGER NOT NULL,
  response_updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(owner_id, idempotency_key),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, revision_id) REFERENCES chapter_revisions(owner_id, id) ON DELETE CASCADE
);
