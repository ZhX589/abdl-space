-- LAN 心跳表
CREATE TABLE IF NOT EXISTS lan_heartbeats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  last_active_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_lan_heartbeats_active ON lan_heartbeats(last_active_at);
