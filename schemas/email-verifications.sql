CREATE TABLE IF NOT EXISTS email_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  type TEXT NOT NULL,       -- 'register' | 'bind' | 'reset'
  used INTEGER DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_email_ver_email ON email_verifications(email);
CREATE INDEX IF NOT EXISTS idx_email_ver_lookup ON email_verifications(email, code, type, used);
