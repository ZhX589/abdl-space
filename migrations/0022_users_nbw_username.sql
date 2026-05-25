-- 添加 NewBabyWorld 用户名字段用于显示绑定的第三方账户名
ALTER TABLE users ADD COLUMN nbw_username TEXT DEFAULT NULL;
