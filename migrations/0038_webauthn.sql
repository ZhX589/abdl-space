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
