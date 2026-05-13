-- ============================================================
-- 管理员种子数据
-- 默认管理员账号: admin / admin@ZhX&ZYongX
-- ============================================================
-- 用法:
--   npx wrangler d1 execute abdl-space-db --local --file schemas/seeds/admin.sql
-- ============================================================

INSERT INTO users (email, password_hash, username, role) VALUES (
  'admin@abdl.space',
  '100000$b8112df2ec739f524cba56d3e1ecbfc3$4ba2fba10b4417c21e58f49fea01280d8d58f22ea040d13316aca2e6a3395ba0ca6ed8c6ea61a896fdb1858a3bc3fefb5141406ab94b3860811507bce919f9a9',
  'admin',
  'admin'
);