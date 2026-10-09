PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS merchants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 120),
  avatar_url TEXT CHECK(avatar_url IS NULL OR length(avatar_url) <= 2048),
  website_url TEXT CHECK(website_url IS NULL OR length(website_url) <= 2048),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('pending','active','suspended')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS merchant_registration_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT NOT NULL UNIQUE,
  masked_code TEXT NOT NULL,
  merchant_id INTEGER REFERENCES merchants(id),
  created_by INTEGER REFERENCES users(id),
  consumed_at TEXT,
  consumed_by INTEGER REFERENCES users(id),
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS merchant_registration_codes_state ON merchant_registration_codes(consumed_at, expires_at);

CREATE TABLE IF NOT EXISTS advertising_policies (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  max_per_timeline INTEGER NOT NULL DEFAULT 1 CHECK(max_per_timeline BETWEEN 0 AND 1),
  min_interval_seconds INTEGER NOT NULL DEFAULT 8 CHECK(min_interval_seconds BETWEEN 0 AND 86400),
  ad_probability INTEGER NOT NULL DEFAULT 20 CHECK(ad_probability BETWEEN 0 AND 100),
  fallback_probability INTEGER NOT NULL DEFAULT 5 CHECK(fallback_probability BETWEEN 0 AND 100),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by INTEGER REFERENCES users(id)
);
INSERT OR IGNORE INTO advertising_policies(id) VALUES (1);

CREATE TABLE IF NOT EXISTS advertisements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  ad_type TEXT NOT NULL DEFAULT 'merchant' CHECK(ad_type IN ('merchant','official','system')),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
  body TEXT NOT NULL DEFAULT '' CHECK(length(body) <= 2000),
  landing_url TEXT CHECK(landing_url IS NULL OR length(landing_url) <= 2048),
  image_url TEXT CHECK(image_url IS NULL OR length(image_url) <= 2048),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','paused','archived')),
  starts_at TEXT,
  ends_at TEXT,
  impression_count INTEGER NOT NULL DEFAULT 0 CHECK(impression_count >= 0),
  link_click_count INTEGER NOT NULL DEFAULT 0 CHECK(link_click_count >= 0),
  image_view_count INTEGER NOT NULL DEFAULT 0 CHECK(image_view_count >= 0),
  ad_navigation_count INTEGER NOT NULL DEFAULT 0 CHECK(ad_navigation_count >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS advertisements_delivery ON advertisements(status, starts_at, ends_at, merchant_id);
CREATE INDEX IF NOT EXISTS advertisements_merchant ON advertisements(merchant_id, status);

CREATE TABLE IF NOT EXISTS advertising_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  advertisement_id INTEGER NOT NULL REFERENCES advertisements(id),
  user_id INTEGER REFERENCES users(id),
  event_key TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('impression','link_click','image_view','ad_navigation')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(advertisement_id, event_key, event_type)
);
CREATE INDEX IF NOT EXISTS advertising_events_ad ON advertising_events(advertisement_id, event_type, created_at);

CREATE TABLE IF NOT EXISTS advertising_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
