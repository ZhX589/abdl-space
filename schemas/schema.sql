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
  password_changed_at DATETIME,          -- BUG-177: invalidate old sessions after password reset
  auth_invalid_before INTEGER            -- invalidate JWTs issued at or before this Unix second
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
  geo_province TEXT,                     -- 同城帖子：发帖时省份快照（null=不展示）
  geo_city TEXT,                         -- 城市（仅 geo_precision 含市级时）
  geo_district TEXT,                     -- 区县（仅 geo_precision 到区级时）
  edited_at DATETIME,                    -- 编辑时间
  views_count INTEGER NOT NULL DEFAULT 0,-- 浏览量（旧帖 0 → 热度公式中权重为 0 不纳入）
  shares_count INTEGER NOT NULL DEFAULT 0,-- 原生分享次数
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (diaper_id) REFERENCES diapers(id),
  FOREIGN KEY (repost_id) REFERENCES posts(id),
  FOREIGN KEY (poll_id) REFERENCES polls(id)
);
CREATE INDEX IF NOT EXISTS idx_posts_announcement ON posts(is_announcement, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_geo_province ON posts(geo_province) WHERE geo_province IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_geo_city ON posts(geo_city) WHERE geo_city IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_geo_district ON posts(geo_district) WHERE geo_district IS NOT NULL;

-- 帖子浏览归因：12 小时滑窗去重（同一用户对同一帖子每 12h 计 1 次浏览）
CREATE TABLE IF NOT EXISTS post_views (
  user_id INTEGER NOT NULL,
  post_id INTEGER NOT NULL,
  viewed_at INTEGER NOT NULL,             -- Unix 秒，最近一次计入浏览的时间
  UNIQUE(user_id, post_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (post_id) REFERENCES posts(id)
);
CREATE INDEX IF NOT EXISTS idx_post_views_post ON post_views(post_id);

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
-- 低成本降本（0059）：消除时间线计数子查询的全表扫描
CREATE INDEX IF NOT EXISTS idx_posts_repost_id      ON posts(repost_id)      WHERE repost_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_in_reply_to_id ON posts(in_reply_to_id) WHERE in_reply_to_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_created_at     ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_likes_user_target    ON likes(user_id, target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_slug ON wiki_pages(slug);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_diaper_id ON wiki_pages(diaper_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wiki_pages_diaper_id_unique ON wiki_pages(diaper_id) WHERE diaper_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_page_versions_page_id ON page_versions(page_id);
CREATE INDEX IF NOT EXISTS idx_wiki_inline_comments_page_id ON wiki_inline_comments(page_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, read);

-- Android QQ 登录。仅保存带域分隔的 HMAC，不保存原始 UnionID/OpenID/token/code。
CREATE TABLE IF NOT EXISTS qq_identities (
  unionid_hmac TEXT PRIMARY KEY NOT NULL CHECK (length(unionid_hmac) = 64),
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  nickname TEXT NOT NULL DEFAULT '' CHECK (length(nickname) <= 100),
  avatar TEXT NOT NULL DEFAULT '' CHECK (length(avatar) <= 2048),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_qq_identities_user ON qq_identities(user_id);

CREATE TABLE IF NOT EXISTS qq_app_subjects (
  app_id TEXT NOT NULL CHECK (length(app_id) BETWEEN 5 AND 32),
  openid_hmac TEXT NOT NULL CHECK (length(openid_hmac) = 64),
  unionid_hmac TEXT NOT NULL CHECK (length(unionid_hmac) = 64),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (app_id, openid_hmac),
  UNIQUE (app_id, unionid_hmac)
);
CREATE INDEX IF NOT EXISTS idx_qq_app_subjects_identity ON qq_app_subjects(unionid_hmac);

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
-- 宝宝认证
-- ============================================================

-- 0065: 宝宝认证首版。QQ 与照片证据均为严格私密数据。
CREATE TABLE IF NOT EXISTS baby_verification_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL CHECK (version > 0),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  declaration_version TEXT NOT NULL,
  free_monthly_limit INTEGER NOT NULL DEFAULT 2 CHECK (free_monthly_limit BETWEEN 0 AND 20),
  sponsor_monthly_limit INTEGER NOT NULL DEFAULT 3 CHECK (sponsor_monthly_limit BETWEEN free_monthly_limit AND 20),
  capture_ttl_seconds INTEGER NOT NULL DEFAULT 900 CHECK (capture_ttl_seconds BETWEEN 300 AND 3600),
  upload_ttl_seconds INTEGER NOT NULL DEFAULT 300 CHECK (upload_ttl_seconds BETWEEN 60 AND 900),
  max_evidence_size INTEGER NOT NULL DEFAULT 5242880 CHECK (max_evidence_size BETWEEN 1024 AND 8388608),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT OR IGNORE INTO baby_verification_settings(id,version,enabled,declaration_version)
VALUES(1,1,0,'2026-09-13');

CREATE TABLE IF NOT EXISTS baby_verification_capture_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('active','completed','expired','cancelled')),
  nonce TEXT NOT NULL,
  instructions_version INTEGER NOT NULL,
  paper_shape TEXT NOT NULL,
  fold_instruction TEXT NOT NULL,
  placement_instruction TEXT NOT NULL,
  random_text TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  completed_at INTEGER,
  cancelled_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(id,user_id),
  CHECK ((status='active' AND completed_at IS NULL AND cancelled_at IS NULL)
    OR (status='completed' AND completed_at IS NOT NULL AND cancelled_at IS NULL)
    OR (status IN ('expired','cancelled') AND completed_at IS NULL AND cancelled_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_baby_capture_user_active ON baby_verification_capture_sessions(user_id,status,expires_at);

CREATE TABLE IF NOT EXISTS baby_verification_applications (
  id TEXT PRIMARY KEY NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capture_session_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('draft','submitted','reviewing','approved','rejected','cancelled')),
  qq TEXT NOT NULL CHECK (length(qq) BETWEEN 32 AND 1024),
  adult_declaration INTEGER NOT NULL CHECK (adult_declaration = 1),
  declaration_version TEXT NOT NULL,
  declared_at INTEGER NOT NULL,
  submitted_at INTEGER,
  claimed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  claimed_at INTEGER,
  decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at INTEGER,
  decision_note TEXT NOT NULL DEFAULT '',
  rejection_acknowledged_at INTEGER,
  cancelled_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(id,user_id),
  FOREIGN KEY(capture_session_id,user_id) REFERENCES baby_verification_capture_sessions(id,user_id),
  CHECK ((status='draft' AND submitted_at IS NULL AND decided_at IS NULL AND cancelled_at IS NULL)
    OR (status IN ('submitted','reviewing') AND submitted_at IS NOT NULL AND decided_at IS NULL AND cancelled_at IS NULL)
    OR (status IN ('approved','rejected') AND submitted_at IS NOT NULL AND decided_at IS NOT NULL AND decided_by IS NOT NULL AND cancelled_at IS NULL)
    OR (status='cancelled' AND cancelled_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_baby_application_one_open ON baby_verification_applications(user_id)
  WHERE status IN ('submitted','reviewing');
CREATE INDEX IF NOT EXISTS idx_baby_application_admin_queue ON baby_verification_applications(status,submitted_at,id);
CREATE INDEX IF NOT EXISTS idx_baby_application_user_history ON baby_verification_applications(user_id,created_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS baby_verification_evidence (
  id TEXT PRIMARY KEY NOT NULL,
  application_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('capture_photo','supporting_photo')),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp')),
  object_key TEXT NOT NULL UNIQUE,
  declared_size INTEGER NOT NULL CHECK (declared_size > 0 AND declared_size <= 8388608),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  content_md5 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','verifying','ready','failed')),
  upload_expires_at INTEGER NOT NULL,
  verification_token TEXT,
  verification_started_at INTEGER,
  verified_size INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY(application_id,user_id) REFERENCES baby_verification_applications(id,user_id),
  CHECK ((status='verifying' AND verification_token IS NOT NULL AND verification_started_at IS NOT NULL)
    OR (status!='verifying' AND verification_token IS NULL AND verification_started_at IS NULL)),
  CHECK ((status='ready' AND verified_size IS NOT NULL AND completed_at IS NOT NULL) OR status!='ready')
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_baby_evidence_application_kind ON baby_verification_evidence(application_id,kind);
CREATE INDEX IF NOT EXISTS idx_baby_evidence_pending ON baby_verification_evidence(status,upload_expires_at,verification_started_at);

CREATE TABLE IF NOT EXISTS baby_verification_certificates (
  id TEXT PRIMARY KEY NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL UNIQUE REFERENCES baby_verification_applications(id),
  status TEXT NOT NULL CHECK (status IN ('active','revoked')),
  issued_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  revoke_reason TEXT,
  current_credential_id TEXT,
  credential_generation INTEGER NOT NULL DEFAULT 1 CHECK (credential_generation > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK ((status='active' AND revoked_at IS NULL) OR (status='revoked' AND revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_baby_certificate_active_user ON baby_verification_certificates(user_id) WHERE status='active';

CREATE TABLE IF NOT EXISTS baby_verification_credentials (
  id TEXT PRIMARY KEY NOT NULL,
  certificate_id TEXT NOT NULL REFERENCES baby_verification_certificates(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation > 0),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('active','superseded','revoked')),
  issued_at INTEGER NOT NULL,
  superseded_at INTEGER,
  revoked_at INTEGER,
  UNIQUE(certificate_id,generation)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_baby_credential_active_certificate ON baby_verification_credentials(certificate_id) WHERE status='active';

CREATE TABLE IF NOT EXISTS baby_verification_badge_sources (
  certificate_id TEXT PRIMARY KEY NOT NULL REFERENCES baby_verification_certificates(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_key TEXT NOT NULL DEFAULT 'verified',
  preserved_existing_badge INTEGER NOT NULL DEFAULT 0 CHECK (preserved_existing_badge IN (0,1)),
  granted_at INTEGER NOT NULL DEFAULT (unixepoch()),
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_baby_badge_source_user ON baby_verification_badge_sources(user_id,badge_key,revoked_at);

CREATE TABLE IF NOT EXISTS baby_verification_operations (
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(actor_id,operation_id)
);
CREATE INDEX IF NOT EXISTS idx_baby_operations_target ON baby_verification_operations(target_id,created_at DESC);

CREATE TABLE IF NOT EXISTS baby_verification_transaction_guards (
  id INTEGER PRIMARY KEY CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS baby_verification_audit (
  id TEXT PRIMARY KEY NOT NULL,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  application_id TEXT,
  action TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_baby_audit_recent ON baby_verification_audit(created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_baby_audit_application ON baby_verification_audit(application_id,created_at DESC);

CREATE TABLE IF NOT EXISTS baby_verification_rate_limits (
  bucket TEXT PRIMARY KEY NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0)
);

CREATE TABLE IF NOT EXISTS baby_verification_notification_details (
  notification_id INTEGER PRIMARY KEY NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL,
  target_path TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_baby_notification_application ON baby_verification_notification_details(application_id,notification_id);

-- 管理员身份解绑操作、审计和持久化限流。敏感 QQ 标识不写入这些表。
CREATE TABLE IF NOT EXISTS admin_identity_operations (
  operation_id TEXT PRIMARY KEY NOT NULL,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  confirmed_username TEXT NOT NULL,
  expected_binding_version INTEGER NOT NULL CHECK (expected_binding_version >= 0),
  response_status INTEGER NOT NULL CHECK (response_status BETWEEN 100 AND 599),
  response_body TEXT NOT NULL CHECK (json_valid(response_body)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_admin_identity_operations_target ON admin_identity_operations(target_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_identity_audit (
  id TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_admin_identity_audit_target ON admin_identity_audit(target_user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_admin_identity_audit_actor ON admin_identity_audit(actor_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS admin_identity_rate_limits (
  bucket TEXT PRIMARY KEY NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0)
);


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

-- A new observation epoch; deliberately no users.has_app backfill.
CREATE TABLE IF NOT EXISTS app_client_measurement (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  measurement_started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT OR IGNORE INTO app_client_measurement(id) VALUES (1);

-- 0 is the normalized missing/malformed sentinel. SQL NULL is not unique in SQLite.
CREATE TABLE IF NOT EXISTS app_client_observations (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version_key INTEGER NOT NULL CHECK (version_key BETWEEN 0 AND 2147483647),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (user_id, version_key)
);
CREATE INDEX IF NOT EXISTS idx_app_client_observations_version_seen
  ON app_client_observations(version_key, last_seen_at DESC, user_id);
CREATE INDEX IF NOT EXISTS idx_app_client_observations_seen
  ON app_client_observations(last_seen_at DESC, user_id);

CREATE TABLE IF NOT EXISTS app_client_latest (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version_key INTEGER NOT NULL CHECK (version_key BETWEEN 0 AND 2147483647),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  FOREIGN KEY (user_id, version_key) REFERENCES app_client_observations(user_id, version_key) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_app_client_latest_seen ON app_client_latest(last_seen_at DESC, user_id);
CREATE INDEX IF NOT EXISTS idx_app_client_latest_version ON app_client_latest(version_key, last_seen_at DESC, user_id);

-- Policy is a single atomic site setting, reserved from the generic settings writer.
CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO site_settings(key, value) VALUES ('app_client_policy',
  '{"enabled":false,"deprecated_version_codes":[],"block_unversioned":false,"update_message":"当前 App 版本已停止支持，请更新到最新版本后继续使用。"}');

-- Sponsor core prerequisites for standalone album schema (migration 0062)
-- Standalone/replay-safe sponsor core. Never modifies users.role.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sponsor_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL CHECK (version > 0),
  config_json TEXT NOT NULL CHECK (json_valid(config_json))
);
CREATE TABLE IF NOT EXISTS sponsor_plans (
  id TEXT PRIMARY KEY NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  sort_order INTEGER NOT NULL,
  plan_json TEXT NOT NULL CHECK (json_valid(plan_json))
);
CREATE INDEX IF NOT EXISTS sponsor_plans_enabled ON sponsor_plans(enabled, sort_order, id);
CREATE TABLE IF NOT EXISTS sponsor_memberships (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  permanent INTEGER NOT NULL DEFAULT 0 CHECK (permanent IN (0, 1)),
  expires_at INTEGER,
  plan_name TEXT,
  color_key TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS sponsor_code_batches (
  id TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  plan_id TEXT NOT NULL REFERENCES sponsor_plans(id),
  count INTEGER NOT NULL CHECK (count BETWEEN 1 AND 200),
  source TEXT NOT NULL CHECK (source IN ('admin', 'afdian')),
  actor_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS sponsor_codes (
  id TEXT PRIMARY KEY NOT NULL,
  batch_id TEXT NOT NULL REFERENCES sponsor_code_batches(id),
  plan_id TEXT NOT NULL REFERENCES sponsor_plans(id),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  code_hash TEXT NOT NULL UNIQUE,
  masked_code TEXT NOT NULL,
  encrypted_code TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  expires_at INTEGER,
  redeemed_at INTEGER,
  redeemed_by INTEGER REFERENCES users(id),
  operation_id TEXT UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS sponsor_codes_batch ON sponsor_codes(batch_id, id);
CREATE INDEX IF NOT EXISTS sponsor_codes_filter ON sponsor_codes(plan_id, disabled, redeemed_at, expires_at);
CREATE INDEX IF NOT EXISTS sponsor_codes_redeemer ON sponsor_codes(redeemed_by, redeemed_at);
CREATE TABLE IF NOT EXISTS sponsor_daily_usage (
  user_id INTEGER NOT NULL REFERENCES users(id),
  day_key TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
  bonus INTEGER NOT NULL DEFAULT 0 CHECK (bonus BETWEEN -100000 AND 100000),
  PRIMARY KEY (user_id, day_key)
);
CREATE TABLE IF NOT EXISTS sponsor_notice_acks (
  user_id INTEGER NOT NULL REFERENCES users(id),
  notice_version INTEGER NOT NULL,
  acknowledged_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, notice_version)
);
CREATE TABLE IF NOT EXISTS sponsor_claims (
  user_id INTEGER NOT NULL REFERENCES users(id),
  benefit_id TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, benefit_id)
);
CREATE TABLE IF NOT EXISTS sponsor_operations (
  id TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  actor_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('redeem','grant','revoke','quota','claim','original','color')),
  request_hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  code_id TEXT REFERENCES sponsor_codes(id),
  plan_json TEXT,
  benefit_id TEXT,
  color_key TEXT,
  media_key TEXT,
  notice_version INTEGER,
  adjustment INTEGER,
  day_key TEXT NOT NULL DEFAULT (date('now', '+8 hours')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  result_json TEXT
);
CREATE INDEX IF NOT EXISTS sponsor_operations_user_history ON sponsor_operations(user_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS sponsor_operations_day ON sponsor_operations(day_key, kind);
CREATE TABLE IF NOT EXISTS sponsor_redemptions (
  id TEXT PRIMARY KEY NOT NULL REFERENCES sponsor_operations(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  plan_name TEXT NOT NULL,
  redeemed_at INTEGER NOT NULL,
  expires_at INTEGER,
  permanent INTEGER NOT NULL CHECK (permanent IN (0,1))
);
CREATE INDEX IF NOT EXISTS sponsor_redemptions_user ON sponsor_redemptions(user_id, redeemed_at DESC, id);
CREATE TABLE IF NOT EXISTS sponsor_audit (
  id TEXT PRIMARY KEY NOT NULL,
  actor_id TEXT,
  user_id TEXT,
  action TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS sponsor_audit_recent ON sponsor_audit(created_at DESC, id);
CREATE TABLE IF NOT EXISTS sponsor_rate_limits (
  bucket TEXT PRIMARY KEY NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0)
);

INSERT OR IGNORE INTO sponsor_settings(id, version, config_json) VALUES (1, 1, '{"enabled":false,"version":1,"center_title":"赞助者中心","free_daily_limit":3,"sponsor_daily_limit":25,"timezone":"Asia/Shanghai","notice_version":1,"notice_title":"查看原图须知","notice_body":"原图存储与传输会产生运营成本，赞助将帮助分担这些费用。普通用户每天可查看 {x} 张原图，赞助者每天可查看 {y} 张，今日剩余 {a} 张，{reset} 重置。确认继续后扣减本次查看额度，重复查看同一原图也按次计入。","exhausted_title":"今日原图额度已用完","exhausted_body":"普通用户每天可查看 {x} 张原图，将于 {reset} 重置。","sponsor_exhausted_body":"赞助者每天可查看 {y} 张原图，将于 {reset} 重置。","purchase_title":"赞助须知","purchase_steps":["请选择适合自己的赞助方案，理性赞助。","前往爱发电完成支付后，获取兑换码并返回赞助者中心兑换。","从购买页面返回不代表支付或兑换成功，请以赞助者中心显示为准。"],"minimum_read_seconds":5,"default_color_key":"blue","colors":[{"key":"blue","name":"宝宝蓝","light":"#4E7394","dark":"#B9D9F0","permanent_only":false},{"key":"pink","name":"宝宝粉","light":"#A15E7C","dark":"#F2BED4","permanent_only":false},{"key":"gold","name":"金色","light":"#795500","dark":"#F6D778","permanent_only":true}],"benefits":[{"id":"original","title":"更多原图额度","description":"身份有效期间自动提升每日原图额度。","status":"automatic","action":"original","sort_order":10},{"id":"color","title":"用户名颜色","description":"普通赞助者可选择宝宝蓝或宝宝粉，永久赞助者使用专属金色。","status":"available","action":"color","sort_order":20},{"id":"lottery","title":"赞助者抽奖","description":"敬请期待，当前尚未开放。","status":"coming_soon","action":"none","sort_order":30},{"id":"more","title":"更多权益","description":"更多赞助者权益正在筹备。","status":"coming_soon","action":"none","sort_order":40}]}');

-- Prices, durations and purchase mappings exist only in this backend seed.
INSERT OR IGNORE INTO sponsor_plans(id,version,enabled,sort_order,plan_json)
SELECT id,1,1,sort_order,json_object('id',id,'version',1,'name',name,'description',description,'price_minor',price,'currency','CNY','duration_unit',unit,'duration_count',duration,'purchase_url',
'https://ifdian.net/order/create?product_type=1&plan_id=6d5249c2adcf11f1b96d52540025c377&sku=%5B%7B%22sku_id%22%3A%22'||sku||'%22,%22count%22%3A1%7D%5D&viokrz_ex=0',
'afdian_plan_id','6d5249c2adcf11f1b96d52540025c377','afdian_sku_id',sku,'enabled',json('true'),'sort_order',sort_order)
FROM (
  SELECT 'week' id,'周赞助者' name,'7 天赞助者身份' description,190 price,'day' unit,7 duration,10 sort_order,'6d5b2998adcf11f1982752540025c377' sku
  UNION ALL SELECT 'month','月赞助者','1 个自然月赞助者身份',590,'month',1,20,'6d62f682adcf11f1b25152540025c377'
  UNION ALL SELECT 'quarter','季赞助者','3 个自然月赞助者身份',1490,'month',3,30,'6d6ae388adcf11f18ab552540025c377'
  UNION ALL SELECT 'year','年赞助者','12 个自然月赞助者身份',4990,'month',12,40,'6d72faf0adcf11f186ae52540025c377'
  UNION ALL SELECT 'permanent','永久赞助者','永久赞助者身份',9900,'permanent',0,50,'6d7a8dd8adcf11f18eea52540025c377'
);

-- The view is evaluated inside mutation transactions, including the response snapshot.
-- Refresh derived rules on replay without overwriting settings, memberships or history.
DROP VIEW IF EXISTS sponsor_me_json;
DROP VIEW IF EXISTS sponsor_user_state;
CREATE VIEW sponsor_user_state AS
SELECT u.id AS user_id,
  CASE WHEN m.permanent=1 OR m.expires_at>unixepoch() THEN 1 ELSE 0 END AS active,
  COALESCE(m.permanent,0) AS permanent, m.expires_at, m.plan_name,
  CASE WHEN m.permanent=1 THEN
    (SELECT json_extract(value,'$.key') FROM json_each(s.config_json,'$.colors') WHERE json_extract(value,'$.permanent_only')=1 ORDER BY CAST(key AS INTEGER) LIMIT 1)
    WHEN m.expires_at>unixepoch() THEN COALESCE(
      (SELECT json_extract(value,'$.key') FROM json_each(s.config_json,'$.colors') WHERE json_extract(value,'$.key')=m.color_key AND json_extract(value,'$.permanent_only')=0),
      json_extract(s.config_json,'$.default_color_key')) END AS color_key,
  s.config_json, s.version AS config_version,
  date('now','+8 hours') AS day_key,
  unixepoch(date('now','+8 hours','+1 day'),'-8 hours') AS resets_at,
  COALESCE(d.used,0) AS used,
  MAX(0,CASE WHEN m.permanent=1 OR m.expires_at>unixepoch() THEN json_extract(s.config_json,'$.sponsor_daily_limit') ELSE json_extract(s.config_json,'$.free_daily_limit') END+COALESCE(d.bonus,0)) AS quota_limit
FROM users u CROSS JOIN sponsor_settings s
LEFT JOIN sponsor_memberships m ON m.user_id=u.id
LEFT JOIN sponsor_daily_usage d ON d.user_id=u.id AND d.day_key=date('now','+8 hours')
WHERE s.id=1;
CREATE VIEW IF NOT EXISTS sponsor_me_json AS
SELECT v.user_id, json_object(
  'sponsor',json_object('active',json(CASE WHEN active=1 THEN 'true' ELSE 'false' END),'permanent',json(CASE WHEN permanent=1 THEN 'true' ELSE 'false' END),
  'expires_at',CASE WHEN permanent=1 THEN NULL ELSE expires_at END,'plan_name',plan_name,
  'color_key',(SELECT json_extract(value,'$.key') FROM json_each(config_json,'$.colors') WHERE json_extract(value,'$.key')=color_key AND active=1 AND (permanent=1 OR json_extract(value,'$.permanent_only')=0)),
  'color_light',(SELECT json_extract(value,'$.light') FROM json_each(config_json,'$.colors') WHERE json_extract(value,'$.key')=color_key AND active=1 AND (permanent=1 OR json_extract(value,'$.permanent_only')=0)),
  'color_dark',(SELECT json_extract(value,'$.dark') FROM json_each(config_json,'$.colors') WHERE json_extract(value,'$.key')=color_key AND active=1 AND (permanent=1 OR json_extract(value,'$.permanent_only')=0))),
  'quota',json_object('limit',quota_limit,'used',used,'remaining',MAX(0,quota_limit-used),'resets_at',resets_at,'day_key',day_key),
  'notice_required',json(CASE WHEN active=0 AND NOT EXISTS(SELECT 1 FROM sponsor_notice_acks a WHERE a.user_id=v.user_id AND a.notice_version=json_extract(config_json,'$.notice_version')) THEN 'true' ELSE 'false' END),
  'config_version',config_version,
  'claimed_benefit_ids',json((SELECT json_group_array(benefit_id) FROM (SELECT benefit_id FROM sponsor_claims WHERE user_id=v.user_id ORDER BY benefit_id)))
) AS result_json FROM sponsor_user_state v;

DROP TRIGGER IF EXISTS sponsor_operation_validate;
CREATE TRIGGER sponsor_operation_validate BEFORE INSERT ON sponsor_operations
WHEN NOT EXISTS (SELECT 1 FROM sponsor_operations WHERE id=NEW.id)
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM sponsor_settings WHERE id=1) THEN RAISE(ABORT,'sponsors_unavailable') END;
  SELECT CASE WHEN NEW.kind NOT IN ('revoke','quota') AND (SELECT json_extract(config_json,'$.enabled') FROM sponsor_settings WHERE id=1)!=1 THEN RAISE(ABORT,'sponsors_disabled') END;
  SELECT CASE WHEN NEW.day_key!=date('now','+8 hours') OR ABS(NEW.created_at-unixepoch())>60 THEN RAISE(ABORT,'operation_expired') END;
  SELECT CASE WHEN NEW.kind IN ('redeem','grant') AND EXISTS(SELECT 1 FROM sponsor_memberships WHERE user_id=NEW.user_id AND permanent=1) THEN RAISE(ABORT,'already_permanent') END;
  SELECT CASE WHEN NEW.kind='redeem' AND NOT EXISTS(SELECT 1 FROM sponsor_codes WHERE id=NEW.code_id AND disabled=0 AND redeemed_at IS NULL AND (expires_at IS NULL OR expires_at>unixepoch()) AND snapshot_json=NEW.plan_json) THEN RAISE(ABORT,'code_unavailable') END;
  SELECT CASE WHEN NEW.kind='grant' AND NOT EXISTS(SELECT 1 FROM sponsor_plans WHERE id=json_extract(NEW.plan_json,'$.id') AND enabled=1 AND plan_json=NEW.plan_json) THEN RAISE(ABORT,'plan_changed') END;
  SELECT CASE WHEN NEW.kind IN ('color','claim') AND NOT EXISTS(SELECT 1 FROM sponsor_user_state WHERE user_id=NEW.user_id AND active=1) THEN RAISE(ABORT,'sponsor_required') END;
  SELECT CASE WHEN NEW.kind='color' AND NOT EXISTS(SELECT 1 FROM sponsor_user_state v,json_each(v.config_json,'$.colors') c WHERE user_id=NEW.user_id AND json_extract(c.value,'$.key')=NEW.color_key AND json_extract(c.value,'$.permanent_only')=permanent AND (permanent=0 OR NEW.color_key=v.color_key)) THEN RAISE(ABORT,'invalid_color') END;
  SELECT CASE WHEN NEW.kind='claim' AND NOT EXISTS(SELECT 1 FROM sponsor_settings s,json_each(s.config_json,'$.benefits') b WHERE json_extract(b.value,'$.id')=NEW.benefit_id AND json_extract(b.value,'$.status')='available' AND json_extract(b.value,'$.action')='claim') THEN RAISE(ABORT,'benefit_unavailable') END;
  SELECT CASE WHEN NEW.kind='original' AND EXISTS(SELECT 1 FROM sponsor_user_state v WHERE user_id=NEW.user_id AND active=0 AND NOT EXISTS(SELECT 1 FROM sponsor_notice_acks a WHERE a.user_id=NEW.user_id AND a.notice_version=json_extract(v.config_json,'$.notice_version')) AND (NEW.notice_version IS NULL OR NEW.notice_version!=json_extract(v.config_json,'$.notice_version'))) THEN RAISE(ABORT,'notice_required') END;
  SELECT CASE WHEN NEW.kind='original' AND EXISTS(SELECT 1 FROM sponsor_user_state WHERE user_id=NEW.user_id AND used>=quota_limit) THEN RAISE(ABORT,'quota_exhausted') END;
  SELECT CASE WHEN NEW.kind='quota' AND (NEW.adjustment IS NULL OR ABS(NEW.adjustment)>100000 OR ABS(COALESCE((SELECT bonus FROM sponsor_daily_usage WHERE user_id=NEW.user_id AND day_key=NEW.day_key),0)+NEW.adjustment)>100000) THEN RAISE(ABORT,'invalid_adjustment') END;
END;

CREATE TRIGGER IF NOT EXISTS sponsor_operation_apply AFTER INSERT ON sponsor_operations
BEGIN
  INSERT INTO sponsor_memberships(user_id) VALUES(NEW.user_id) ON CONFLICT(user_id) DO NOTHING;
  -- Read the latest expiry under SQLite's write transaction. Calendar months clamp to
  -- the target month's last day in Asia/Shanghai, retaining the time of day.
  UPDATE sponsor_memberships SET
    expires_at=CASE WHEN json_extract(NEW.plan_json,'$.duration_unit')='permanent' THEN NULL ELSE (
      WITH base AS (SELECT MAX(COALESCE(expires_at,0),NEW.created_at) AS ts),
      duration AS (SELECT json_extract(NEW.plan_json,'$.duration_count') AS n),
      target AS (SELECT datetime(ts,'unixepoch','+8 hours') AS local, date(ts,'unixepoch','+8 hours','start of month','+'||n||' months') AS month_start FROM base,duration)
      SELECT CASE WHEN json_extract(NEW.plan_json,'$.duration_unit')='day' THEN ts+n*86400 ELSE
        unixepoch(month_start,'+'||(MIN(CAST(strftime('%d',local) AS INTEGER),CAST(strftime('%d',month_start,'+1 month','-1 day') AS INTEGER))-1)||' days',strftime('%H hours',local),strftime('%M minutes',local),strftime('%S seconds',local),'-8 hours') END
      FROM base,duration,target
    ) END,
    permanent=CASE WHEN json_extract(NEW.plan_json,'$.duration_unit')='permanent' THEN 1 ELSE 0 END,
    plan_name=json_extract(NEW.plan_json,'$.name'),updated_at=NEW.created_at
    WHERE user_id=NEW.user_id AND NEW.kind IN ('redeem','grant');
  UPDATE sponsor_codes SET redeemed_at=NEW.created_at,redeemed_by=NEW.user_id,operation_id=NEW.id WHERE id=NEW.code_id AND NEW.kind='redeem';
  INSERT INTO sponsor_redemptions(id,user_id,plan_name,redeemed_at,expires_at,permanent)
    SELECT NEW.id,user_id,plan_name,NEW.created_at,expires_at,permanent FROM sponsor_memberships WHERE user_id=NEW.user_id AND NEW.kind IN ('redeem','grant');
  UPDATE sponsor_memberships SET permanent=0,expires_at=NULL,plan_name=NULL,color_key=NULL,updated_at=NEW.created_at WHERE user_id=NEW.user_id AND NEW.kind='revoke';
  UPDATE sponsor_memberships SET color_key=NEW.color_key,updated_at=NEW.created_at WHERE user_id=NEW.user_id AND NEW.kind='color';
  INSERT INTO sponsor_claims(user_id,benefit_id,operation_id) SELECT NEW.user_id,NEW.benefit_id,NEW.id WHERE NEW.kind='claim' ON CONFLICT(user_id,benefit_id) DO NOTHING;
  INSERT INTO sponsor_daily_usage(user_id,day_key,used,bonus)
    SELECT NEW.user_id,NEW.day_key,
      CASE WHEN NEW.kind='original' THEN 1 ELSE 0 END,
      CASE WHEN NEW.kind='quota' THEN COALESCE(NEW.adjustment,0) ELSE 0 END
    WHERE NEW.kind IN ('original','quota')
    ON CONFLICT(user_id,day_key) DO UPDATE SET used=used+excluded.used,bonus=bonus+excluded.bonus;
  INSERT INTO sponsor_notice_acks(user_id,notice_version)
    SELECT NEW.user_id,json_extract(config_json,'$.notice_version') FROM sponsor_user_state WHERE user_id=NEW.user_id AND active=0 AND NEW.kind='original'
    ON CONFLICT(user_id,notice_version) DO NOTHING;
  INSERT INTO sponsor_audit(id,actor_id,user_id,action,reason) VALUES(NEW.id,NEW.actor_id,CAST(NEW.user_id AS TEXT),NEW.kind,NEW.reason);
  UPDATE sponsor_operations SET result_json=(SELECT result_json FROM sponsor_me_json WHERE user_id=NEW.user_id) WHERE id=NEW.id;
END;

-- Baby albums isolated private storage (migration 0071)
-- Isolated private album storage; never changes media_uploads or existing post assets.
-- Replay-safe and also included verbatim in the fresh-database schema tail.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS albums (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  visibility TEXT NOT NULL CHECK(visibility IN ('public','private','shared')),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER,
  UNIQUE(id,owner_id),
  CHECK(is_default=0 OR (name='宝宝相册' AND visibility='private' AND deleted_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS albums_one_default ON albums(owner_id) WHERE is_default=1;
CREATE INDEX IF NOT EXISTS albums_owner_list ON albums(owner_id,deleted_at,created_at DESC,id);
CREATE TABLE IF NOT EXISTS album_storage (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  used_bytes INTEGER NOT NULL DEFAULT 0 CHECK(used_bytes>=0),
  reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0)
);
CREATE TABLE IF NOT EXISTS album_members (
  album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(album_id,user_id)
);
CREATE TABLE IF NOT EXISTS album_invites (
  album_id TEXT PRIMARY KEY REFERENCES albums(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS album_batches (
  id TEXT PRIMARY KEY NOT NULL,
  album_id TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '' CHECK(length(description)<=3000),
  captured_at INTEGER,
  quality TEXT NOT NULL CHECK(quality IN ('hd','original')),
  photo_count INTEGER NOT NULL CHECK(photo_count BETWEEN 1 AND 20),
  reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes>0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','published','cancelled')),
  post_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
  source_post_image_id INTEGER,
  source_upload_id TEXT,
  uploaded_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  published_at INTEGER,
  UNIQUE(owner_id,operation_id),
  UNIQUE(id,album_id,owner_id),
  FOREIGN KEY(album_id,owner_id) REFERENCES albums(id,owner_id)
);
CREATE INDEX IF NOT EXISTS album_batches_owner_pending ON album_batches(owner_id,status,expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS album_history_active_reservation ON album_batches(source_post_image_id) WHERE source_post_image_id IS NOT NULL AND status!='cancelled';
CREATE TABLE IF NOT EXISTS album_uploads (
  id TEXT PRIMARY KEY NOT NULL,
  batch_id TEXT NOT NULL,
  album_id TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  photo_id TEXT NOT NULL,
  client_id TEXT NOT NULL CHECK(length(client_id) BETWEEN 1 AND 80),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order BETWEEN 0 AND 19),
  kind TEXT NOT NULL CHECK(kind IN ('preview','hd','original')),
  object_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL CHECK(mime_type IN ('image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif')),
  declared_size INTEGER NOT NULL CHECK(declared_size>0),
  content_md5 TEXT NOT NULL,
  width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 100000),
  height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 100000),
  variant_width INTEGER CHECK(variant_width BETWEEN 1 AND 100000),
  variant_height INTEGER CHECK(variant_height BETWEEN 1 AND 100000),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','complete')),
  verified_size INTEGER,
  expires_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE(batch_id,client_id,kind),
  UNIQUE(photo_id,kind),
  FOREIGN KEY(batch_id,album_id,owner_id) REFERENCES album_batches(id,album_id,owner_id),
  CHECK((kind='preview' AND declared_size<=2097152 AND mime_type IN ('image/jpeg','image/webp') AND (variant_width IS NULL OR variant_width<=540) AND (variant_height IS NULL OR variant_height<=540))
     OR (kind='hd' AND declared_size<=10485760 AND mime_type IN ('image/jpeg','image/png','image/webp','image/gif'))
     OR (kind='original' AND declared_size<20971520)),
  CHECK(status!='complete' OR verified_size=declared_size),
  CHECK(object_key GLOB 'albums/'||owner_id||'/*' AND instr(object_key,'..')=0)
);
CREATE INDEX IF NOT EXISTS album_uploads_batch ON album_uploads(batch_id,photo_id,kind);
CREATE TABLE IF NOT EXISTS album_photos (
  id TEXT PRIMARY KEY NOT NULL,
  album_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order BETWEEN 0 AND 19),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description)<=3000),
  captured_at INTEGER,
  uploaded_at INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  preview_key TEXT NOT NULL UNIQUE,
  hd_key TEXT NOT NULL UNIQUE,
  original_key TEXT UNIQUE,
  preview_bytes INTEGER NOT NULL CHECK(preview_bytes>0),
  hd_bytes INTEGER NOT NULL CHECK(hd_bytes>0),
  original_bytes INTEGER NOT NULL DEFAULT 0 CHECK(original_bytes>=0),
  source_post_image_id INTEGER UNIQUE,
  source_upload_id TEXT,
  deleted_at INTEGER,
  FOREIGN KEY(batch_id,album_id,owner_id) REFERENCES album_batches(id,album_id,owner_id),
  CHECK(preview_key!=hd_key AND (original_key IS NULL OR (original_key!=preview_key AND original_key!=hd_key))),
  CHECK((original_key IS NULL AND original_bytes=0) OR (original_key IS NOT NULL AND original_bytes>0))
);
CREATE INDEX IF NOT EXISTS album_photos_sort ON album_photos(album_id,deleted_at,coalesce(captured_at,uploaded_at) DESC,uploaded_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS album_likes (
  photo_id TEXT NOT NULL REFERENCES album_photos(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(photo_id,user_id)
);
CREATE TABLE IF NOT EXISTS album_comments (
  id TEXT PRIMARY KEY NOT NULL,
  photo_id TEXT NOT NULL REFERENCES album_photos(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 2000),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER,
  UNIQUE(user_id,operation_id)
);
CREATE INDEX IF NOT EXISTS album_comments_photo ON album_comments(photo_id,deleted_at,created_at,id);
-- No source FK: deleting the old post must not delete a private imported copy or retry evidence.
CREATE TABLE IF NOT EXISTS album_history_attempts (
  owner_id INTEGER NOT NULL,
  source_post_image_id INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('skipped','retry')),
  reason TEXT NOT NULL,
  retry_at INTEGER NOT NULL,
  attempted_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id,source_post_image_id)
);
CREATE TABLE IF NOT EXISTS album_rate_limits (
  bucket TEXT PRIMARY KEY NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK(count>=0)
);
CREATE TABLE IF NOT EXISTS album_transaction_guards (id INTEGER PRIMARY KEY CHECK(id=1));
-- Bytes are released only after a successful fixed-host COS DELETE (including 404).
CREATE TABLE IF NOT EXISTS album_object_cleanup (
  object_key TEXT PRIMARY KEY NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  bytes INTEGER NOT NULL CHECK(bytes>0),
  charge_bucket TEXT NOT NULL CHECK(charge_bucket IN ('used','reserved')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','cleaned')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  cleaned_at INTEGER
);
CREATE INDEX IF NOT EXISTS album_cleanup_pending ON album_object_cleanup(owner_id,status,created_at);

-- Latest ACTUAL grant/redeem snapshot, never user badges, client plan names, catalog edits
-- or the total accumulated expiry. Active legacy memberships without a snapshot use WEEK
-- (5 GiB), a conservative fallback; inactive memberships always return FREE (3 GiB).
CREATE VIEW IF NOT EXISTS album_storage_entitlements AS
WITH latest AS (
  SELECT u.id AS user_id,m.permanent,m.expires_at,
    (SELECT o.plan_json FROM sponsor_operations o WHERE o.user_id=u.id AND o.kind IN ('grant','redeem') AND json_valid(o.plan_json)
      ORDER BY o.created_at DESC,o.rowid DESC LIMIT 1) AS plan_json
  FROM users u LEFT JOIN sponsor_memberships m ON m.user_id=u.id
), tiers AS (
  SELECT user_id,CASE WHEN permanent=1 OR expires_at>unixepoch() THEN 1 ELSE 0 END AS sponsor_active,
    CASE WHEN permanent=1 THEN 'permanent'
      WHEN coalesce(expires_at,0)<=unixepoch() THEN 'free'
      WHEN (json_extract(plan_json,'$.duration_unit')='month' AND json_extract(plan_json,'$.duration_count')>=12)
        OR (json_extract(plan_json,'$.duration_unit')='day' AND json_extract(plan_json,'$.duration_count')>=365) THEN 'year'
      WHEN (json_extract(plan_json,'$.duration_unit')='month' AND json_extract(plan_json,'$.duration_count')>=3)
        OR (json_extract(plan_json,'$.duration_unit')='day' AND json_extract(plan_json,'$.duration_count')>=90) THEN 'quarter'
      WHEN (json_extract(plan_json,'$.duration_unit')='month' AND json_extract(plan_json,'$.duration_count')>=1)
        OR (json_extract(plan_json,'$.duration_unit')='day' AND json_extract(plan_json,'$.duration_count')>=30) THEN 'month'
      ELSE 'week' END AS tier FROM latest
)
SELECT t.user_id,t.tier,t.sponsor_active,
  (CASE tier WHEN 'permanent' THEN 100 WHEN 'year' THEN 50 WHEN 'quarter' THEN 20 WHEN 'month' THEN 10 WHEN 'week' THEN 5 ELSE 3 END)*1073741824 AS limit_bytes,
  coalesce(s.used_bytes,0) AS used_bytes,coalesce(s.reserved_bytes,0) AS reserved_bytes
FROM tiers t LEFT JOIN album_storage s ON s.user_id=t.user_id;

CREATE TRIGGER IF NOT EXISTS album_default_immutable BEFORE UPDATE ON albums
WHEN OLD.is_default=1 AND (NEW.is_default!=1 OR NEW.owner_id!=OLD.owner_id OR NEW.name!='宝宝相册' OR NEW.visibility!='private' OR NEW.deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'default_album_immutable'); END;
CREATE TRIGGER IF NOT EXISTS album_owner_immutable BEFORE UPDATE OF owner_id,is_default ON albums
WHEN NEW.owner_id!=OLD.owner_id OR NEW.is_default!=OLD.is_default
BEGIN SELECT RAISE(ABORT,'album_owner_immutable'); END;
CREATE TRIGGER IF NOT EXISTS album_default_no_delete BEFORE DELETE ON albums WHEN OLD.is_default=1
BEGIN SELECT RAISE(ABORT,'default_album_immutable'); END;
CREATE TRIGGER IF NOT EXISTS album_batch_reserve_validate BEFORE INSERT ON album_batches
WHEN NOT EXISTS(SELECT 1 FROM album_batches WHERE owner_id=NEW.owner_id AND operation_id=NEW.operation_id)
BEGIN
  SELECT CASE WHEN NEW.status!='pending' THEN RAISE(ABORT,'album_batch_invalid') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM albums a JOIN users u ON u.id=a.owner_id WHERE a.id=NEW.album_id AND a.owner_id=NEW.owner_id AND a.deleted_at IS NULL) THEN RAISE(ABORT,'album_forbidden') END;
  SELECT CASE WHEN NEW.expires_at<=unixepoch() THEN RAISE(ABORT,'album_batch_expired') END;
  SELECT CASE WHEN (SELECT count(*) FROM album_batches WHERE owner_id=NEW.owner_id AND status='pending' AND expires_at>unixepoch())>=5 THEN RAISE(ABORT,'album_pending_limit') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM album_storage_entitlements WHERE user_id=NEW.owner_id AND used_bytes+reserved_bytes+NEW.reserved_bytes<=limit_bytes) THEN RAISE(ABORT,'album_storage_full') END;
  SELECT CASE WHEN NEW.quality='original' AND NOT EXISTS(SELECT 1 FROM album_storage_entitlements WHERE user_id=NEW.owner_id AND sponsor_active=1) THEN RAISE(ABORT,'album_sponsor_required') END;
END;
CREATE TRIGGER IF NOT EXISTS album_batch_reserve_apply AFTER INSERT ON album_batches
BEGIN
  INSERT INTO album_storage(user_id,reserved_bytes) VALUES(NEW.owner_id,NEW.reserved_bytes)
    ON CONFLICT(user_id) DO UPDATE SET reserved_bytes=reserved_bytes+NEW.reserved_bytes;
END;
CREATE TRIGGER IF NOT EXISTS album_upload_insert_validate BEFORE INSERT ON album_uploads
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM album_batches WHERE id=NEW.batch_id AND album_id=NEW.album_id AND owner_id=NEW.owner_id AND status='pending' AND expires_at>unixepoch()) THEN RAISE(ABORT,'album_batch_expired') END;
  SELECT CASE WHEN NEW.kind='original' AND NOT EXISTS(SELECT 1 FROM album_batches WHERE id=NEW.batch_id AND quality='original') THEN RAISE(ABORT,'album_batch_invalid') END;
END;
CREATE TRIGGER IF NOT EXISTS album_upload_complete_validate BEFORE UPDATE OF status ON album_uploads
WHEN NEW.status='complete' AND OLD.status!='complete'
BEGIN
  SELECT CASE WHEN NEW.verified_size IS NULL OR NEW.verified_size!=OLD.declared_size THEN RAISE(ABORT,'album_upload_mismatch') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM album_batches b JOIN albums a ON a.id=b.album_id AND a.owner_id=b.owner_id WHERE b.id=OLD.batch_id AND b.owner_id=OLD.owner_id AND b.status='pending' AND b.expires_at>unixepoch() AND a.deleted_at IS NULL AND OLD.expires_at>unixepoch()) THEN RAISE(ABORT,'album_batch_expired') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM album_batches WHERE id=OLD.batch_id AND quality='original') AND NOT EXISTS(SELECT 1 FROM album_storage_entitlements WHERE user_id=OLD.owner_id AND sponsor_active=1) THEN RAISE(ABORT,'album_sponsor_required') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM album_storage_entitlements WHERE user_id=OLD.owner_id AND used_bytes+reserved_bytes<=limit_bytes) THEN RAISE(ABORT,'album_storage_full') END;
END;
CREATE TRIGGER IF NOT EXISTS album_batch_publish_validate BEFORE UPDATE OF status ON album_batches
WHEN NEW.status='published' AND OLD.status!='published'
BEGIN
  SELECT CASE WHEN OLD.status!='pending' OR OLD.expires_at<=unixepoch() THEN RAISE(ABORT,'album_batch_expired') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM albums WHERE id=OLD.album_id AND owner_id=OLD.owner_id AND deleted_at IS NULL) THEN RAISE(ABORT,'album_forbidden') END;
  SELECT CASE WHEN OLD.quality='original' AND NOT EXISTS(SELECT 1 FROM album_storage_entitlements WHERE user_id=OLD.owner_id AND sponsor_active=1) THEN RAISE(ABORT,'album_sponsor_required') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM album_storage_entitlements WHERE user_id=OLD.owner_id AND used_bytes+reserved_bytes<=limit_bytes AND reserved_bytes>=OLD.reserved_bytes) THEN RAISE(ABORT,'album_storage_full') END;
  SELECT CASE WHEN (SELECT count(*) FROM album_uploads WHERE batch_id=OLD.id)!=(OLD.photo_count*CASE OLD.quality WHEN 'original' THEN 3 ELSE 2 END)
    OR (SELECT count(DISTINCT photo_id) FROM album_uploads WHERE batch_id=OLD.id)!=OLD.photo_count
    OR EXISTS(SELECT 1 FROM album_uploads WHERE batch_id=OLD.id AND (status!='complete' OR verified_size IS NULL OR verified_size!=declared_size))
    OR (SELECT sum(verified_size) FROM album_uploads WHERE batch_id=OLD.id)!=OLD.reserved_bytes
    OR EXISTS(SELECT 1 FROM album_uploads WHERE batch_id=OLD.id GROUP BY photo_id HAVING count(DISTINCT client_id)!=1 OR count(DISTINCT width)!=1 OR count(DISTINCT height)!=1 OR count(DISTINCT kind)!=(CASE OLD.quality WHEN 'original' THEN 3 ELSE 2 END))
    THEN RAISE(ABORT,'album_batch_incomplete') END;
END;
CREATE TRIGGER IF NOT EXISTS album_batch_publish_apply AFTER UPDATE OF status ON album_batches
WHEN NEW.status='published' AND OLD.status='pending'
BEGIN
  INSERT INTO album_photos(id,album_id,batch_id,owner_id,client_id,sort_order,description,captured_at,uploaded_at,width,height,preview_key,hd_key,original_key,preview_bytes,hd_bytes,original_bytes,source_post_image_id,source_upload_id)
    SELECT photo_id,NEW.album_id,NEW.id,NEW.owner_id,min(client_id),min(sort_order),NEW.description,NEW.captured_at,coalesce(NEW.uploaded_at,unixepoch()),min(width),min(height),
      max(CASE kind WHEN 'preview' THEN object_key END),max(CASE kind WHEN 'hd' THEN object_key END),max(CASE kind WHEN 'original' THEN object_key END),
      sum(CASE kind WHEN 'preview' THEN verified_size ELSE 0 END),sum(CASE kind WHEN 'hd' THEN verified_size ELSE 0 END),sum(CASE kind WHEN 'original' THEN verified_size ELSE 0 END),NEW.source_post_image_id,NEW.source_upload_id
    FROM album_uploads WHERE batch_id=NEW.id GROUP BY photo_id;
  UPDATE album_storage SET used_bytes=used_bytes+NEW.reserved_bytes,reserved_bytes=reserved_bytes-NEW.reserved_bytes WHERE user_id=NEW.owner_id;
  -- Public publication is an ORDINARY fallback post. Never insert post_images or metadata content.
  INSERT INTO posts(user_id,content,visibility)
    SELECT NEW.owner_id,'【宝宝相册】当前渠道不支持查看此内容，请下载最新版ABDL Space APP查看详情','public'
      FROM albums WHERE id=NEW.album_id AND visibility='public' AND deleted_at IS NULL;
  UPDATE album_batches SET post_id=CASE WHEN (SELECT visibility FROM albums WHERE id=NEW.album_id)='public' THEN last_insert_rowid() ELSE NULL END,published_at=unixepoch() WHERE id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS album_batch_cancel_apply AFTER UPDATE OF status ON album_batches
WHEN NEW.status='cancelled' AND OLD.status='pending'
BEGIN
  INSERT OR IGNORE INTO album_object_cleanup(object_key,owner_id,bytes,charge_bucket)
    SELECT object_key,owner_id,declared_size,'reserved' FROM album_uploads WHERE batch_id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS album_photo_delete_apply AFTER UPDATE OF deleted_at ON album_photos
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO album_object_cleanup(object_key,owner_id,bytes,charge_bucket) VALUES(OLD.preview_key,OLD.owner_id,OLD.preview_bytes,'used');
  INSERT OR IGNORE INTO album_object_cleanup(object_key,owner_id,bytes,charge_bucket) VALUES(OLD.hd_key,OLD.owner_id,OLD.hd_bytes,'used');
  INSERT OR IGNORE INTO album_object_cleanup(object_key,owner_id,bytes,charge_bucket)
    SELECT OLD.original_key,OLD.owner_id,OLD.original_bytes,'used' WHERE OLD.original_key IS NOT NULL;
END;
CREATE TRIGGER IF NOT EXISTS album_delete_apply AFTER UPDATE OF deleted_at ON albums
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
BEGIN
  UPDATE album_photos SET deleted_at=NEW.deleted_at WHERE album_id=NEW.id AND deleted_at IS NULL;
  UPDATE album_batches SET status='cancelled' WHERE album_id=NEW.id AND status='pending';
  DELETE FROM album_invites WHERE album_id=NEW.id;
  DELETE FROM album_members WHERE album_id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS album_cleanup_release AFTER UPDATE OF status ON album_object_cleanup
WHEN OLD.status='pending' AND NEW.status='cleaned'
BEGIN
  UPDATE album_storage SET used_bytes=used_bytes-CASE NEW.charge_bucket WHEN 'used' THEN NEW.bytes ELSE 0 END,
    reserved_bytes=reserved_bytes-CASE NEW.charge_bucket WHEN 'reserved' THEN NEW.bytes ELSE 0 END WHERE user_id=NEW.owner_id;
END;
CREATE TRIGGER IF NOT EXISTS album_visibility_revoke AFTER UPDATE OF visibility ON albums
WHEN NEW.visibility!='shared'
BEGIN DELETE FROM album_invites WHERE album_id=NEW.id; DELETE FROM album_members WHERE album_id=NEW.id; END;

-- Additive album protection storage; keep replay-safe migration 0071 unchanged.
-- A missing row is unprotected; a missing table is feature unavailability, never false.
CREATE TABLE IF NOT EXISTS album_protection (
  album_id TEXT PRIMARY KEY REFERENCES albums(id) ON DELETE CASCADE,
  download_protected INTEGER NOT NULL DEFAULT 0 CHECK(download_protected IN (0,1))
);

-- Attempt-bound authorization ledger. Retains original sponsor operations and audited
-- compensations; pending retries cannot obtain a URL or refund a completed authorization.
CREATE TABLE IF NOT EXISTS album_photo_authorizations (
  operation_id TEXT PRIMARY KEY REFERENCES sponsor_operations(id),
  attempt_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  media_key TEXT NOT NULL,
  day_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','authorized','refunded')),
  failure_code TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  finalized_at INTEGER
);
CREATE TRIGGER IF NOT EXISTS album_photo_authorization_validate BEFORE INSERT ON album_photo_authorizations
BEGIN
  SELECT CASE WHEN NEW.status!='pending' OR NOT EXISTS(SELECT 1 FROM sponsor_operations o
    WHERE o.id=NEW.operation_id AND o.kind='original' AND o.user_id=NEW.user_id
    AND o.actor_id=CAST(NEW.user_id AS TEXT) AND o.media_key=NEW.media_key AND o.day_key=NEW.day_key
    AND o.day_key=date('now','+8 hours')) THEN RAISE(ABORT,'album_authorization_invalid') END;
END;
CREATE TRIGGER IF NOT EXISTS album_photo_authorization_transition BEFORE UPDATE ON album_photo_authorizations
BEGIN
  SELECT CASE WHEN NEW.operation_id!=OLD.operation_id OR NEW.attempt_id!=OLD.attempt_id
    OR NEW.user_id!=OLD.user_id OR NEW.media_key!=OLD.media_key OR NEW.day_key!=OLD.day_key
    OR OLD.status!='pending' OR NEW.status NOT IN ('authorized','refunded')
    OR NEW.finalized_at IS NULL THEN RAISE(ABORT,'album_authorization_invalid') END;
  SELECT CASE WHEN NEW.status='refunded' AND (NEW.failure_code IS NULL OR NOT EXISTS(
    SELECT 1 FROM sponsor_operations o JOIN sponsor_daily_usage usage ON usage.user_id=o.user_id AND usage.day_key=o.day_key
    WHERE o.id=OLD.operation_id AND o.kind='original' AND o.user_id=OLD.user_id
      AND o.actor_id=CAST(OLD.user_id AS TEXT) AND o.media_key=OLD.media_key AND o.day_key=OLD.day_key AND usage.used>=1))
    THEN RAISE(ABORT,'album_authorization_invalid') END;
END;
CREATE TRIGGER IF NOT EXISTS album_photo_authorization_refund AFTER UPDATE OF status ON album_photo_authorizations
WHEN OLD.status='pending' AND NEW.status='refunded'
BEGIN
  -- Refund only the operation's charged Shanghai day, never unrelated current-day usage.
  UPDATE sponsor_daily_usage SET used=used-1 WHERE user_id=OLD.user_id AND day_key=OLD.day_key AND used>=1;
END;

-- Additive album report moderation storage; keep replay-safe migrations 0071/0072 unchanged.
-- A missing table is feature unavailability (503), never an empty moderation state.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS album_reports (
  id TEXT PRIMARY KEY NOT NULL,
  album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK(reason IN ('spam','nsfw','minor','copyright','other')),
  detail TEXT CHECK(detail IS NULL OR length(detail)<=2000),
  operation_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  resolved_at INTEGER,
  resolved_by INTEGER REFERENCES users(id),
  CHECK(status!='resolved' OR (resolved_at IS NOT NULL AND resolved_by IS NOT NULL))
);
-- At most one open report per reporter and album; resolved reports never block a fresh one.
CREATE UNIQUE INDEX IF NOT EXISTS album_reports_one_open ON album_reports(album_id,reporter_id) WHERE status='open';
CREATE INDEX IF NOT EXISTS album_reports_status_list ON album_reports(status,created_at DESC,id);
CREATE INDEX IF NOT EXISTS album_reports_album ON album_reports(album_id,reporter_id);

-- Admin violation blocks are a desired-state overlay: photos stay stored, only display is replaced.
CREATE TABLE IF NOT EXISTS album_photo_blocks (
  album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  photo_id TEXT NOT NULL REFERENCES album_photos(id) ON DELETE CASCADE,
  blocked_at INTEGER NOT NULL DEFAULT (unixepoch()),
  admin_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY(album_id,photo_id)
);
CREATE INDEX IF NOT EXISTS album_photo_blocks_admin ON album_photo_blocks(admin_id,blocked_at);
