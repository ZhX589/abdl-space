-- ============================================================
-- 账号体系升级 — D1 完整建表脚本 (v4.6)
-- 适用场景：全新部署或重建
-- 已有数据库请使用 0025_account_system_upgrade.sql
-- 执行方式：wrangler d1 execute abdl-space-db --file=./schemas/account-system.sql
-- ============================================================

-- 积分主表
CREATE TABLE IF NOT EXISTS points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  balance INTEGER NOT NULL DEFAULT 0,
  total_earned INTEGER NOT NULL DEFAULT 0,
  total_spent INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 积分流水
CREATE TABLE IF NOT EXISTS point_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL CHECK (amount != 0),
  type TEXT NOT NULL,
  related_id INTEGER,
  source_type TEXT,
  source_id INTEGER,
  description TEXT,
  metadata TEXT,
  idempotency_key TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 点赞表扩展（用于取消点赞冷却）
ALTER TABLE likes ADD COLUMN unliked_at DATETIME;

-- experience 表扩展（real streak 用于区分补签）
ALTER TABLE experience ADD COLUMN real_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE experience ADD COLUMN last_real_checkin_date TEXT;

-- 经验流水
CREATE TABLE IF NOT EXISTS exp_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL CHECK (amount != 0),
  type TEXT NOT NULL,
  related_id INTEGER,
  source_type TEXT,
  source_id INTEGER,
  description TEXT,
  metadata TEXT,
  idempotency_key TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 邀请码
CREATE TABLE IF NOT EXISTS invite_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL
    CHECK (code GLOB 'ABDL-[A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9]-[A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9]'),
  creator_id INTEGER,
  used_by INTEGER,
  used_at DATETIME,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (used_by) REFERENCES users(id) ON DELETE SET NULL
);

-- 签到记录（无 streak 列，动态计算）
CREATE TABLE IF NOT EXISTS daily_checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  checkin_date TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'normal',  -- 'normal' | 'makeup'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, checkin_date),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 徽章定义（预留）
CREATE TABLE IF NOT EXISTS badges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  icon TEXT NOT NULL,
  description TEXT NOT NULL,
  condition_type TEXT NOT NULL,
  condition_value INTEGER NOT NULL
);

-- 用户徽章（预留）
CREATE TABLE IF NOT EXISTS user_badges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  badge_key TEXT NOT NULL,
  unlocked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  displayed INTEGER DEFAULT 0,
  UNIQUE(user_id, badge_key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_points_user ON points(user_id);
CREATE INDEX IF NOT EXISTS idx_point_logs_user ON point_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exp_logs_user ON exp_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_point_logs_source ON point_logs(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_exp_logs_source ON exp_logs(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_point_logs_type ON point_logs(user_id, type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invite_codes_creator ON invite_codes(creator_id);
CREATE INDEX IF NOT EXISTS idx_invite_codes_code ON invite_codes(code);
CREATE INDEX IF NOT EXISTS idx_invite_codes_used_by ON invite_codes(used_by) WHERE used_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invite_codes_active ON invite_codes(creator_id, expires_at) WHERE used_by IS NULL;
CREATE INDEX IF NOT EXISTS idx_daily_checkins_user ON daily_checkins(user_id, checkin_date);
CREATE INDEX IF NOT EXISTS idx_user_badges_user ON user_badges(user_id);
CREATE INDEX IF NOT EXISTS idx_user_badges_displayed ON user_badges(user_id) WHERE displayed = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_point_logs_idem ON point_logs(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_exp_logs_idem ON exp_logs(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
