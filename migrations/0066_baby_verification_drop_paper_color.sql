-- 0066: 认证要求不再强制纸张颜色。新库的 schema.sql 已无该列；此迁移仅为已按 0065 建过表的存量库删除 paper_color 列。
PRAGMA foreign_keys = ON;
ALTER TABLE baby_verification_capture_sessions DROP COLUMN paper_color;