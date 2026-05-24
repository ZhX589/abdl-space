-- 品牌表增加颜色反转字段
ALTER TABLE brands ADD COLUMN invert_dark INTEGER DEFAULT 0;
ALTER TABLE brands ADD COLUMN invert_light INTEGER DEFAULT 0;
