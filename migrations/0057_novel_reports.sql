-- 0057: 公开书城举报表（先发布后人工审核模式）
CREATE TABLE IF NOT EXISTS novel_reports (
	id TEXT PRIMARY KEY,
	reporter_id INTEGER NOT NULL,
	work_id TEXT NOT NULL,
	chapter_id TEXT,
	reason TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewing', 'actioned', 'dismissed')),
	idempotency_key TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_novel_reports_status ON novel_reports(status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_novel_reports_dedupe ON novel_reports(reporter_id, work_id, idempotency_key);
