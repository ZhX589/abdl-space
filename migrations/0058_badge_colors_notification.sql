-- 0058: 徽章体系升级——颜色、展示单枚化、新徽章通知
-- 徽章颜色（后台管理指定，App 渲染圆角矩形+文字）
ALTER TABLE badges ADD COLUMN color TEXT NOT NULL DEFAULT '#7C4DFF';
-- 新徽章确认：NULL=尚未在 App 中确认为已知（启动时弹窗提示用）
ALTER TABLE user_badges ADD COLUMN acknowledged_at DATETIME;
