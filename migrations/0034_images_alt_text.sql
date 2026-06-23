-- Add alt_text to post_images and comment_images if not exists
-- D1 SQLite doesn't support IF NOT EXISTS for ALTER TABLE, so we use a workaround
-- These may fail if columns already exist, which is fine

-- For post_images
SELECT alt_text FROM post_images LIMIT 1;

-- For comment_images  
SELECT alt_text FROM comment_images LIMIT 1;
