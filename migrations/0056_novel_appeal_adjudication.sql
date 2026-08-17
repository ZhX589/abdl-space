-- 小说人工申诉领取状态。领取者与最终裁决者必须分开保存。
CREATE TABLE IF NOT EXISTS novel_review_appeal_claims (
  appeal_id TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL,
  claimed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (appeal_id) REFERENCES novel_review_appeals(id) ON DELETE CASCADE,
  FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_review_appeal_claims_admin
  ON novel_review_appeal_claims(admin_id, claimed_at DESC);

-- 管理员领取/裁决幂等账本。
-- 管理员领取/裁决可安全重试，响应不依赖审计记录推断。
CREATE TABLE IF NOT EXISTS novel_review_admin_operations (
  admin_id INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  appeal_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('claim', 'approve', 'reject')),
  response_body TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (admin_id, idempotency_key),
  FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (appeal_id) REFERENCES novel_review_appeals(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_review_admin_operations_appeal
  ON novel_review_admin_operations(appeal_id, created_at DESC);
