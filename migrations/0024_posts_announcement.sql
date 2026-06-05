-- 公告帖子标记
ALTER TABLE posts ADD COLUMN is_announcement INTEGER DEFAULT 0;
CREATE INDEX idx_posts_announcement ON posts(is_announcement, created_at DESC);
