CREATE TABLE media_uploads (
  id TEXT PRIMARY KEY NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('status_original', 'status_preview', 'avatar', 'header', 'generic', 'release')),
  object_key TEXT NOT NULL UNIQUE,
  public_url TEXT NOT NULL,
  preview_upload_id TEXT REFERENCES media_uploads(id),
  preview_object_key TEXT,
  preview_url TEXT,
  mime_type TEXT NOT NULL,
  declared_size INTEGER NOT NULL CHECK (declared_size > 0),
  verified_size INTEGER CHECK (verified_size IS NULL OR verified_size >= 0),
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  blurhash TEXT,
  storage_provider TEXT NOT NULL CHECK (storage_provider IN ('cos', 'imgbed')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'complete', 'failed')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  CHECK (
    (preview_upload_id IS NULL AND preview_object_key IS NULL AND preview_url IS NULL)
    OR (preview_upload_id IS NOT NULL AND preview_object_key IS NOT NULL AND preview_url IS NOT NULL)
  )
);

CREATE INDEX idx_media_uploads_user_status ON media_uploads(user_id, status);
CREATE INDEX idx_media_uploads_pending_expiry ON media_uploads(status, expires_at);

ALTER TABLE post_images ADD COLUMN preview_url TEXT;
ALTER TABLE post_images ADD COLUMN storage_provider TEXT CHECK (storage_provider IS NULL OR storage_provider IN ('cos', 'imgbed'));
