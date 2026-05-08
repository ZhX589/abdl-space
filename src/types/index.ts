/** 用户 */
export interface User {
  id: number
  email: string
  password_hash: string
  username: string
  avatar_url: string | null
  email_verified: number
  created_at: string
}

/** Wiki 页面 */
export interface WikiPage {
  id: number
  slug: string
  title: string
  content: string
  author_id: number | null
  version: number
  is_published: number
  created_at: string
  updated_at: string
}

/** 页面版本历史 */
export interface PageVersion {
  id: number
  page_id: number
  content: string
  version: number
  author_id: number | null
  created_at: string
}

/** 评论 */
export interface Comment {
  id: number
  page_id: number
  author_id: number
  content: string
  parent_id: number | null
  created_at: string
}

/** 评分 (1-5 星) */
export interface Rating {
  id: number
  page_id: number
  user_id: number
  score: number
  created_at: string
}

/** 注册请求体 */
export interface RegisterRequest {
  email: string
  password: string
  username: string
}

/** 登录请求体 */
export interface LoginRequest {
  email: string
  password: string
}

/** 登录响应（含 JWT） */
export interface LoginResponse {
  token: string
  user: Pick<User, 'id' | 'email' | 'username' | 'avatar_url'>
}

/** 创建 Wiki 页面请求体 */
export interface CreatePageRequest {
  slug: string
  title: string
  content: string
}

/** 更新 Wiki 页面请求体 */
export interface UpdatePageRequest {
  title?: string
  content?: string
  is_published?: number
}

/** 发表评论请求体 */
export interface CreateCommentRequest {
  content: string
  parent_id?: number
}

/** 评分请求体 */
export interface CreateRatingRequest {
  score: number
}

/** Cloudflare Worker Env 绑定类型（扩展 wrangler 生成的类型） */
export interface Env {
  abdl_space_db: D1Database
  JWT_SECRET: string
}

/** JWT payload 结构 */
export interface JWTPayload {
  sub: number
  username: string
  email: string
  iat: number
  exp: number
}
