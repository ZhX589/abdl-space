-- 低成本降本：时间线计数子查询索引
-- 目标：把 (SELECT COUNT(*) FROM posts WHERE repost_id=p.id) 等从全表扫描变成索引查找
CREATE INDEX IF NOT EXISTS idx_posts_repost_id      ON posts(repost_id)      WHERE repost_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_in_reply_to_id ON posts(in_reply_to_id) WHERE in_reply_to_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_created_at     ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_likes_user_target    ON likes(user_id, target_type, target_id);
