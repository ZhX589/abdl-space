-- ABDL Space Wiki - D1 数据库表结构

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,       -- PBKDF2 hash: iterations$salt$derivedKey
  username TEXT UNIQUE NOT NULL,
  avatar_url TEXT,
  email_verified BOOLEAN DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Wiki 页面表
CREATE TABLE IF NOT EXISTS wiki_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,          -- URL 友好标识，如 "diaper-brand-x"
  title TEXT NOT NULL,
  content TEXT NOT NULL,              -- Markdown 格式
  author_id INTEGER,
  version INTEGER DEFAULT 1,
  is_published BOOLEAN DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (author_id) REFERENCES users(id)
);

-- 页面版本历史（支持共建和回滚）
CREATE TABLE IF NOT EXISTS page_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  version INTEGER NOT NULL,
  author_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (page_id) REFERENCES wiki_pages(id),
  FOREIGN KEY (author_id) REFERENCES users(id)
);

-- 评论表
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL,
  author_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  parent_id INTEGER,                  -- 支持嵌套回复，NULL 为顶层评论
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (page_id) REFERENCES wiki_pages(id),
  FOREIGN KEY (author_id) REFERENCES users(id),
  FOREIGN KEY (parent_id) REFERENCES comments(id)
);

-- 评分表（1-5 星）
CREATE TABLE IF NOT EXISTS ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  score INTEGER CHECK (score >= 1 AND score <= 5),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(page_id, user_id),           -- 一个用户对一篇文章只能评一次
  FOREIGN KEY (page_id) REFERENCES wiki_pages(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 索引（性能优化）
CREATE INDEX IF NOT EXISTS idx_comments_page_id ON comments(page_id);
CREATE INDEX IF NOT EXISTS idx_ratings_page_id ON ratings(page_id);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_slug ON wiki_pages(slug);
CREATE INDEX IF NOT EXISTS idx_page_versions_page_id ON page_versions(page_id);
