-- A new observation epoch; deliberately no users.has_app backfill.
CREATE TABLE IF NOT EXISTS app_client_measurement (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  measurement_started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT OR IGNORE INTO app_client_measurement(id) VALUES (1);

-- 0 is the normalized missing/malformed sentinel. SQL NULL is not unique in SQLite.
CREATE TABLE IF NOT EXISTS app_client_observations (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version_key INTEGER NOT NULL CHECK (version_key BETWEEN 0 AND 2147483647),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (user_id, version_key)
);
CREATE INDEX IF NOT EXISTS idx_app_client_observations_version_seen
  ON app_client_observations(version_key, last_seen_at DESC, user_id);
CREATE INDEX IF NOT EXISTS idx_app_client_observations_seen
  ON app_client_observations(last_seen_at DESC, user_id);

CREATE TABLE IF NOT EXISTS app_client_latest (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version_key INTEGER NOT NULL CHECK (version_key BETWEEN 0 AND 2147483647),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  FOREIGN KEY (user_id, version_key) REFERENCES app_client_observations(user_id, version_key) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_app_client_latest_seen ON app_client_latest(last_seen_at DESC, user_id);
CREATE INDEX IF NOT EXISTS idx_app_client_latest_version ON app_client_latest(version_key, last_seen_at DESC, user_id);

-- Policy is a single atomic site setting, reserved from the generic settings writer.
CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO site_settings(key, value) VALUES ('app_client_policy',
  '{"enabled":false,"deprecated_version_codes":[],"block_unversioned":false,"update_message":"当前 App 版本已停止支持，请更新到最新版本后继续使用。"}');
