-- Additive album report moderation storage; keep replay-safe migrations 0071/0072 unchanged.
-- A missing table is feature unavailability (503), never an empty moderation state.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS album_reports (
  id TEXT PRIMARY KEY NOT NULL,
  album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK(reason IN ('spam','nsfw','minor','copyright','other')),
  detail TEXT CHECK(detail IS NULL OR length(detail)<=2000),
  operation_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  resolved_at INTEGER,
  resolved_by INTEGER REFERENCES users(id),
  CHECK(status!='resolved' OR (resolved_at IS NOT NULL AND resolved_by IS NOT NULL))
);
-- At most one open report per reporter and album; resolved reports never block a fresh one.
CREATE UNIQUE INDEX IF NOT EXISTS album_reports_one_open ON album_reports(album_id,reporter_id) WHERE status='open';
CREATE INDEX IF NOT EXISTS album_reports_status_list ON album_reports(status,created_at DESC,id);
CREATE INDEX IF NOT EXISTS album_reports_album ON album_reports(album_id,reporter_id);

-- Admin violation blocks are a desired-state overlay: photos stay stored, only display is replaced.
CREATE TABLE IF NOT EXISTS album_photo_blocks (
  album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  photo_id TEXT NOT NULL REFERENCES album_photos(id) ON DELETE CASCADE,
  blocked_at INTEGER NOT NULL DEFAULT (unixepoch()),
  admin_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY(album_id,photo_id)
);
CREATE INDEX IF NOT EXISTS album_photo_blocks_admin ON album_photo_blocks(admin_id,blocked_at);
