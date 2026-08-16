-- 小说评级原子发布 (spec S9/S14)
-- 切换当前 revision 必须事务性完成，禁止读者看到半发布状态。
-- 每章至多一条 status='published' 的 revision；旧版在新版发布时原子降为 superseded。

CREATE UNIQUE INDEX IF NOT EXISTS idx_chapter_revisions_single_published
  ON chapter_revisions(chapter_id) WHERE status = 'published';
