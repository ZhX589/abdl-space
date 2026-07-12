-- Passkey 凭证表（WebAuthn / 宝宝安全识别）
CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY,                    -- credential ID (base64url)
  user_id INTEGER NOT NULL,
  public_key BLOB NOT NULL,              -- P-256 公钥
  counter INTEGER DEFAULT 0,             -- 签名计数器
  device_type TEXT,                       -- 'singleDevice' | 'multiDevice'
  backed_up INTEGER DEFAULT 0,           -- 是否已备份
  transports TEXT,                        -- JSON array: ['internal', 'ble', etc.]
  nickname TEXT,                          -- 用户自定义名称（如"我的 iPhone"）
  created_at INTEGER DEFAULT (unixepoch()),
  last_used_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkeys(user_id);

-- WebAuthn 临时挑战表（用于验证时比对）
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id TEXT PRIMARY KEY,                   -- 挑战 ID（随机生成）
  challenge TEXT NOT NULL,               -- 挑战值（base64url）
  user_id INTEGER,                       -- 关联用户（注册时有，认证时可选）
  type TEXT NOT NULL,                    -- 'register' 或 'authenticate'
  expires_at INTEGER NOT NULL,           -- 过期时间（unixepoch）
  created_at INTEGER DEFAULT (unixepoch())
);

-- 自动清理过期挑战（可在 Worker 中定时调用）
-- DELETE FROM webauthn_challenges WHERE expires_at < unixepoch();
