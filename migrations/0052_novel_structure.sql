CREATE TABLE IF NOT EXISTS novel_volumes (
  id TEXT PRIMARY KEY,
  novel_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  idempotency_key TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER,
  FOREIGN KEY (novel_id) REFERENCES novels(id) ON DELETE CASCADE,
  UNIQUE (novel_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_novel_volumes_idempotency
  ON novel_volumes(novel_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_novel_volumes_order
  ON novel_volumes(novel_id, sort_order, id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS novel_chapters (
  id TEXT PRIMARY KEY,
  novel_id TEXT NOT NULL,
  volume_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  idempotency_key TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER,
  FOREIGN KEY (novel_id, volume_id) REFERENCES novel_volumes(novel_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_novel_chapters_idempotency
  ON novel_chapters(volume_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_novel_chapters_order
  ON novel_chapters(volume_id, sort_order, id) WHERE deleted_at IS NULL;
