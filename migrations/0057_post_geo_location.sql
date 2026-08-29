-- 同城帖子：帖子地理位置记录
-- geo_precision: 'province' | 'city' | 'district' | null(不展示)
-- 地理信息只在发帖时快照记录一次
ALTER TABLE posts ADD COLUMN geo_province TEXT;
ALTER TABLE posts ADD COLUMN geo_city TEXT;
ALTER TABLE posts ADD COLUMN geo_district TEXT;

CREATE INDEX IF NOT EXISTS idx_posts_geo_province ON posts(geo_province) WHERE geo_province IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_geo_city ON posts(geo_city) WHERE geo_city IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_geo_district ON posts(geo_district) WHERE geo_district IS NOT NULL;
