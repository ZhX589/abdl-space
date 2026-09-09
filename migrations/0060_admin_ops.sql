-- 管理后台基础设施（幂等，可重复执行）
-- 1) 邮箱屏蔽名单：注册流程 send-code 前检查，命中直接拒绝
CREATE TABLE IF NOT EXISTS email_blocklist (
  email TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 2) 管理台每日聚合快照：按北京时区（UTC+8）自然日，只存"当日增量"
--    users/posts/comments/ratings/checkins/likes 为文本时间戳表，novels 为 unix 秒时间戳表
CREATE TABLE IF NOT EXISTS admin_daily_stats (
  date TEXT PRIMARY KEY,
  users INTEGER NOT NULL DEFAULT 0,
  posts INTEGER NOT NULL DEFAULT 0,
  comments INTEGER NOT NULL DEFAULT 0,
  ratings INTEGER NOT NULL DEFAULT 0,
  checkins INTEGER NOT NULL DEFAULT 0,
  likes INTEGER NOT NULL DEFAULT 0,
  novels INTEGER NOT NULL DEFAULT 0
);

-- 3) 管理台通用 KV 缓冲：totals/概览快照、日快照填充标记等
CREATE TABLE IF NOT EXISTS admin_metrics_cache (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 时间线大表补齐按日分桶需要的 created_at 索引（window 聚合从全表扫描收窄为区间扫描）
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at);
CREATE INDEX IF NOT EXISTS idx_post_comments_created_at ON post_comments(created_at);
CREATE INDEX IF NOT EXISTS idx_ratings_created_at ON ratings(created_at);
CREATE INDEX IF NOT EXISTS idx_daily_checkins_created_at ON daily_checkins(created_at);
CREATE INDEX IF NOT EXISTS idx_likes_created_at ON likes(created_at);
CREATE INDEX IF NOT EXISTS idx_novels_created_at ON novels(created_at);