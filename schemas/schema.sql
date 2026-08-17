-- ============================================================
-- ABDL Space — D1 数据库表结构
-- 版本: v2.0（配合 API spec，支持纸尿裤数据库 + 评分 + 论坛）
-- ============================================================

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,           -- PBKDF2: iterations$salt$derivedKey
  username TEXT UNIQUE NOT NULL,         -- 3–30 字符
  display_name TEXT,                     -- 显示名称，最长 50
  role TEXT NOT NULL DEFAULT 'user',     -- 'user' | 'admin'
  avatar TEXT,                           -- URL, 最长 2048
  age INTEGER,                           -- 1–150
  region TEXT,                           -- 最长 50
  weight REAL,                           -- kg
  waist REAL,                            -- cm
  hip REAL,                              -- cm
  style_preference TEXT,                 -- 最长 100
  bio TEXT,                              -- 最长 500
  email_verified INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  password_changed_at DATETIME           -- BUG-177: invalidate old sessions after password reset
);

-- 纸尿裤主表
CREATE TABLE IF NOT EXISTS diapers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand TEXT NOT NULL,                   -- 最长 50
  model TEXT NOT NULL,                   -- 最长 100
  product_type TEXT NOT NULL,            -- 最长 20: '纸尿裤'/'拉拉裤'/'一体裤'
  thickness INTEGER NOT NULL,            -- 1–5 厚度等级
  absorbency_mfr TEXT NOT NULL,          -- 最长 50, 厂家标称吸水量
  absorbency_adult TEXT NOT NULL,        -- 最长 50, 成人实际估算
  is_baby_diaper INTEGER NOT NULL DEFAULT 0,
  comfort REAL,                          -- 1.0–5.0 先天舒适度
  popularity INTEGER DEFAULT 5,          -- 1–10 社区热度
  material TEXT NOT NULL,                -- 最长 500
  features TEXT NOT NULL,                -- 最长 1000
  avg_price TEXT NOT NULL,               -- 最长 50
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 纸尿裤尺码表
CREATE TABLE IF NOT EXISTS diaper_sizes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  diaper_id INTEGER NOT NULL,
  label TEXT NOT NULL,                   -- 最长 10, 如 'M'/'XL'
  waist_min INTEGER NOT NULL,
  waist_max INTEGER NOT NULL,
  hip_min INTEGER NOT NULL,
  hip_max INTEGER NOT NULL,
  UNIQUE(diaper_id, label),
  FOREIGN KEY (diaper_id) REFERENCES diapers(id) ON DELETE CASCADE
);

-- 评分表（6 维度 1–10 + 文字评价）
CREATE TABLE IF NOT EXISTS ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  diaper_id INTEGER NOT NULL,
  absorption_score INTEGER NOT NULL,     -- 1–10
  fit_score INTEGER NOT NULL,            -- 1–10
  comfort_score INTEGER NOT NULL,        -- 1–10
  thickness_score INTEGER NOT NULL,      -- 1–10
  appearance_score INTEGER NOT NULL,     -- 1–10
  value_score INTEGER NOT NULL,          -- 1–10
  review TEXT,                           -- 最长 500
  review_status TEXT NOT NULL DEFAULT 'approved',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, diaper_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (diaper_id) REFERENCES diapers(id)
);

-- 使用感受表（5 维度 -5~5）
CREATE TABLE IF NOT EXISTS feelings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  diaper_id INTEGER NOT NULL,
  size TEXT NOT NULL,                    -- 最长 10
  looseness INTEGER NOT NULL,            -- -5..5
  softness INTEGER NOT NULL,             -- -5..5
  dryness INTEGER NOT NULL,              -- -5..5
  odor_control INTEGER NOT NULL,         -- -5..5
  quietness INTEGER NOT NULL,            -- -5..5
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, diaper_id, size),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (diaper_id) REFERENCES diapers(id)
);

-- 论坛帖子表
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  content TEXT NOT NULL,                 -- 最长 5000
  diaper_id INTEGER,
  pinned INTEGER DEFAULT 0,
  is_announcement INTEGER DEFAULT 0,     -- 公告帖子标记（仅管理员可发）
  repost_id INTEGER,                     -- 转发的原帖ID
  has_nsfw INTEGER DEFAULT 0,            -- 是否包含敏感图片
  mental_crisis INTEGER NOT NULL DEFAULT 0, -- 是否需要心理危机干预提示
  spoiler_text TEXT DEFAULT '',           -- 内容警告文本
  visibility TEXT DEFAULT 'public',       -- public/unlisted/private/direct
  language TEXT DEFAULT 'zh',             -- 语言标签
  in_reply_to_id INTEGER,               -- 回复的帖子/评论ID
  in_reply_to_type TEXT,                 -- 'post' 或 'comment'
  in_reply_to_account_id INTEGER,        -- 回复目标的用户ID
  poll_id INTEGER,                       -- 关联的投票ID
  edited_at DATETIME,                    -- 编辑时间
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (diaper_id) REFERENCES diapers(id),
  FOREIGN KEY (repost_id) REFERENCES posts(id),
  FOREIGN KEY (poll_id) REFERENCES polls(id)
);
CREATE INDEX IF NOT EXISTS idx_posts_announcement ON posts(is_announcement, created_at DESC);

-- 小说作者作品（正文、审核与发布在后续 revision 表中扩展）
CREATE TABLE IF NOT EXISTS novels (
  id TEXT PRIMARY KEY,
  author_id INTEGER NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  category TEXT NOT NULL CHECK (category IN ('fiction', 'fantasy', 'romance', 'science_fiction', 'mystery', 'history', 'essay', 'other')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review_pending', 'published', 'rejected', 'archived')),
  idempotency_key TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER,
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_novels_author_idempotency
  ON novels(author_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_novels_author_updated
  ON novels(author_id, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS novel_volumes (
  id TEXT PRIMARY KEY,
  novel_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  idempotency_key TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER,
  FOREIGN KEY (novel_id) REFERENCES novels(id) ON DELETE CASCADE,
  UNIQUE (novel_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_novel_volumes_idempotency ON novel_volumes(novel_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_novel_volumes_order ON novel_volumes(novel_id, sort_order, id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS novel_chapters (
  id TEXT PRIMARY KEY,
  novel_id TEXT NOT NULL,
  volume_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  idempotency_key TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER,
  FOREIGN KEY (novel_id, volume_id) REFERENCES novel_volumes(novel_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_novel_chapters_idempotency ON novel_chapters(volume_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_novel_chapters_order ON novel_chapters(volume_id, sort_order, id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS chapter_revisions (
  id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL,
  chapter_id TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(body) <= 500000),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review_pending', 'approved', 'rejected', 'published', 'superseded')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  create_idempotency_key TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (chapter_id) REFERENCES novel_chapters(id) ON DELETE CASCADE,
  UNIQUE (owner_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chapter_revisions_create_idempotency ON chapter_revisions(chapter_id, create_idempotency_key) WHERE create_idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chapter_revisions_chapter ON chapter_revisions(chapter_id, updated_at DESC, id);

CREATE TABLE IF NOT EXISTS novel_revision_operations (
  owner_id INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  request_body TEXT NOT NULL,
  request_base_version INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  response_chapter_id TEXT NOT NULL,
  response_status TEXT NOT NULL,
  response_version INTEGER NOT NULL,
  response_created_at INTEGER NOT NULL,
  response_updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(owner_id, idempotency_key),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, revision_id) REFERENCES chapter_revisions(owner_id, id) ON DELETE CASCADE
);

-- 小说 MiMo 审核、评级与申诉管线 (spec S9)
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

CREATE TABLE IF NOT EXISTS novel_review_results (
  id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL,
  revision_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  violation_flag INTEGER NOT NULL CHECK (violation_flag IN (0, 1)),
  risk_categories TEXT NOT NULL DEFAULT '[]',
  rating TEXT NOT NULL CHECK (rating IN ('all_ages', 'suggest_12', 'suggest_15', 'suggest_18')),
  content_hint TEXT NOT NULL DEFAULT '' CHECK (length(content_hint) <= 500),
  summary TEXT NOT NULL DEFAULT '' CHECK (length(summary) <= 1000),
  model_id TEXT NOT NULL DEFAULT '',
  decided_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, revision_id) REFERENCES chapter_revisions(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, snapshot_id) REFERENCES novel_review_snapshots(owner_id, id) ON DELETE CASCADE,
  UNIQUE (owner_id, id)
);
CREATE INDEX IF NOT EXISTS idx_review_results_revision
  ON novel_review_results(revision_id, decided_at DESC, id);

CREATE TABLE IF NOT EXISTS novel_review_appeals (
  id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL,
  revision_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
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

-- 小说评级原子发布 (spec S9/S14)：每章至多一条 published revision
CREATE UNIQUE INDEX IF NOT EXISTS idx_chapter_revisions_single_published
  ON chapter_revisions(chapter_id) WHERE status = 'published';

-- 小说人工申诉裁决幂等账本
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

CREATE TABLE IF NOT EXISTS novel_review_appeal_claims (
  appeal_id TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL,
  claimed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (appeal_id) REFERENCES novel_review_appeals(id) ON DELETE CASCADE,
  FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_review_appeal_claims_admin
  ON novel_review_appeal_claims(admin_id, claimed_at DESC);

-- 投票表
CREATE TABLE IF NOT EXISTS polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status_id INTEGER NOT NULL,
  expires_at DATETIME NOT NULL,
  expired INTEGER DEFAULT 0,
  multiple INTEGER DEFAULT 0,
  hide_totals INTEGER DEFAULT 0,
  options TEXT NOT NULL DEFAULT '[]',     -- JSON: [{title, votes_count}]
  voters_count INTEGER DEFAULT 0,
  votes_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (status_id) REFERENCES posts(id) ON DELETE CASCADE
);

-- 投票记录表
CREATE TABLE IF NOT EXISTS poll_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  choices TEXT NOT NULL DEFAULT '[]',     -- JSON: [option_index]
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(poll_id, user_id),
  FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
);

-- 帖子评论表（支持一层嵌套回复）
CREATE TABLE IF NOT EXISTS post_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  parent_id INTEGER,
  content TEXT NOT NULL,                 -- 最长 2000
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (parent_id) REFERENCES post_comments(id)
);

-- 点赞表
CREATE TABLE IF NOT EXISTS likes (
  user_id INTEGER NOT NULL,
  target_type TEXT NOT NULL,             -- 'post' | 'comment'
  target_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, target_type, target_id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Wiki 页面表（通用 Wiki，可选关联纸尿裤）
CREATE TABLE IF NOT EXISTS wiki_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,                 -- Markdown
  author_id INTEGER,
  diaper_id INTEGER,                     -- 可选 FK，非 NULL 时为纸尿裤绑定 Wiki
  version INTEGER DEFAULT 1,
  is_published INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (author_id) REFERENCES users(id),
  FOREIGN KEY (diaper_id) REFERENCES diapers(id)
);

-- 页面版本历史
CREATE TABLE IF NOT EXISTS page_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  version INTEGER NOT NULL,
  author_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (page_id) REFERENCES wiki_pages(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id)
);

-- Wiki 段落评论（段评，类似 oi-wiki 风格）
CREATE TABLE IF NOT EXISTS wiki_inline_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL,
  paragraph_hash TEXT NOT NULL,          -- 段落文本摘要，用于定位
  author_id INTEGER NOT NULL,
  content TEXT NOT NULL,                 -- 最长 1000
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (page_id) REFERENCES wiki_pages(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id)
);

-- 术语百科表
CREATE TABLE IF NOT EXISTS terms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term TEXT NOT NULL,                    -- 最长 50
  abbreviation TEXT,                     -- 最长 100
  definition TEXT NOT NULL,              -- 最长 2000
  category TEXT,                         -- 最长 30
  created_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- 经验值/等级表
CREATE TABLE IF NOT EXISTS experience (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  current_exp INTEGER NOT NULL DEFAULT 0,
  total_exp INTEGER NOT NULL DEFAULT 0,
  current_level INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 通知表
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,                    -- 'like' | 'comment' | 'reply'
  message TEXT NOT NULL,
  related_id INTEGER,
  read INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- API Keys（管理员存储第三方 API 密钥）
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,                   -- 'deepseek' | 'openai' etc.
  key_value TEXT NOT NULL,                  -- 加密存储或明文（由管理员设置）
  label TEXT,                               -- 管理员备注
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_provider ON api_keys(provider);

-- ============================================================
-- 索引
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_diaper_sizes_diaper_id ON diaper_sizes(diaper_id);
CREATE INDEX IF NOT EXISTS idx_diapers_brand ON diapers(brand);
CREATE INDEX IF NOT EXISTS idx_ratings_diaper_id ON ratings(diaper_id);
CREATE INDEX IF NOT EXISTS idx_ratings_user_id ON ratings(user_id);
CREATE INDEX IF NOT EXISTS idx_feelings_diaper_id ON feelings(diaper_id);
CREATE INDEX IF NOT EXISTS idx_posts_user_id ON posts(user_id);
CREATE INDEX IF NOT EXISTS idx_posts_diaper_id ON posts(diaper_id);
CREATE INDEX IF NOT EXISTS idx_posts_pinned_created ON posts(pinned DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_post_comments_post_id ON post_comments(post_id);
CREATE INDEX IF NOT EXISTS idx_post_comments_created ON post_comments(post_id, created_at);
CREATE INDEX IF NOT EXISTS idx_likes_target ON likes(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_slug ON wiki_pages(slug);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_diaper_id ON wiki_pages(diaper_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wiki_pages_diaper_id_unique ON wiki_pages(diaper_id) WHERE diaper_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_page_versions_page_id ON page_versions(page_id);
CREATE INDEX IF NOT EXISTS idx_wiki_inline_comments_page_id ON wiki_inline_comments(page_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, read);
CREATE INDEX IF NOT EXISTS idx_experience_user_id ON experience(user_id);
CREATE INDEX IF NOT EXISTS idx_terms_category ON terms(category);

-- 私信系统
-- ============================================================

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER NOT NULL REFERENCES users(id),
  receiver_id INTEGER NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  client_msg_id TEXT,
  read INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  allow_messages INTEGER DEFAULT 1,
  allow_messages_from TEXT DEFAULT 'all'
);

CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id, receiver_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id, sender_id, read);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_msg
ON messages(sender_id, client_msg_id)
WHERE client_msg_id IS NOT NULL;

-- 私信持久化事件流
CREATE TABLE IF NOT EXISTS message_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  message_id INTEGER,
  peer_id INTEGER NOT NULL,
  read_up_to_id INTEGER,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_message_events_sync ON message_events(user_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_event_new
ON message_events(user_id, event_type, message_id)
WHERE event_type = 'message.new';
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_event_read
ON message_events(user_id, event_type, peer_id, read_up_to_id)
WHERE event_type = 'message.read';

-- 私信 outbox（Queue 消费后标记）
CREATE TABLE IF NOT EXISTS message_outbox (
  event_id INTEGER PRIMARY KEY,
  dispatched_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY(event_id) REFERENCES message_events(id)
);
CREATE INDEX IF NOT EXISTS idx_message_outbox_pending
ON message_outbox(dispatched_at, next_attempt_at);

-- 媒体上传记录
CREATE TABLE IF NOT EXISTS media_uploads (
  id TEXT PRIMARY KEY NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('status_original', 'status_preview', 'avatar', 'header', 'generic', 'release')),
  object_key TEXT NOT NULL UNIQUE,
  public_url TEXT NOT NULL,
  preview_upload_id TEXT REFERENCES media_uploads(id),
  preview_object_key TEXT,
  preview_url TEXT,
  mime_type TEXT NOT NULL,
  declared_size INTEGER NOT NULL CHECK (declared_size > 0),
  verified_size INTEGER CHECK (verified_size IS NULL OR verified_size >= 0),
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  blurhash TEXT,
  storage_provider TEXT NOT NULL CHECK (storage_provider IN ('cos', 'imgbed')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'complete', 'failed')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  CHECK (
    (preview_upload_id IS NULL AND preview_object_key IS NULL AND preview_url IS NULL)
    OR (preview_upload_id IS NOT NULL AND preview_object_key IS NOT NULL AND preview_url IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_media_uploads_user_status ON media_uploads(user_id, status);
CREATE INDEX IF NOT EXISTS idx_media_uploads_pending_expiry ON media_uploads(status, expires_at);

-- 帖子图片表
CREATE TABLE IF NOT EXISTS post_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  is_nsfw INTEGER DEFAULT 0,
  alt_text TEXT,
  blurhash TEXT,
  preview_url TEXT,
  storage_provider TEXT CHECK (storage_provider IS NULL OR storage_provider IN ('cos', 'imgbed')),
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_post_images_post_id ON post_images(post_id);

-- 关注系统
CREATE TABLE IF NOT EXISTS follows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  follower_id INTEGER NOT NULL REFERENCES users(id),
  following_id INTEGER NOT NULL REFERENCES users(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(follower_id, following_id)
);

CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);

-- 邮件验证码表
CREATE TABLE IF NOT EXISTS email_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,     -- SHA-256 哈希，不存明文
  type TEXT NOT NULL,           -- 'register' | 'bind' | 'reset'
  used INTEGER DEFAULT 0,
  attempts INTEGER DEFAULT 0,  -- 已尝试验证次数
  expires_at TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_email_ver_email ON email_verifications(email);
CREATE INDEX IF NOT EXISTS idx_email_ver_lookup ON email_verifications(email, code_hash, type, used);

-- D1 限流表（替代内存 Map）
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,        -- ip:action 或 email:action
  count INTEGER DEFAULT 1,
  window_start TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON rate_limits(expires_at);

-- 纸尿裤图片表
CREATE TABLE IF NOT EXISTS diaper_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  diaper_id INTEGER NOT NULL REFERENCES diapers(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_diaper_images_diaper_id ON diaper_images(diaper_id);

-- 公告表
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  starts_at TEXT,
  ends_at TEXT,
  all_day INTEGER DEFAULT 0,
  published INTEGER DEFAULT 1,
  published_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS announcement_reactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  announcement_id INTEGER NOT NULL,
  emoji TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(announcement_id, emoji, user_id),
  FOREIGN KEY (announcement_id) REFERENCES announcements(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS announcement_read_status (
  announcement_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  read_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (announcement_id, user_id),
  FOREIGN KEY (announcement_id) REFERENCES announcements(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 极光推送注册表
CREATE TABLE IF NOT EXISTS jpush_registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  reg_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER,
  UNIQUE(user_id, reg_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_jpush_user_id ON jpush_registrations(user_id);
CREATE INDEX IF NOT EXISTS idx_jpush_reg_id ON jpush_registrations(reg_id);

-- ============================================================
-- 交友请求系统
-- ============================================================

-- 交友请求主表
CREATE TABLE IF NOT EXISTS friend_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  looking_for TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 交友请求自定义信息字段
CREATE TABLE IF NOT EXISTS friend_request_fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  field_key TEXT NOT NULL,
  field_value TEXT NOT NULL,
  is_primary INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  FOREIGN KEY (request_id) REFERENCES friend_requests(id) ON DELETE CASCADE
);

-- 交友请求独立评论表
CREATE TABLE IF NOT EXISTS friend_request_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  parent_id INTEGER,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (request_id) REFERENCES friend_requests(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (parent_id) REFERENCES friend_request_comments(id)
);

-- 交友请求举报表
CREATE TABLE IF NOT EXISTS friend_request_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  reporter_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  evidence_urls TEXT,
  status TEXT DEFAULT 'pending',
  resolved_by INTEGER,
  admin_reply TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME,
  FOREIGN KEY (request_id) REFERENCES friend_requests(id),
  FOREIGN KEY (reporter_id) REFERENCES users(id),
  FOREIGN KEY (resolved_by) REFERENCES users(id)
);

-- 交友请求快照表（永久保存）
CREATE TABLE IF NOT EXISTS friend_request_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  data TEXT NOT NULL,
  snapshot_type TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 交友请求索引
CREATE INDEX IF NOT EXISTS idx_friend_requests_user ON friend_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_friend_requests_status ON friend_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_friend_request_fields_request ON friend_request_fields(request_id);
CREATE INDEX IF NOT EXISTS idx_friend_request_comments_request ON friend_request_comments(request_id);
CREATE INDEX IF NOT EXISTS idx_friend_request_reports_request ON friend_request_reports(request_id);
CREATE INDEX IF NOT EXISTS idx_friend_request_reports_status ON friend_request_reports(status);
CREATE INDEX IF NOT EXISTS idx_friend_request_snapshots_original ON friend_request_snapshots(original_id);

-- ============================================================
-- 私人小说云书架
-- ============================================================

CREATE TABLE IF NOT EXISTS private_books (
  id TEXT NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  format TEXT NOT NULL,
  object_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_md5 TEXT NOT NULL,
  declared_size INTEGER NOT NULL CHECK (declared_size > 0),
  verified_size INTEGER CHECK (verified_size IS NULL OR verified_size >= 0),
  parse_status TEXT NOT NULL DEFAULT 'pending' CHECK (parse_status IN ('pending', 'parsing', 'ready', 'failed')),
  upload_expires_at INTEGER NOT NULL,
  verification_started_at INTEGER,
  cleanup_status TEXT NOT NULL DEFAULT 'pending' CHECK (cleanup_status IN ('pending', 'deleting', 'monitoring', 'failed')),
  cleanup_attempted_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER,
  PRIMARY KEY (owner_id, id),
  UNIQUE (owner_id, object_key)
);

CREATE TABLE IF NOT EXISTS novel_object_cleanup_jobs (
  object_key TEXT PRIMARY KEY NOT NULL,
  not_before INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'deleting', 'monitoring', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER NOT NULL,
  claim_token TEXT,
  attempted_at INTEGER,
  last_error_status INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_novel_object_cleanup_jobs_due
  ON novel_object_cleanup_jobs(status, next_attempt_at, attempted_at, object_key);

CREATE TRIGGER IF NOT EXISTS private_books_cleanup_before_delete
BEFORE DELETE ON private_books
BEGIN
  INSERT INTO novel_object_cleanup_jobs (object_key, not_before, status, next_attempt_at)
  VALUES (OLD.object_key, OLD.upload_expires_at, 'pending', OLD.upload_expires_at)
  ON CONFLICT(object_key) DO UPDATE SET
    not_before = MIN(novel_object_cleanup_jobs.not_before, excluded.not_before),
    status = CASE WHEN novel_object_cleanup_jobs.status IN ('deleting', 'monitoring') THEN novel_object_cleanup_jobs.status ELSE 'pending' END,
    next_attempt_at = CASE WHEN novel_object_cleanup_jobs.status IN ('deleting', 'monitoring')
      THEN novel_object_cleanup_jobs.next_attempt_at ELSE MIN(novel_object_cleanup_jobs.next_attempt_at, excluded.next_attempt_at) END,
    claim_token = CASE WHEN novel_object_cleanup_jobs.status = 'deleting' THEN novel_object_cleanup_jobs.claim_token ELSE NULL END,
    updated_at = unixepoch();
END;

CREATE TRIGGER IF NOT EXISTS private_books_cleanup_after_soft_delete
AFTER UPDATE OF deleted_at ON private_books
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
BEGIN
  INSERT INTO novel_object_cleanup_jobs (object_key, not_before, status, next_attempt_at)
  VALUES (NEW.object_key, NEW.upload_expires_at, 'pending', NEW.upload_expires_at)
  ON CONFLICT(object_key) DO UPDATE SET
    not_before = MIN(novel_object_cleanup_jobs.not_before, excluded.not_before),
    status = CASE WHEN novel_object_cleanup_jobs.status IN ('deleting', 'monitoring') THEN novel_object_cleanup_jobs.status ELSE 'pending' END,
    next_attempt_at = CASE WHEN novel_object_cleanup_jobs.status IN ('deleting', 'monitoring')
      THEN novel_object_cleanup_jobs.next_attempt_at ELSE MIN(novel_object_cleanup_jobs.next_attempt_at, excluded.next_attempt_at) END,
    claim_token = CASE WHEN novel_object_cleanup_jobs.status = 'deleting' THEN novel_object_cleanup_jobs.claim_token ELSE NULL END,
    updated_at = unixepoch();
END;

CREATE UNIQUE INDEX IF NOT EXISTS idx_private_books_owner_content_hash
  ON private_books(owner_id, content_hash)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_private_books_owner_created
  ON private_books(owner_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS novel_sync_items (
  book_id TEXT NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (item_type IN ('progress', 'bookmark', 'note')),
  item_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  client_updated_at INTEGER NOT NULL,
  server_updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (owner_id, item_type, item_id),
  FOREIGN KEY (owner_id, book_id) REFERENCES private_books(owner_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_novel_sync_items_owner_book_updated
  ON novel_sync_items(owner_id, book_id, server_updated_at);

CREATE TABLE IF NOT EXISTS novel_sync_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('progress', 'bookmark', 'note')),
  item_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  client_updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (owner_id, book_id) REFERENCES private_books(owner_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_novel_sync_changes_owner_seq ON novel_sync_changes(owner_id, seq);

CREATE TRIGGER IF NOT EXISTS novel_sync_items_change_insert
AFTER INSERT ON novel_sync_items
BEGIN
  INSERT INTO novel_sync_changes (owner_id, book_id, item_type, item_id, payload_json, client_updated_at, deleted_at)
  VALUES (NEW.owner_id, NEW.book_id, NEW.item_type, NEW.item_id, NEW.payload_json, NEW.client_updated_at, NEW.deleted_at);
END;

CREATE TRIGGER IF NOT EXISTS novel_sync_items_change_update
AFTER UPDATE ON novel_sync_items
BEGIN
  INSERT INTO novel_sync_changes (owner_id, book_id, item_type, item_id, payload_json, client_updated_at, deleted_at)
  VALUES (NEW.owner_id, NEW.book_id, NEW.item_type, NEW.item_id, NEW.payload_json, NEW.client_updated_at, NEW.deleted_at);
END;
