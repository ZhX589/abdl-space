-- 帖子浏览量与热度功能
-- post_views: 浏览归因表，支撑 12 小时滑窗去重（同一用户对同一帖子每 12h 只计 1 次浏览）
-- viewed_at 用 Unix 秒；UNIQUE(user_id, post_id) 保证一对 (用户,帖子) 只有一行，靠 viewed_at 滑窗判定
CREATE TABLE IF NOT EXISTS post_views (
  user_id INTEGER NOT NULL,
  post_id INTEGER NOT NULL,
  viewed_at INTEGER NOT NULL,
  UNIQUE(user_id, post_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (post_id) REFERENCES posts(id)
);
CREATE INDEX IF NOT EXISTS idx_post_views_post ON post_views(post_id);

-- posts 浏览量计数（旧帖默认 0 → 热度公式中权重为 0，不纳入计算）
ALTER TABLE posts ADD COLUMN views_count INTEGER NOT NULL DEFAULT 0;
-- posts 原生分享计数（旧帖默认 0）
ALTER TABLE posts ADD COLUMN shares_count INTEGER NOT NULL DEFAULT 0;
