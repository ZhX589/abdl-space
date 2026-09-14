-- 0065: 宝宝认证首版。QQ 与照片证据均为严格私密数据。
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS baby_verification_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL CHECK (version > 0),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  declaration_version TEXT NOT NULL,
  free_monthly_limit INTEGER NOT NULL DEFAULT 2 CHECK (free_monthly_limit BETWEEN 0 AND 20),
  sponsor_monthly_limit INTEGER NOT NULL DEFAULT 3 CHECK (sponsor_monthly_limit BETWEEN free_monthly_limit AND 20),
  capture_ttl_seconds INTEGER NOT NULL DEFAULT 900 CHECK (capture_ttl_seconds BETWEEN 300 AND 3600),
  upload_ttl_seconds INTEGER NOT NULL DEFAULT 300 CHECK (upload_ttl_seconds BETWEEN 60 AND 900),
  max_evidence_size INTEGER NOT NULL DEFAULT 5242880 CHECK (max_evidence_size BETWEEN 1024 AND 8388608),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT OR IGNORE INTO baby_verification_settings(id,version,enabled,declaration_version)
VALUES(1,1,0,'2026-09-13');

CREATE TABLE IF NOT EXISTS baby_verification_capture_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('active','completed','expired','cancelled')),
  nonce TEXT NOT NULL,
  instructions_version INTEGER NOT NULL,
  paper_shape TEXT NOT NULL,
  paper_color TEXT NOT NULL,
  fold_instruction TEXT NOT NULL,
  placement_instruction TEXT NOT NULL,
  random_text TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  completed_at INTEGER,
  cancelled_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(id,user_id),
  CHECK ((status='active' AND completed_at IS NULL AND cancelled_at IS NULL)
    OR (status='completed' AND completed_at IS NOT NULL AND cancelled_at IS NULL)
    OR (status IN ('expired','cancelled') AND completed_at IS NULL AND cancelled_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_baby_capture_user_active ON baby_verification_capture_sessions(user_id,status,expires_at);

CREATE TABLE IF NOT EXISTS baby_verification_applications (
  id TEXT PRIMARY KEY NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capture_session_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('draft','submitted','reviewing','approved','rejected','cancelled')),
  qq TEXT NOT NULL CHECK (length(qq) BETWEEN 32 AND 1024),
  adult_declaration INTEGER NOT NULL CHECK (adult_declaration = 1),
  declaration_version TEXT NOT NULL,
  declared_at INTEGER NOT NULL,
  submitted_at INTEGER,
  claimed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  claimed_at INTEGER,
  decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at INTEGER,
  decision_note TEXT NOT NULL DEFAULT '',
  rejection_acknowledged_at INTEGER,
  cancelled_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(id,user_id),
  FOREIGN KEY(capture_session_id,user_id) REFERENCES baby_verification_capture_sessions(id,user_id),
  CHECK ((status='draft' AND submitted_at IS NULL AND decided_at IS NULL AND cancelled_at IS NULL)
    OR (status IN ('submitted','reviewing') AND submitted_at IS NOT NULL AND decided_at IS NULL AND cancelled_at IS NULL)
    OR (status IN ('approved','rejected') AND submitted_at IS NOT NULL AND decided_at IS NOT NULL AND decided_by IS NOT NULL AND cancelled_at IS NULL)
    OR (status='cancelled' AND cancelled_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_baby_application_one_open ON baby_verification_applications(user_id)
  WHERE status IN ('submitted','reviewing');
CREATE INDEX IF NOT EXISTS idx_baby_application_admin_queue ON baby_verification_applications(status,submitted_at,id);
CREATE INDEX IF NOT EXISTS idx_baby_application_user_history ON baby_verification_applications(user_id,created_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS baby_verification_evidence (
  id TEXT PRIMARY KEY NOT NULL,
  application_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('capture_photo','supporting_photo')),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp')),
  object_key TEXT NOT NULL UNIQUE,
  declared_size INTEGER NOT NULL CHECK (declared_size > 0 AND declared_size <= 8388608),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  content_md5 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','verifying','ready','failed')),
  upload_expires_at INTEGER NOT NULL,
  verification_token TEXT,
  verification_started_at INTEGER,
  verified_size INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY(application_id,user_id) REFERENCES baby_verification_applications(id,user_id),
  CHECK ((status='verifying' AND verification_token IS NOT NULL AND verification_started_at IS NOT NULL)
    OR (status!='verifying' AND verification_token IS NULL AND verification_started_at IS NULL)),
  CHECK ((status='ready' AND verified_size IS NOT NULL AND completed_at IS NOT NULL) OR status!='ready')
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_baby_evidence_application_kind ON baby_verification_evidence(application_id,kind);
CREATE INDEX IF NOT EXISTS idx_baby_evidence_pending ON baby_verification_evidence(status,upload_expires_at,verification_started_at);

CREATE TABLE IF NOT EXISTS baby_verification_certificates (
  id TEXT PRIMARY KEY NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL UNIQUE REFERENCES baby_verification_applications(id),
  status TEXT NOT NULL CHECK (status IN ('active','revoked')),
  issued_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  revoke_reason TEXT,
  current_credential_id TEXT,
  credential_generation INTEGER NOT NULL DEFAULT 1 CHECK (credential_generation > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK ((status='active' AND revoked_at IS NULL) OR (status='revoked' AND revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_baby_certificate_active_user ON baby_verification_certificates(user_id) WHERE status='active';

CREATE TABLE IF NOT EXISTS baby_verification_credentials (
  id TEXT PRIMARY KEY NOT NULL,
  certificate_id TEXT NOT NULL REFERENCES baby_verification_certificates(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation > 0),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('active','superseded','revoked')),
  issued_at INTEGER NOT NULL,
  superseded_at INTEGER,
  revoked_at INTEGER,
  UNIQUE(certificate_id,generation)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_baby_credential_active_certificate ON baby_verification_credentials(certificate_id) WHERE status='active';

CREATE TABLE IF NOT EXISTS baby_verification_badge_sources (
  certificate_id TEXT PRIMARY KEY NOT NULL REFERENCES baby_verification_certificates(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_key TEXT NOT NULL DEFAULT 'verified',
  preserved_existing_badge INTEGER NOT NULL DEFAULT 0 CHECK (preserved_existing_badge IN (0,1)),
  granted_at INTEGER NOT NULL DEFAULT (unixepoch()),
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_baby_badge_source_user ON baby_verification_badge_sources(user_id,badge_key,revoked_at);

CREATE TABLE IF NOT EXISTS baby_verification_operations (
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(actor_id,operation_id)
);
CREATE INDEX IF NOT EXISTS idx_baby_operations_target ON baby_verification_operations(target_id,created_at DESC);

CREATE TABLE IF NOT EXISTS baby_verification_transaction_guards (
  id INTEGER PRIMARY KEY CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS baby_verification_audit (
  id TEXT PRIMARY KEY NOT NULL,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  application_id TEXT,
  action TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_baby_audit_recent ON baby_verification_audit(created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_baby_audit_application ON baby_verification_audit(application_id,created_at DESC);

CREATE TABLE IF NOT EXISTS baby_verification_rate_limits (
  bucket TEXT PRIMARY KEY NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0)
);

CREATE TABLE IF NOT EXISTS baby_verification_notification_details (
  notification_id INTEGER PRIMARY KEY NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL,
  target_path TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_baby_notification_application ON baby_verification_notification_details(application_id,notification_id);

UPDATE badges SET name='宝宝认证', description='用户已通过平台宝宝认证。', icon='verified'
WHERE key='verified';
INSERT OR IGNORE INTO badges(key,name,icon,description,condition_type,condition_value)
VALUES('verified','宝宝认证','verified','用户已通过平台宝宝认证。','manual',0);
