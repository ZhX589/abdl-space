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
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (diaper_id) REFERENCES diapers(id)
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
