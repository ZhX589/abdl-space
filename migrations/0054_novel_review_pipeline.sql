-- 小说 MiMo 审核、评级与申诉管线 (spec S9)
-- 所有审核动作都在 revision 粒度；作品级 published 由后续切片聚合处理。

-- 不可变审核快照：提交审核时冻结的正文，作为审核证据、回滚和离线分发的依据。
-- 与 chapter_revisions.body 分离，因为 draft 可继续编辑，而审核必须针对固定内容。
CREATE TABLE IF NOT EXISTS novel_review_snapshots (
  id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL,
  revision_id TEXT NOT NULL,
  body_snapshot TEXT NOT NULL CHECK (length(body_snapshot) <= 500000),
  body_bytes INTEGER NOT NULL CHECK (body_bytes >= 0),
  submitted_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, revision_id) REFERENCES chapter_revisions(owner_id, id) ON DELETE CASCADE,
  UNIQUE (owner_id, id)
);
CREATE INDEX IF NOT EXISTS idx_review_snapshots_revision
  ON novel_review_snapshots(revision_id, submitted_at DESC, id);

-- MiMo 结构化审核结果：每个 snapshot 最多一条当前结果；
-- 重新审核 (新 snapshot) 会写新行，旧行保留作为审计历史。
CREATE TABLE IF NOT EXISTS novel_review_results (
  id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL,
  revision_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  -- 模型判定：true=过分违规拒绝公开，false=可发布（仍可能附评级/提示）
  violation_flag INTEGER NOT NULL CHECK (violation_flag IN (0, 1)),
  -- 风险类别与置信度：[{category, confidence}]
  risk_categories TEXT NOT NULL DEFAULT '[]',
  -- 评级标签：小说本地化，不引用 MPA/MPAA
  rating TEXT NOT NULL CHECK (rating IN ('all_ages', 'suggest_12', 'suggest_15', 'suggest_18')),
  -- 面向读者的内容提示（不强制拦截）
  content_hint TEXT NOT NULL DEFAULT '' CHECK (length(content_hint) <= 500),
  -- 不包含大段原文的安全审核摘要
  summary TEXT NOT NULL DEFAULT '' CHECK (length(summary) <= 1000),
  -- 模型自身标识（版本/endpoint 摘要），便于审计，不包含密钥
  model_id TEXT NOT NULL DEFAULT '',
  decided_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, revision_id) REFERENCES chapter_revisions(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, snapshot_id) REFERENCES novel_review_snapshots(owner_id, id) ON DELETE CASCADE,
  UNIQUE (owner_id, id)
);
CREATE INDEX IF NOT EXISTS idx_review_results_revision
  ON novel_review_results(revision_id, decided_at DESC, id);

-- 人工申诉队列：作者对拒绝结果提交申诉，必须由人工裁决，不得由同一个模型自动判定。
CREATE TABLE IF NOT EXISTS novel_review_appeals (
  id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL,
  revision_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  -- pending=等待人工；reviewing=人工处理中；approved=申诉成功可发布；rejected=申诉驳回
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewing', 'approved', 'rejected')),
  idempotency_key TEXT,
  decided_by INTEGER,
  decided_at INTEGER,
  decision_note TEXT NOT NULL DEFAULT '' CHECK (length(decision_note) <= 1000),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, revision_id) REFERENCES chapter_revisions(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (owner_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_review_appeals_idempotency
  ON novel_review_appeals(revision_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_review_appeals_pending
  ON novel_review_appeals(status, created_at, id)
  WHERE status IN ('pending', 'reviewing');

-- 审核动作审计记录：submit/auto_approve/auto_reject/appeal/human_approve/human_reject/publish。
-- metadata 存 JSON（如 result_id/snapshot_id），不存正文或模型密钥。
CREATE TABLE IF NOT EXISTS novel_review_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL,
  revision_id TEXT NOT NULL,
  actor_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'submit', 'auto_approve', 'auto_reject', 'appeal',
    'human_approve', 'human_reject', 'publish', 'review_kept_pending'
  )),
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, revision_id) REFERENCES chapter_revisions(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_review_audit_revision
  ON novel_review_audit(revision_id, id);
