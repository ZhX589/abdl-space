-- ============================================================
-- Migration 0027: 站点配置表（内测模式等）
-- Date: 2026-06-11
-- Description: 新增 site_settings 表用于存储全局配置
-- ============================================================

CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 默认内测模式配置（关闭状态）
INSERT OR IGNORE INTO site_settings (key, value) VALUES
  ('beta_mode', '{"enabled":false,"allowedRoutes":["/","/login","/register","/admin","/beta-register"],"message":"产品正在内测中，请登录后访问"}');
