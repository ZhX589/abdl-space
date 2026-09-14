-- Local-first novel authoring v2. Existing authoring/store tables stay compatible.
CREATE TABLE IF NOT EXISTS novel_v2_workspaces (
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_work_id TEXT NOT NULL,
  novel_id TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  manifest_version INTEGER NOT NULL DEFAULT 0 CHECK(manifest_version >= 0),
  pending_sync_id TEXT,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 2000),
  category TEXT NOT NULL CHECK(category IN ('fiction','fantasy','romance','science_fiction','mystery','history','essay','other')),
  declared_rating TEXT NOT NULL DEFAULT 'all_ages' CHECK(declared_rating IN ('all_ages','suggest_12','suggest_15','suggest_18')),
  content_warning TEXT NOT NULL DEFAULT '' CHECK(length(content_warning) <= 500),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(owner_id, client_work_id),
  UNIQUE(owner_id, novel_id)
);
CREATE INDEX IF NOT EXISTS novel_v2_workspaces_recent ON novel_v2_workspaces(owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS novel_v2_sync_staging_volumes (
  owner_id INTEGER NOT NULL,
  client_work_id TEXT NOT NULL,
  sync_id TEXT NOT NULL,
  client_volume_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
  sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
  PRIMARY KEY(owner_id, client_work_id, sync_id, client_volume_id),
  FOREIGN KEY(owner_id, client_work_id) REFERENCES novel_v2_workspaces(owner_id, client_work_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS novel_v2_sync_staging_chapters (
  owner_id INTEGER NOT NULL,
  client_work_id TEXT NOT NULL,
  sync_id TEXT NOT NULL,
  client_chapter_id TEXT NOT NULL,
  client_volume_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
  sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
  generation INTEGER NOT NULL CHECK(generation >= 1),
  body TEXT NOT NULL CHECK(length(body) <= 500000),
  body_sha256 TEXT NOT NULL CHECK(length(body_sha256) = 64),
  PRIMARY KEY(owner_id, client_work_id, sync_id, client_chapter_id),
  FOREIGN KEY(owner_id, client_work_id, sync_id, client_volume_id) REFERENCES novel_v2_sync_staging_volumes(owner_id, client_work_id, sync_id, client_volume_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS novel_v2_volumes (
  owner_id INTEGER NOT NULL,
  client_work_id TEXT NOT NULL,
  client_volume_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
  sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(owner_id, client_work_id, client_volume_id),
  FOREIGN KEY(owner_id, client_work_id) REFERENCES novel_v2_workspaces(owner_id, client_work_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS novel_v2_volumes_order ON novel_v2_volumes(owner_id, client_work_id, sort_order, client_volume_id);

CREATE TABLE IF NOT EXISTS novel_v2_chapters (
  owner_id INTEGER NOT NULL,
  client_work_id TEXT NOT NULL,
  client_chapter_id TEXT NOT NULL,
  client_volume_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
  sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
  generation INTEGER NOT NULL CHECK(generation >= 1),
  body TEXT NOT NULL CHECK(length(body) <= 500000),
  body_sha256 TEXT NOT NULL CHECK(length(body_sha256) = 64),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(owner_id, client_work_id, client_chapter_id),
  FOREIGN KEY(owner_id, client_work_id, client_volume_id) REFERENCES novel_v2_volumes(owner_id, client_work_id, client_volume_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS novel_v2_chapters_order ON novel_v2_chapters(owner_id, client_work_id, client_volume_id, sort_order, client_chapter_id);

CREATE TABLE IF NOT EXISTS novel_v2_sync_operations (
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  client_work_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK(json_valid(response_json)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(owner_id, operation_id)
);
CREATE INDEX IF NOT EXISTS novel_v2_sync_operations_expiry ON novel_v2_sync_operations(created_at);

CREATE TABLE IF NOT EXISTS novel_v2_releases (
  id TEXT PRIMARY KEY,
  novel_id TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_work_id TEXT NOT NULL,
  release_version INTEGER NOT NULL CHECK(release_version >= 1),
  manifest_version INTEGER NOT NULL CHECK(manifest_version >= 1),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  declared_rating TEXT NOT NULL,
  content_warning TEXT NOT NULL,
  published_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(novel_id, release_version)
);
CREATE INDEX IF NOT EXISTS novel_v2_releases_recent ON novel_v2_releases(published_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS novel_v2_release_volumes (
  release_id TEXT NOT NULL REFERENCES novel_v2_releases(id) ON DELETE CASCADE,
  client_volume_id TEXT NOT NULL,
  title TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  PRIMARY KEY(release_id, client_volume_id)
);
CREATE INDEX IF NOT EXISTS novel_v2_release_volumes_order ON novel_v2_release_volumes(release_id, sort_order, client_volume_id);

CREATE TABLE IF NOT EXISTS novel_v2_release_chapters (
  release_id TEXT NOT NULL REFERENCES novel_v2_releases(id) ON DELETE CASCADE,
  client_chapter_id TEXT NOT NULL,
  client_volume_id TEXT NOT NULL,
  title TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  body TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  PRIMARY KEY(release_id, client_chapter_id),
  FOREIGN KEY(release_id, client_volume_id) REFERENCES novel_v2_release_volumes(release_id, client_volume_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS novel_v2_release_chapters_order ON novel_v2_release_chapters(release_id, client_volume_id, sort_order, client_chapter_id);

CREATE TABLE IF NOT EXISTS novel_v2_current_releases (
  novel_id TEXT PRIMARY KEY REFERENCES novels(id) ON DELETE CASCADE,
  release_id TEXT NOT NULL UNIQUE REFERENCES novel_v2_releases(id) ON DELETE CASCADE,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS novel_v2_release_operations (
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  client_work_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK(json_valid(response_json)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(owner_id, operation_id)
);
CREATE INDEX IF NOT EXISTS novel_v2_release_operations_expiry ON novel_v2_release_operations(created_at);

CREATE TRIGGER IF NOT EXISTS novel_v2_workspace_staging_before_new_sync
BEFORE UPDATE OF pending_sync_id ON novel_v2_workspaces
WHEN NEW.pending_sync_id IS NOT NULL AND OLD.pending_sync_id IS NOT NULL AND NEW.pending_sync_id<>OLD.pending_sync_id
BEGIN
  DELETE FROM novel_v2_sync_staging_chapters WHERE owner_id=OLD.owner_id AND client_work_id=OLD.client_work_id;
  DELETE FROM novel_v2_sync_staging_volumes WHERE owner_id=OLD.owner_id AND client_work_id=OLD.client_work_id;
END;
