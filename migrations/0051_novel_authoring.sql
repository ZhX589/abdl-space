CREATE TABLE IF NOT EXISTS novels (
  id TEXT PRIMARY KEY,
  author_id INTEGER NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  category TEXT NOT NULL CHECK (category IN ('fiction', 'fantasy', 'romance', 'science_fiction', 'mystery', 'history', 'essay', 'other')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review_pending', 'published', 'rejected', 'archived')),
  idempotency_key TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER,
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_novels_author_idempotency
  ON novels(author_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_novels_author_updated
  ON novels(author_id, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;
