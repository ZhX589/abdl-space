/** 用户 */
export interface User {
  id: number
  email: string
  password_hash: string
  username: string
  role: string
  avatar: string | null
  age: number | null
  region: string | null
  weight: number | null
  waist: number | null
  hip: number | null
  style_preference: string | null
  bio: string | null
  email_verified: number
  created_at: string
}

/** 纸尿裤 */
export interface Diaper {
  id: number
  brand: string
  model: string
  product_type: string
  thickness: number
  absorbency_mfr: string
  absorbency_adult: string
  is_baby_diaper: number
  comfort: number | null
  popularity: number
  material: string
  features: string
  avg_price: string
  created_at: string
}

/** 纸尿裤尺码 */
export interface DiaperSize {
  id: number
  diaper_id: number
  label: string
  waist_min: number
  waist_max: number
  hip_min: number
  hip_max: number
}

/** 评分（6 维度 1–10） */
export interface Rating {
  id: number
  user_id: number
  diaper_id: number
  absorption_score: number
  fit_score: number
  comfort_score: number
  thickness_score: number
  appearance_score: number
  value_score: number
  review: string | null
  review_status: string
  created_at: string
}

/** 使用感受（5 维度 -5~5） */
export interface Feeling {
  id: number
  user_id: number
  diaper_id: number
  size: string
  looseness: number
  softness: number
  dryness: number
  odor_control: number
  quietness: number
  created_at: string
}

/** 论坛帖子 */
export interface Post {
  id: number
  user_id: number
  content: string
  diaper_id: number | null
  pinned: number
  created_at: string
}

/** 帖子评论 */
export interface PostComment {
  id: number
  post_id: number
  user_id: number
  parent_id: number | null
  content: string
  created_at: string
}

/** 点赞 */
export interface Like {
  user_id: number
  target_type: string
  target_id: number
  created_at: string
}

/** Wiki 页面（可选关联纸尿裤） */
export interface WikiPage {
  id: number
  slug: string
  title: string
  content: string
  author_id: number | null
  diaper_id: number | null
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

/** Wiki 段落评论（段评） */
export interface WikiInlineComment {
  id: number
  page_id: number
  paragraph_hash: string
  author_id: number
  content: string
  created_at: string
}

/** 术语百科 */
export interface Term {
  id: number
  term: string
  abbreviation: string | null
  definition: string
  category: string | null
  created_by: number | null
  created_at: string
}

/** 经验/等级 */
export interface Experience {
  id: number
  user_id: number
  current_exp: number
  total_exp: number
  current_level: number
}

/** 通知 */
export interface Notification {
  id: number
  user_id: number
  type: string
  message: string
  related_id: number | null
  read: number
  created_at: string
}

/** 注册请求体 */
export interface RegisterRequest {
  email: string
  password: string
  username: string
}

/** 登录请求体（login 接受 email 或 username） */
export interface LoginRequest {
  login: string
  password: string
}

/** 登录响应（含 JWT） */
export interface LoginResponse {
  token: string
  user: Pick<User, 'id' | 'email' | 'username' | 'avatar' | 'role'>
}

/** 创建评分请求体 */
export interface CreateRatingRequest {
  diaper_id: number
  absorption_score: number
  fit_score: number
  comfort_score: number
  thickness_score: number
  appearance_score: number
  value_score: number
  review?: string
}

/** 创建感受请求体 */
export interface CreateFeelingRequest {
  diaper_id: number
  size: string
  looseness: number
  softness: number
  dryness: number
  odor_control: number
  quietness: number
}

/** 创建帖子请求体 */
export interface CreatePostRequest {
  content: string
  diaper_id?: number
}

/** 创建帖子评论请求体 */
export interface CreatePostCommentRequest {
  content: string
  parent_id?: number
}

/** 点赞请求体 */
export interface LikeRequest {
  target_type: 'post' | 'comment'
  target_id: number
}

/** 创建 Wiki 页面请求体 */
export interface CreatePageRequest {
  slug: string
  title: string
  content: string
  diaper_id?: number
}

/** 更新 Wiki 页面请求体 */
export interface UpdatePageRequest {
  title?: string
  content?: string
  is_published?: number
}

/** 创建 Wiki 段评请求体 */
export interface CreateInlineCommentRequest {
  paragraph_hash: string
  content: string
}

/** 创建术语请求体 */
export interface CreateTermRequest {
  term: string
  abbreviation?: string
  definition: string
  category?: string
}

/** 更新用户资料请求体 */
export interface UpdateUserRequest {
  avatar?: string | null
  age?: number | null
  region?: string | null
  weight?: number | null
  waist?: number | null
  hip?: number | null
  style_preference?: string | null
  bio?: string | null
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
  role: string
  iat: number
  exp: number
}
