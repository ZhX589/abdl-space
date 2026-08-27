-- migrations/0042_badge_verified.sql
-- 插入"圈内认证"徽章定义
INSERT OR IGNORE INTO badges (key, name, icon, description, condition_type, condition_value)
VALUES ('verified', '圈内认证', 'verified', '用户身份经过平台验证，获得圈内认证徽章。', 'manual', 0);
