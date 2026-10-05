-- Isolated private album storage; never changes media_uploads or existing post assets.
-- Replay-safe and also included verbatim in the fresh-database schema tail.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS albums (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  visibility TEXT NOT NULL CHECK(visibility IN ('public','private','shared')),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER,
  UNIQUE(id,owner_id),
  CHECK(is_default=0 OR (name='宝宝相册' AND visibility='private' AND deleted_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS albums_one_default ON albums(owner_id) WHERE is_default=1;
CREATE INDEX IF NOT EXISTS albums_owner_list ON albums(owner_id,deleted_at,created_at DESC,id);
CREATE TABLE IF NOT EXISTS album_storage (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  used_bytes INTEGER NOT NULL DEFAULT 0 CHECK(used_bytes>=0),
  reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0)
);
CREATE TABLE IF NOT EXISTS album_members (
  album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(album_id,user_id)
);
CREATE TABLE IF NOT EXISTS album_invites (
  album_id TEXT PRIMARY KEY REFERENCES albums(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS album_batches (
  id TEXT PRIMARY KEY NOT NULL,
  album_id TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '' CHECK(length(description)<=3000),
  captured_at INTEGER,
  quality TEXT NOT NULL CHECK(quality IN ('hd','original')),
  photo_count INTEGER NOT NULL CHECK(photo_count BETWEEN 1 AND 20),
  reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes>0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','published','cancelled')),
  post_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
  source_post_image_id INTEGER,
  source_upload_id TEXT,
  uploaded_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  published_at INTEGER,
  UNIQUE(owner_id,operation_id),
  UNIQUE(id,album_id,owner_id),
  FOREIGN KEY(album_id,owner_id) REFERENCES albums(id,owner_id)
);
CREATE INDEX IF NOT EXISTS album_batches_owner_pending ON album_batches(owner_id,status,expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS album_history_active_reservation ON album_batches(source_post_image_id) WHERE source_post_image_id IS NOT NULL AND status!='cancelled';
CREATE TABLE IF NOT EXISTS album_uploads (
  id TEXT PRIMARY KEY NOT NULL,
  batch_id TEXT NOT NULL,
  album_id TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  photo_id TEXT NOT NULL,
  client_id TEXT NOT NULL CHECK(length(client_id) BETWEEN 1 AND 80),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order BETWEEN 0 AND 19),
  kind TEXT NOT NULL CHECK(kind IN ('preview','hd','original')),
  object_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL CHECK(mime_type IN ('image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif')),
  declared_size INTEGER NOT NULL CHECK(declared_size>0),
  content_md5 TEXT NOT NULL,
  width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 100000),
  height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 100000),
  variant_width INTEGER CHECK(variant_width BETWEEN 1 AND 100000),
  variant_height INTEGER CHECK(variant_height BETWEEN 1 AND 100000),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','complete')),
  verified_size INTEGER,
  expires_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE(batch_id,client_id,kind),
  UNIQUE(photo_id,kind),
  FOREIGN KEY(batch_id,album_id,owner_id) REFERENCES album_batches(id,album_id,owner_id),
  CHECK((kind='preview' AND declared_size<=2097152 AND mime_type IN ('image/jpeg','image/webp') AND (variant_width IS NULL OR variant_width<=540) AND (variant_height IS NULL OR variant_height<=540))
     OR (kind='hd' AND declared_size<=10485760 AND mime_type IN ('image/jpeg','image/png','image/webp','image/gif'))
     OR (kind='original' AND declared_size<20971520)),
  CHECK(status!='complete' OR verified_size=declared_size),
  CHECK(object_key GLOB 'albums/'||owner_id||'/*' AND instr(object_key,'..')=0)
);
CREATE INDEX IF NOT EXISTS album_uploads_batch ON album_uploads(batch_id,photo_id,kind);
CREATE TABLE IF NOT EXISTS album_photos (
  id TEXT PRIMARY KEY NOT NULL,
  album_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order BETWEEN 0 AND 19),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description)<=3000),
  captured_at INTEGER,
  uploaded_at INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  preview_key TEXT NOT NULL UNIQUE,
  hd_key TEXT NOT NULL UNIQUE,
  original_key TEXT UNIQUE,
  preview_bytes INTEGER NOT NULL CHECK(preview_bytes>0),
  hd_bytes INTEGER NOT NULL CHECK(hd_bytes>0),
  original_bytes INTEGER NOT NULL DEFAULT 0 CHECK(original_bytes>=0),
  source_post_image_id INTEGER UNIQUE,
  source_upload_id TEXT,
  deleted_at INTEGER,
  FOREIGN KEY(batch_id,album_id,owner_id) REFERENCES album_batches(id,album_id,owner_id),
  CHECK(preview_key!=hd_key AND (original_key IS NULL OR (original_key!=preview_key AND original_key!=hd_key))),
  CHECK((original_key IS NULL AND original_bytes=0) OR (original_key IS NOT NULL AND original_bytes>0))
);
CREATE INDEX IF NOT EXISTS album_photos_sort ON album_photos(album_id,deleted_at,coalesce(captured_at,uploaded_at) DESC,uploaded_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS album_likes (
  photo_id TEXT NOT NULL REFERENCES album_photos(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(photo_id,user_id)
);
CREATE TABLE IF NOT EXISTS album_comments (
  id TEXT PRIMARY KEY NOT NULL,
  photo_id TEXT NOT NULL REFERENCES album_photos(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 2000),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER,
  UNIQUE(user_id,operation_id)
);
CREATE INDEX IF NOT EXISTS album_comments_photo ON album_comments(photo_id,deleted_at,created_at,id);
-- No source FK: deleting the old post must not delete a private imported copy or retry evidence.
CREATE TABLE IF NOT EXISTS album_history_attempts (
  owner_id INTEGER NOT NULL,
  source_post_image_id INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('skipped','retry')),
  reason TEXT NOT NULL,
  retry_at INTEGER NOT NULL,
  attempted_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id,source_post_image_id)
);
CREATE TABLE IF NOT EXISTS album_rate_limits (
  bucket TEXT PRIMARY KEY NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK(count>=0)
);
CREATE TABLE IF NOT EXISTS album_transaction_guards (id INTEGER PRIMARY KEY CHECK(id=1));
-- Bytes are released only after a successful fixed-host COS DELETE (including 404).
CREATE TABLE IF NOT EXISTS album_object_cleanup (
  object_key TEXT PRIMARY KEY NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  bytes INTEGER NOT NULL CHECK(bytes>0),
  charge_bucket TEXT NOT NULL CHECK(charge_bucket IN ('used','reserved')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','cleaned')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  cleaned_at INTEGER
);
CREATE INDEX IF NOT EXISTS album_cleanup_pending ON album_object_cleanup(owner_id,status,created_at);

-- Latest ACTUAL grant/redeem snapshot, never user badges, client plan names, catalog edits
-- or the total accumulated expiry. Active legacy memberships without a snapshot use WEEK
-- (5 GiB), a conservative fallback; inactive memberships always return FREE (3 GiB).
CREATE VIEW IF NOT EXISTS album_storage_entitlements AS
WITH latest AS (
  SELECT u.id AS user_id,m.permanent,m.expires_at,
    (SELECT o.plan_json FROM sponsor_operations o WHERE o.user_id=u.id AND o.kind IN ('grant','redeem') AND json_valid(o.plan_json)
      ORDER BY o.created_at DESC,o.rowid DESC LIMIT 1) AS plan_json
  FROM users u LEFT JOIN sponsor_memberships m ON m.user_id=u.id
), tiers AS (
  SELECT user_id,CASE WHEN permanent=1 OR expires_at>unixepoch() THEN 1 ELSE 0 END AS sponsor_active,
    CASE WHEN permanent=1 THEN 'permanent'
      WHEN coalesce(expires_at,0)<=unixepoch() THEN 'free'
      WHEN (json_extract(plan_json,'$.duration_unit')='month' AND json_extract(plan_json,'$.duration_count')>=12)
        OR (json_extract(plan_json,'$.duration_unit')='day' AND json_extract(plan_json,'$.duration_count')>=365) THEN 'year'
      WHEN (json_extract(plan_json,'$.duration_unit')='month' AND json_extract(plan_json,'$.duration_count')>=3)
        OR (json_extract(plan_json,'$.duration_unit')='day' AND json_extract(plan_json,'$.duration_count')>=90) THEN 'quarter'
      WHEN (json_extract(plan_json,'$.duration_unit')='month' AND json_extract(plan_json,'$.duration_count')>=1)
        OR (json_extract(plan_json,'$.duration_unit')='day' AND json_extract(plan_json,'$.duration_count')>=30) THEN 'month'
      ELSE 'week' END AS tier FROM latest
)
SELECT t.user_id,t.tier,t.sponsor_active,
  (CASE tier WHEN 'permanent' THEN 100 WHEN 'year' THEN 50 WHEN 'quarter' THEN 20 WHEN 'month' THEN 10 WHEN 'week' THEN 5 ELSE 3 END)*1073741824 AS limit_bytes,
  coalesce(s.used_bytes,0) AS used_bytes,coalesce(s.reserved_bytes,0) AS reserved_bytes
FROM tiers t LEFT JOIN album_storage s ON s.user_id=t.user_id;

CREATE TRIGGER IF NOT EXISTS album_default_immutable BEFORE UPDATE ON albums
WHEN OLD.is_default=1 AND (NEW.is_default!=1 OR NEW.owner_id!=OLD.owner_id OR NEW.name!='宝宝相册' OR NEW.visibility!='private' OR NEW.deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'default_album_immutable'); END;
CREATE TRIGGER IF NOT EXISTS album_owner_immutable BEFORE UPDATE OF owner_id,is_default ON albums
WHEN NEW.owner_id!=OLD.owner_id OR NEW.is_default!=OLD.is_default
BEGIN SELECT RAISE(ABORT,'album_owner_immutable'); END;
CREATE TRIGGER IF NOT EXISTS album_default_no_delete BEFORE DELETE ON albums WHEN OLD.is_default=1
BEGIN SELECT RAISE(ABORT,'default_album_immutable'); END;
CREATE TRIGGER IF NOT EXISTS album_batch_reserve_validate BEFORE INSERT ON album_batches
WHEN NOT EXISTS(SELECT 1 FROM album_batches WHERE owner_id=NEW.owner_id AND operation_id=NEW.operation_id)
BEGIN
  SELECT CASE WHEN NEW.status!='pending' THEN RAISE(ABORT,'album_batch_invalid') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM albums a JOIN users u ON u.id=a.owner_id WHERE a.id=NEW.album_id AND a.owner_id=NEW.owner_id AND a.deleted_at IS NULL) THEN RAISE(ABORT,'album_forbidden') END;
  SELECT CASE WHEN NEW.expires_at<=unixepoch() THEN RAISE(ABORT,'album_batch_expired') END;
  SELECT CASE WHEN (SELECT count(*) FROM album_batches WHERE owner_id=NEW.owner_id AND status='pending' AND expires_at>unixepoch())>=5 THEN RAISE(ABORT,'album_pending_limit') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM album_storage_entitlements WHERE user_id=NEW.owner_id AND used_bytes+reserved_bytes+NEW.reserved_bytes<=limit_bytes) THEN RAISE(ABORT,'album_storage_full') END;
  SELECT CASE WHEN NEW.quality='original' AND NOT EXISTS(SELECT 1 FROM album_storage_entitlements WHERE user_id=NEW.owner_id AND sponsor_active=1) THEN RAISE(ABORT,'album_sponsor_required') END;
END;
CREATE TRIGGER IF NOT EXISTS album_batch_reserve_apply AFTER INSERT ON album_batches
BEGIN
  INSERT INTO album_storage(user_id,reserved_bytes) VALUES(NEW.owner_id,NEW.reserved_bytes)
    ON CONFLICT(user_id) DO UPDATE SET reserved_bytes=reserved_bytes+NEW.reserved_bytes;
END;
CREATE TRIGGER IF NOT EXISTS album_upload_insert_validate BEFORE INSERT ON album_uploads
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM album_batches WHERE id=NEW.batch_id AND album_id=NEW.album_id AND owner_id=NEW.owner_id AND status='pending' AND expires_at>unixepoch()) THEN RAISE(ABORT,'album_batch_expired') END;
  SELECT CASE WHEN NEW.kind='original' AND NOT EXISTS(SELECT 1 FROM album_batches WHERE id=NEW.batch_id AND quality='original') THEN RAISE(ABORT,'album_batch_invalid') END;
END;
CREATE TRIGGER IF NOT EXISTS album_upload_complete_validate BEFORE UPDATE OF status ON album_uploads
WHEN NEW.status='complete' AND OLD.status!='complete'
BEGIN
  SELECT CASE WHEN NEW.verified_size IS NULL OR NEW.verified_size!=OLD.declared_size THEN RAISE(ABORT,'album_upload_mismatch') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM album_batches b JOIN albums a ON a.id=b.album_id AND a.owner_id=b.owner_id WHERE b.id=OLD.batch_id AND b.owner_id=OLD.owner_id AND b.status='pending' AND b.expires_at>unixepoch() AND a.deleted_at IS NULL AND OLD.expires_at>unixepoch()) THEN RAISE(ABORT,'album_batch_expired') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM album_batches WHERE id=OLD.batch_id AND quality='original') AND NOT EXISTS(SELECT 1 FROM album_storage_entitlements WHERE user_id=OLD.owner_id AND sponsor_active=1) THEN RAISE(ABORT,'album_sponsor_required') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM album_storage_entitlements WHERE user_id=OLD.owner_id AND used_bytes+reserved_bytes<=limit_bytes) THEN RAISE(ABORT,'album_storage_full') END;
END;
CREATE TRIGGER IF NOT EXISTS album_batch_publish_validate BEFORE UPDATE OF status ON album_batches
WHEN NEW.status='published' AND OLD.status!='published'
BEGIN
  SELECT CASE WHEN OLD.status!='pending' OR OLD.expires_at<=unixepoch() THEN RAISE(ABORT,'album_batch_expired') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM albums WHERE id=OLD.album_id AND owner_id=OLD.owner_id AND deleted_at IS NULL) THEN RAISE(ABORT,'album_forbidden') END;
  SELECT CASE WHEN OLD.quality='original' AND NOT EXISTS(SELECT 1 FROM album_storage_entitlements WHERE user_id=OLD.owner_id AND sponsor_active=1) THEN RAISE(ABORT,'album_sponsor_required') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM album_storage_entitlements WHERE user_id=OLD.owner_id AND used_bytes+reserved_bytes<=limit_bytes AND reserved_bytes>=OLD.reserved_bytes) THEN RAISE(ABORT,'album_storage_full') END;
  SELECT CASE WHEN (SELECT count(*) FROM album_uploads WHERE batch_id=OLD.id)!=(OLD.photo_count*CASE OLD.quality WHEN 'original' THEN 3 ELSE 2 END)
    OR (SELECT count(DISTINCT photo_id) FROM album_uploads WHERE batch_id=OLD.id)!=OLD.photo_count
    OR EXISTS(SELECT 1 FROM album_uploads WHERE batch_id=OLD.id AND (status!='complete' OR verified_size IS NULL OR verified_size!=declared_size))
    OR (SELECT sum(verified_size) FROM album_uploads WHERE batch_id=OLD.id)!=OLD.reserved_bytes
    OR EXISTS(SELECT 1 FROM album_uploads WHERE batch_id=OLD.id GROUP BY photo_id HAVING count(DISTINCT client_id)!=1 OR count(DISTINCT width)!=1 OR count(DISTINCT height)!=1 OR count(DISTINCT kind)!=(CASE OLD.quality WHEN 'original' THEN 3 ELSE 2 END))
    THEN RAISE(ABORT,'album_batch_incomplete') END;
END;
CREATE TRIGGER IF NOT EXISTS album_batch_publish_apply AFTER UPDATE OF status ON album_batches
WHEN NEW.status='published' AND OLD.status='pending'
BEGIN
  INSERT INTO album_photos(id,album_id,batch_id,owner_id,client_id,sort_order,description,captured_at,uploaded_at,width,height,preview_key,hd_key,original_key,preview_bytes,hd_bytes,original_bytes,source_post_image_id,source_upload_id)
    SELECT photo_id,NEW.album_id,NEW.id,NEW.owner_id,min(client_id),min(sort_order),NEW.description,NEW.captured_at,coalesce(NEW.uploaded_at,unixepoch()),min(width),min(height),
      max(CASE kind WHEN 'preview' THEN object_key END),max(CASE kind WHEN 'hd' THEN object_key END),max(CASE kind WHEN 'original' THEN object_key END),
      sum(CASE kind WHEN 'preview' THEN verified_size ELSE 0 END),sum(CASE kind WHEN 'hd' THEN verified_size ELSE 0 END),sum(CASE kind WHEN 'original' THEN verified_size ELSE 0 END),NEW.source_post_image_id,NEW.source_upload_id
    FROM album_uploads WHERE batch_id=NEW.id GROUP BY photo_id;
  UPDATE album_storage SET used_bytes=used_bytes+NEW.reserved_bytes,reserved_bytes=reserved_bytes-NEW.reserved_bytes WHERE user_id=NEW.owner_id;
  -- Public publication is an ORDINARY fallback post. Never insert post_images or metadata content.
  INSERT INTO posts(user_id,content,visibility)
    SELECT NEW.owner_id,'【宝宝相册】当前渠道不支持查看此内容，请下载最新版ABDL Space APP查看详情','public'
      FROM albums WHERE id=NEW.album_id AND visibility='public' AND deleted_at IS NULL;
  UPDATE album_batches SET post_id=CASE WHEN (SELECT visibility FROM albums WHERE id=NEW.album_id)='public' THEN last_insert_rowid() ELSE NULL END,published_at=unixepoch() WHERE id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS album_batch_cancel_apply AFTER UPDATE OF status ON album_batches
WHEN NEW.status='cancelled' AND OLD.status='pending'
BEGIN
  INSERT OR IGNORE INTO album_object_cleanup(object_key,owner_id,bytes,charge_bucket)
    SELECT object_key,owner_id,declared_size,'reserved' FROM album_uploads WHERE batch_id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS album_photo_delete_apply AFTER UPDATE OF deleted_at ON album_photos
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO album_object_cleanup(object_key,owner_id,bytes,charge_bucket) VALUES(OLD.preview_key,OLD.owner_id,OLD.preview_bytes,'used');
  INSERT OR IGNORE INTO album_object_cleanup(object_key,owner_id,bytes,charge_bucket) VALUES(OLD.hd_key,OLD.owner_id,OLD.hd_bytes,'used');
  INSERT OR IGNORE INTO album_object_cleanup(object_key,owner_id,bytes,charge_bucket)
    SELECT OLD.original_key,OLD.owner_id,OLD.original_bytes,'used' WHERE OLD.original_key IS NOT NULL;
END;
CREATE TRIGGER IF NOT EXISTS album_delete_apply AFTER UPDATE OF deleted_at ON albums
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
BEGIN
  UPDATE album_photos SET deleted_at=NEW.deleted_at WHERE album_id=NEW.id AND deleted_at IS NULL;
  UPDATE album_batches SET status='cancelled' WHERE album_id=NEW.id AND status='pending';
  DELETE FROM album_invites WHERE album_id=NEW.id;
  DELETE FROM album_members WHERE album_id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS album_cleanup_release AFTER UPDATE OF status ON album_object_cleanup
WHEN OLD.status='pending' AND NEW.status='cleaned'
BEGIN
  UPDATE album_storage SET used_bytes=used_bytes-CASE NEW.charge_bucket WHEN 'used' THEN NEW.bytes ELSE 0 END,
    reserved_bytes=reserved_bytes-CASE NEW.charge_bucket WHEN 'reserved' THEN NEW.bytes ELSE 0 END WHERE user_id=NEW.owner_id;
END;
CREATE TRIGGER IF NOT EXISTS album_visibility_revoke AFTER UPDATE OF visibility ON albums
WHEN NEW.visibility!='shared'
BEGIN DELETE FROM album_invites WHERE album_id=NEW.id; DELETE FROM album_members WHERE album_id=NEW.id; END;
