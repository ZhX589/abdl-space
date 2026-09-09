-- 0061: admin_daily_stats 补 likes 列（0060 建表时遗漏，ensureDailyStats 回填会写它）
ALTER TABLE admin_daily_stats ADD COLUMN likes INTEGER NOT NULL DEFAULT 0;