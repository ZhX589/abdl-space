-- 添加 NewBabyWorld 用户名字段用于显示绑定的第三方账户名
-- 注意：此迁移非幂等，重复运行会报错（D1 不支持 IF NOT EXISTS ADD COLUMN）
ALTER TABLE users ADD COLUMN nbw_username TEXT DEFAULT NULL;
