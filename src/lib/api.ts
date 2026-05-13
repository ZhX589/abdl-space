/**
 * ABDL Space API 调用封装
 * 遵循 AGENTS.md 规范：B 站前端只调用 get 类接口，create/update/delete 由 A 站调用
 */

import type {
  User,
  DiaperSize,
  RegisterRequest,
  LoginRequest,
  LoginResponse,
  CreateRatingRequest,
  CreateFeelingRequest,
  CreatePostRequest,
  CreatePostCommentRequest,
  LikeRequest,
  CreatePageRequest,
  UpdatePageRequest,
  CreateInlineCommentRequest,
  CreateTermRequest,
  UpdateUserRequest,
} from '../types/index.ts'

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8787'

// === 通用工具 ===

interface ErrorResponse {
  error?: string
}

async function fetchApi<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${BASE_URL}${endpoint}`
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })

  const data = await response.json() as ErrorResponse

  if (!response.ok) {
    throw new Error(data.error || `API Error: ${response.status}`)
  }

  return data as T
}

function getAuthHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

// === 响应类型定义 ===

export interface PaginatedResponse<T> {
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
  [key: string]: T[] | PaginatedResponse<T>['pagination']
}

export interface DiaperListItem {
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
  sizes: DiaperSize[]
  avg_score: number
  rating_count: number
  feeling_count: number
}

export interface DiapersResponse extends PaginatedResponse<DiaperListItem> {
  diapers: DiaperListItem[]
}

export interface GetDiapersParams {
  search?: string
  brand?: string
  size?: string
  sort?: 'id' | 'avg_score' | 'rating_count' | 'thickness'
  order?: 'ASC' | 'DESC'
  page?: number
  limit?: number
}

export interface ReviewUser {
  id: number
  username: string
  avatar: string | null
  role: string
}

export interface Review {
  id: number
  user: ReviewUser
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

export interface DiaperDetailResponse {
  diaper: DiaperListItem
  reviews: Review[]
  wiki: {
    diaper_id: number
    category: string
    title: string
    content: string
    updated_at: string
  } | null
}

export interface CompareDimensions {
  absorption_score: { avg: number }
  fit_score: { avg: number }
  comfort_score: { avg: number }
  thickness_score: { avg: number }
  appearance_score: { avg: number }
  value_score: { avg: number }
}

export interface CompareDiaper {
  id: number
  brand: string
  model: string
  thickness: number
  absorbency_adult: string
  avg_price: string
  sizes: DiaperSize[]
  dimensions: CompareDimensions
  avg_score: number
  rating_count: number
}

export interface CompareResponse {
  diapers: CompareDiaper[]
}

export interface RatingsStats {
  composite: number
  count: number
  dimensions: {
    absorption_score: { avg: number; count: number }
    fit_score: { avg: number; count: number }
    comfort_score: { avg: number; count: number }
    thickness_score: { avg: number; count: number }
    appearance_score: { avg: number; count: number }
    value_score: { avg: number; count: number }
  }
}

export interface RatingsResponse {
  reviews: Review[]
  stats: RatingsStats
}

export interface MyRatingResponse {
  rating: Review | null
}

export interface CreateRatingResponse {
  message: string
  review_status: string
  id: number
}

export interface FeelingUser {
  id: number
  username: string
  avatar: string | null
}

export interface FeelingItem {
  id: number
  user: FeelingUser
  diaper_id: number
  size: string
  looseness: number
  softness: number
  dryness: number
  odor_control: number
  quietness: number
  created_at: string
}

export interface FeelingsStats {
  looseness: number
  softness: number
  dryness: number
  odor_control: number
  quietness: number
}

export interface FeelingsResponse {
  feelings: FeelingItem[]
  stats: FeelingsStats
  count: number
}

export interface MyFeelingResponse {
  feeling: FeelingItem | null
}

export interface CreateFeelingResponse {
  message: string
  id: number
}

export interface PostUser {
  id: number
  username: string
  avatar: string | null
  role: string
}

export interface PostItem {
  id: number
  user: PostUser
  content: string
  diaper_id: number | null
  pinned: boolean
  like_count: number
  has_liked: boolean
  comment_count: number
  created_at: string
}

export interface PostsResponse extends PaginatedResponse<PostItem> {
  posts: PostItem[]
}

export interface CommentUser {
  id: number
  username: string
  avatar: string | null
  role: string
}

export interface Comment {
  id: number
  post_id: number
  user: CommentUser
  parent_id: number | null
  content: string
  like_count: number
  has_liked: boolean
  created_at: string
}

export interface PostDetailResponse {
  post: PostItem
  comments: Comment[]
}

export interface CreatePostResponse {
  id: number
  message: string
}

export interface CreateCommentResponse {
  message: string
  id: number
}

export interface LikeResponse {
  liked: boolean
}

export interface RankingItem {
  id: number
  brand: string
  model: string
  avg_score: number
  rating_count: number
  thickness: number
  absorbency_adult: string
}

export interface RankingsResponse {
  rankings: RankingItem[]
  type: string
}

export interface RankingsParams {
  type: 'hot' | 'absorbency' | 'popular' | 'dimension'
  dimension?: 'absorption_score' | 'fit_score' | 'comfort_score' | 'thickness_score' | 'appearance_score' | 'value_score'
  limit?: number
}

export interface WikiPageItem {
  id: number
  slug: string
  title: string
  diaper_id: number | null
  version: number
  is_published: number
  author_id: number | null
  created_at: string
  updated_at: string
}

export interface PagesResponse extends PaginatedResponse<WikiPageItem> {
  pages: WikiPageItem[]
}

export interface PageResponse {
  id: number
  slug: string
  title: string
  content: string
  diaper_id: number | null
  version: number
  is_published: number
  author_id: number | null
  created_at: string
  updated_at: string
}

export interface CreatePageResponse {
  id: number
  slug: string
  message: string
}

export interface UpdatePageResponse {
  message: string
  version: number
}

export interface PageVersion {
  id: number
  version: number
  content: string
  author: { id: number; username: string; avatar: string | null } | null
  created_at: string
}

export interface PageVersionsResponse {
  versions: PageVersion[]
}

export interface PageVersionResponse {
  version: PageVersion
}

export interface InlineCommentAuthor {
  id: number
  username: string
  avatar: string | null
}

export interface InlineComment {
  id: number
  paragraph_hash: string
  author: InlineCommentAuthor
  content: string
  created_at: string
}

export interface InlineCommentsResponse {
  comments: InlineComment[]
}

export interface CreateInlineCommentResponse {
  id: number
  message: string
}

export interface UserPublic {
  id: number
  username: string
  role: string
  avatar: string | null
  age: number | null
  region: string | null
  style_preference: string | null
  bio: string | null
  created_at: string
}

export interface UserResponse {
  user: UserPublic
}

export interface UpdateMeResponse {
  user: User
}

export interface LevelBadge {
  level: number
  exp: number
  total_exp: number
  badge_name: string
  badge_icon: string
  next_level: number
  next_exp_required: number
  progress: number
}

export interface UserLevelResponse {
  level: LevelBadge
}

export interface TermItem {
  id: number
  term: string
  abbreviation: string | null
  definition: string
  category: string | null
  created_by: number | null
  created_at: string
}

export interface TermsResponse {
  terms: TermItem[]
}

export interface CategoriesResponse {
  categories: string[]
}

export interface CreateTermResponse {
  id: number
  message: string
}

export interface RecommendItem {
  diaper_id: number
  brand: string
  model: string
  reason: string
  matchScore: number
}

export interface RecommendRequest {
  selected: {
    basic: boolean
    body: boolean
    prefs: boolean
    bio: boolean
    feelings: boolean
  }
}

export interface RecommendResponse {
  recommendations: RecommendItem[]
  summary: string
}

export interface GuessRecommendItem {
  id: number
  brand: string
  model: string
  avg_score: number
  rating_count: number
  thickness: number
  reason: string
}

export interface GuessRecommendResponse {
  recommendations: GuessRecommendItem[]
}

export interface NotificationItem {
  id: number
  type: string
  message: string
  related_id: number | null
  read: boolean
  created_at: string
}

export interface NotificationsResponse {
  notifications: NotificationItem[]
  unread_count: number
}

export interface MarkReadResponse {
  message: string
}

export interface AdminStatsResponse {
  users: number
  posts: number
  comments: number
  diapers: number
  ratings: number
}

export interface AdminUser {
  id: number
  email: string
  username: string
  role: string
  avatar: string | null
  email_verified: number
  created_at: string
}

export interface AdminUsersResponse {
  users: AdminUser[]
}

export interface BanResponse {
  banned: boolean
}

export interface PinResponse {
  pinned: boolean
}

export interface DeleteResponse {
  message: string
}

// === Auth（认证）===

export async function register(data: RegisterRequest): Promise<LoginResponse> {
  return fetchApi<LoginResponse>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function login(data: LoginRequest): Promise<LoginResponse> {
  return fetchApi<LoginResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function getMe(token: string): Promise<User> {
  return fetchApi<User>('/api/auth/me', {
    headers: getAuthHeader(token),
  })
}

// === Diapers（纸尿裤 - B站只调用get类） ===

export async function getDiapers(params?: GetDiapersParams): Promise<DiapersResponse> {
  const searchParams = new URLSearchParams()
  if (params?.search) searchParams.set('search', params.search)
  if (params?.brand) searchParams.set('brand', params.brand)
  if (params?.size) searchParams.set('size', params.size)
  if (params?.sort) searchParams.set('sort', params.sort)
  if (params?.order) searchParams.set('order', params.order)
  if (params?.page) searchParams.set('page', String(params.page))
  if (params?.limit) searchParams.set('limit', String(params.limit))

  const query = searchParams.toString()
  return fetchApi<DiapersResponse>(`/api/diapers${query ? `?${query}` : ''}`)
}

export async function getDiaper(id: number): Promise<DiaperDetailResponse> {
  return fetchApi<DiaperDetailResponse>(`/api/diapers/${id}`)
}

export async function getDiaperBrands(): Promise<{ brands: string[] }> {
  return fetchApi<{ brands: string[] }>('/api/diapers/brands')
}

export async function getDiaperSizes(): Promise<{ sizes: string[] }> {
  return fetchApi<{ sizes: string[] }>('/api/diapers/sizes')
}

export async function getDiaperCompare(ids: string): Promise<CompareResponse> {
  return fetchApi<CompareResponse>(`/api/diapers/compare?ids=${ids}`)
}

// === Ratings（评分 - 供A站调用） ===

export async function createRating(
  data: CreateRatingRequest,
  token: string
): Promise<CreateRatingResponse> {
  return fetchApi<CreateRatingResponse>('/api/ratings', {
    method: 'POST',
    body: JSON.stringify(data),
    headers: getAuthHeader(token),
  })
}

export async function getDiaperRatings(diaperId: number): Promise<RatingsResponse> {
  return fetchApi<RatingsResponse>(`/api/diapers/${diaperId}/ratings`)
}

export async function getMyRating(
  diaperId: number,
  token: string
): Promise<MyRatingResponse> {
  return fetchApi<MyRatingResponse>(`/api/ratings/me/${diaperId}`, {
    headers: getAuthHeader(token),
  })
}

export async function deleteRating(id: number, token: string): Promise<DeleteResponse> {
  return fetchApi<DeleteResponse>(`/api/ratings/${id}`, {
    method: 'DELETE',
    headers: getAuthHeader(token),
  })
}

// === Feelings（使用感受 - 供A站调用） ===

export async function createFeeling(
  data: CreateFeelingRequest,
  token: string
): Promise<CreateFeelingResponse> {
  return fetchApi<CreateFeelingResponse>('/api/feelings', {
    method: 'POST',
    body: JSON.stringify(data),
    headers: getAuthHeader(token),
  })
}

export async function getDiaperFeelings(diaperId: number): Promise<FeelingsResponse> {
  return fetchApi<FeelingsResponse>(`/api/diapers/${diaperId}/feelings`)
}

export async function getMyFeeling(
  diaperId: number,
  size: string,
  token: string
): Promise<MyFeelingResponse> {
  return fetchApi<MyFeelingResponse>(`/api/feelings/me/${diaperId}/${size}`, {
    headers: getAuthHeader(token),
  })
}

export async function deleteFeeling(id: number, token: string): Promise<DeleteResponse> {
  return fetchApi<DeleteResponse>(`/api/feelings/${id}`, {
    method: 'DELETE',
    headers: getAuthHeader(token),
  })
}

// === Posts（论坛帖子） ===

export async function getPosts(params?: {
  page?: number
  limit?: number
  search?: string
}): Promise<PostsResponse> {
  const searchParams = new URLSearchParams()
  if (params?.page) searchParams.set('page', String(params.page))
  if (params?.limit) searchParams.set('limit', String(params.limit))
  if (params?.search) searchParams.set('search', params.search)

  const query = searchParams.toString()
  return fetchApi<PostsResponse>(`/api/posts${query ? `?${query}` : ''}`)
}

export async function getPost(id: number): Promise<PostDetailResponse> {
  return fetchApi<PostDetailResponse>(`/api/posts/${id}`)
}

export async function createPost(
  data: CreatePostRequest,
  token: string
): Promise<CreatePostResponse> {
  return fetchApi<CreatePostResponse>('/api/posts', {
    method: 'POST',
    body: JSON.stringify(data),
    headers: getAuthHeader(token),
  })
}

export async function deletePost(id: number, token: string): Promise<DeleteResponse> {
  return fetchApi<DeleteResponse>(`/api/posts/${id}`, {
    method: 'DELETE',
    headers: getAuthHeader(token),
  })
}

// === Post Comments（帖子评论） ===

export async function createPostComment(
  postId: number,
  data: CreatePostCommentRequest,
  token: string
): Promise<CreateCommentResponse> {
  return fetchApi<CreateCommentResponse>(`/api/posts/${postId}/comments`, {
    method: 'POST',
    body: JSON.stringify(data),
    headers: getAuthHeader(token),
  })
}

// === Likes（点赞） ===

export async function postLike(
  data: LikeRequest,
  token: string
): Promise<LikeResponse> {
  return fetchApi<LikeResponse>('/api/likes', {
    method: 'POST',
    body: JSON.stringify(data),
    headers: getAuthHeader(token),
  })
}

// === Rankings（排行榜） ===

export async function getRankings(params: RankingsParams): Promise<RankingsResponse> {
  const searchParams = new URLSearchParams()
  searchParams.set('type', params.type)
  if (params.dimension) searchParams.set('dimension', params.dimension)
  if (params.limit) searchParams.set('limit', String(params.limit))

  return fetchApi<RankingsResponse>(`/api/rankings?${searchParams.toString()}`)
}

// === Wiki Pages（Wiki 页面） ===

export async function getPages(params?: {
  diaper_id?: number
  page?: number
  limit?: number
}): Promise<PagesResponse> {
  const searchParams = new URLSearchParams()
  if (params?.diaper_id) searchParams.set('diaper_id', String(params.diaper_id))
  if (params?.page) searchParams.set('page', String(params.page))
  if (params?.limit) searchParams.set('limit', String(params.limit))

  const query = searchParams.toString()
  return fetchApi<PagesResponse>(`/api/pages${query ? `?${query}` : ''}`)
}

export async function getPage(slug: string): Promise<PageResponse> {
  return fetchApi<PageResponse>(`/api/pages/${slug}`)
}

export async function createPage(
  data: CreatePageRequest,
  token: string
): Promise<CreatePageResponse> {
  return fetchApi<CreatePageResponse>('/api/pages', {
    method: 'POST',
    body: JSON.stringify(data),
    headers: getAuthHeader(token),
  })
}

export async function updatePage(
  slug: string,
  data: UpdatePageRequest,
  token: string
): Promise<UpdatePageResponse> {
  return fetchApi<UpdatePageResponse>(`/api/pages/${slug}`, {
    method: 'PUT',
    body: JSON.stringify(data),
    headers: getAuthHeader(token),
  })
}

export async function deletePage(slug: string, token: string): Promise<DeleteResponse> {
  return fetchApi<DeleteResponse>(`/api/pages/${slug}`, {
    method: 'DELETE',
    headers: getAuthHeader(token),
  })
}

export async function getPageVersions(slug: string): Promise<PageVersionsResponse> {
  return fetchApi<PageVersionsResponse>(`/api/pages/${slug}/versions`)
}

export async function getPageVersion(slug: string, version: number): Promise<PageVersionResponse> {
  return fetchApi<PageVersionResponse>(`/api/pages/${slug}/versions/${version}`)
}

export async function rollbackPage(
  slug: string,
  version: number,
  token: string
): Promise<UpdatePageResponse> {
  return fetchApi<UpdatePageResponse>(`/api/pages/${slug}/rollback/${version}`, {
    method: 'POST',
    headers: getAuthHeader(token),
  })
}

// === Wiki Inline Comments（Wiki 段评） ===

export async function getInlineComments(
  slug: string,
  params?: { paragraph_hash?: string }
): Promise<InlineCommentsResponse> {
  const searchParams = new URLSearchParams()
  if (params?.paragraph_hash) searchParams.set('paragraph_hash', params.paragraph_hash)

  const query = searchParams.toString()
  return fetchApi<InlineCommentsResponse>(
    `/api/pages/${slug}/inline-comments${query ? `?${query}` : ''}`
  )
}

export async function createInlineComment(
  slug: string,
  data: CreateInlineCommentRequest,
  token: string
): Promise<CreateInlineCommentResponse> {
  return fetchApi<CreateInlineCommentResponse>(
    `/api/pages/${slug}/inline-comments`,
    {
      method: 'POST',
      body: JSON.stringify(data),
      headers: getAuthHeader(token),
    }
  )
}

export async function deleteInlineComment(
  slug: string,
  id: number,
  token: string
): Promise<DeleteResponse> {
  return fetchApi<DeleteResponse>(
    `/api/pages/${slug}/inline-comments/${id}`,
    {
      method: 'DELETE',
      headers: getAuthHeader(token),
    }
  )
}

// === Users（用户） ===

export async function getUser(id: number): Promise<UserResponse> {
  return fetchApi<UserResponse>(`/api/users/${id}`)
}

export async function updateMe(
  data: UpdateUserRequest,
  token: string
): Promise<UpdateMeResponse> {
  return fetchApi<UpdateMeResponse>('/api/users/me', {
    method: 'PATCH',
    body: JSON.stringify(data),
    headers: getAuthHeader(token),
  })
}

export async function getUserLevel(id: number): Promise<UserLevelResponse> {
  return fetchApi<UserLevelResponse>(`/api/users/${id}/level`)
}

export async function getUserPosts(id: number): Promise<PostsResponse> {
  return fetchApi<PostsResponse>(`/api/users/${id}/posts`)
}

export async function getUserRatings(id: number): Promise<{ reviews: Review[] }> {
  return fetchApi<{ reviews: Review[] }>(`/api/users/${id}/ratings`)
}

export async function getUserFeelings(id: number): Promise<{ feelings: FeelingItem[] }> {
  return fetchApi<{ feelings: FeelingItem[] }>(`/api/users/${id}/feelings`)
}

// === Terms（术语百科） ===

export async function getTerms(params?: {
  search?: string
  category?: string
}): Promise<TermsResponse> {
  const searchParams = new URLSearchParams()
  if (params?.search) searchParams.set('search', params.search)
  if (params?.category) searchParams.set('category', params.category)

  const query = searchParams.toString()
  return fetchApi<TermsResponse>(`/api/terms${query ? `?${query}` : ''}`)
}

export async function getTermCategories(): Promise<CategoriesResponse> {
  return fetchApi<CategoriesResponse>('/api/terms/categories')
}

export async function createTerm(
  data: CreateTermRequest,
  token: string
): Promise<CreateTermResponse> {
  return fetchApi<CreateTermResponse>('/api/terms', {
    method: 'POST',
    body: JSON.stringify(data),
    headers: getAuthHeader(token),
  })
}

export async function updateTerm(
  id: number,
  data: Partial<CreateTermRequest>,
  token: string
): Promise<{ message: string }> {
  return fetchApi<{ message: string }>(`/api/terms/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
    headers: getAuthHeader(token),
  })
}

export async function deleteTerm(id: number, token: string): Promise<DeleteResponse> {
  return fetchApi<DeleteResponse>(`/api/terms/${id}`, {
    method: 'DELETE',
    headers: getAuthHeader(token),
  })
}

// === Recommend（推荐） ===

export async function postRecommend(
  data: RecommendRequest,
  token: string
): Promise<RecommendResponse> {
  return fetchApi<RecommendResponse>('/api/recommend', {
    method: 'POST',
    body: JSON.stringify(data),
    headers: getAuthHeader(token),
  })
}

export async function getGuessRecommend(): Promise<GuessRecommendResponse> {
  return fetchApi<GuessRecommendResponse>('/api/recommend/guess')
}

// === Notifications（通知） ===

export async function getNotifications(token: string): Promise<NotificationsResponse> {
  return fetchApi<NotificationsResponse>('/api/notifications', {
    headers: getAuthHeader(token),
  })
}

export async function markNotificationsRead(token: string): Promise<MarkReadResponse> {
  return fetchApi<MarkReadResponse>('/api/notifications/read-all', {
    method: 'POST',
    headers: getAuthHeader(token),
  })
}

// === Admin（管理后台 - 需管理员权限） ===

export async function getAdminStats(token: string): Promise<AdminStatsResponse> {
  return fetchApi<AdminStatsResponse>('/api/admin/stats', {
    headers: getAuthHeader(token),
  })
}

export async function getAdminUsers(token: string): Promise<AdminUsersResponse> {
  return fetchApi<AdminUsersResponse>('/api/admin/users', {
    headers: getAuthHeader(token),
  })
}

export async function deleteAdminUser(
  id: number,
  token: string
): Promise<DeleteResponse> {
  return fetchApi<DeleteResponse>(`/api/admin/users/${id}`, {
    method: 'DELETE',
    headers: getAuthHeader(token),
  })
}

export async function banUser(
  id: number,
  token: string
): Promise<BanResponse> {
  return fetchApi<BanResponse>(`/api/admin/users/${id}/ban`, {
    method: 'POST',
    headers: getAuthHeader(token),
  })
}

export async function pinPost(
  id: number,
  token: string
): Promise<PinResponse> {
  return fetchApi<PinResponse>(`/api/admin/posts/${id}/pin`, {
    method: 'POST',
    headers: getAuthHeader(token),
  })
}

export async function deleteAdminPost(
  id: number,
  token: string
): Promise<DeleteResponse> {
  return fetchApi<DeleteResponse>(`/api/admin/posts/${id}`, {
    method: 'DELETE',
    headers: getAuthHeader(token),
  })
}

export async function deleteAdminComment(
  id: number,
  token: string
): Promise<DeleteResponse> {
  return fetchApi<DeleteResponse>(`/api/admin/comments/${id}`, {
    method: 'DELETE',
    headers: getAuthHeader(token),
  })
}

export async function deleteAdminDiaper(
  id: number,
  token: string
): Promise<DeleteResponse> {
  return fetchApi<DeleteResponse>(`/api/admin/diapers/${id}`, {
    method: 'DELETE',
    headers: getAuthHeader(token),
  })
}

// === Search（搜索）===

export interface SearchDiaperResult {
  id: number
  brand: string
  model: string
  avg_score: number
  rating_count: number
}

export interface SearchWikiResult {
  id: number
  slug: string
  title: string
  content_preview: string
}

export interface SearchTermResult {
  id: number
  term: string
  abbreviation: string | null
  category: string | null
}

export interface SearchResults {
  diapers: SearchDiaperResult[]
  wiki: SearchWikiResult[]
  terms: SearchTermResult[]
}

export interface SearchResponse {
  query: string
  type: string
  total: number
  results: SearchResults
}

export async function getSearch(
  params: { q: string; type?: string; limit?: number }
): Promise<SearchResponse> {
  const sp = new URLSearchParams({ q: params.q })
  if (params.type) sp.set('type', params.type)
  if (params.limit) sp.set('limit', String(params.limit))
  return fetchApi<SearchResponse>(`/api/search?${sp.toString()}`)
}