-- 0028: 设置默认头像
-- 将所有 avatar 为 NULL 或空字符串的用户设置为默认头像
UPDATE users 
SET avatar = 'https://img.abdl-space.top/file/system/1781439303787_play_store_512.png' 
WHERE avatar IS NULL OR avatar = '';
