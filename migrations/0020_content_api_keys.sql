-- Content API Keys 表
-- 用于开放平台内容 API 鉴权（帖子、排行榜、纸尿裤数据）
CREATE TABLE IF NOT EXISTS content_api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  permissions TEXT NOT NULL DEFAULT 'read_posts,read_rankings,read_diapers',
  rate_limit INTEGER NOT NULL DEFAULT 200,
  active INTEGER NOT NULL DEFAULT 1,
  last_used INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  owner_id INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_content_api_keys_hash ON content_api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_content_api_keys_owner ON content_api_keys(owner_id);
