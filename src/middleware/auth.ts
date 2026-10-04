import type { Context, Next } from 'hono'
import type { D1Database } from '@cloudflare/workers-types'
import type { Env, JWTPayload } from '../types/index.ts'
import { verifyJWT } from '../lib/auth.ts'
import { queryOne } from '../lib/db.ts'
import { isSuperAdmin } from '../lib/admin-security.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

/**
 * 从 OAuth token 表查找用户
 */
async function lookupOAuthToken(db: D1Database, token: string): Promise<JWTPayload | null> {
  const now = Math.floor(Date.now() / 1000)
  const row = await queryOne<{
    user_id: number; scopes: string; access_expires_at: number; revoked: number
  }>(db,
    'SELECT user_id, scopes, access_expires_at, revoked FROM oauth_tokens WHERE access_token = ?',
    [token]
  )
  if (!row || row.revoked || now > row.access_expires_at) return null

  // 查用户信息
  const user = await queryOne<{
    id: number; username: string; email: string; role: string
  }>(db, 'SELECT id, username, email, role FROM users WHERE id = ?', [row.user_id])
  if (!user) return null

  return {
    sub: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    iat: 0,  // OAuth token: skip password_changed_at check
    exp: row.access_expires_at,
    oauth_scopes: row.scopes.split(/[ ,]+/).filter(Boolean),
  }
}

/**
 * Extract and verify JWT or OAuth token from Authorization header or Cookie
 * Returns payload or null
 *
 * 同一请求内 memoize：ip-security 与 auth/admin 中间件都会调用 extractUser，
 * OAuth token 路径每次调用要查 2 条 D1，memo 后每个请求只解析一次。
 */
const extractUserMemo = new WeakMap<object, JWTPayload | null>()

export async function extractUser(c: Context<AppType>): Promise<JWTPayload | null> {
  const memoized = extractUserMemo.get(c)
  if (memoized !== undefined) return memoized
  const result = await extractUserUncached(c)
  extractUserMemo.set(c, result)
  return result
}

/** Verify only the native timeline bearer, never a fallback cookie or another path's auth memo. */
export async function extractBearerUser(c: Context<AppType>): Promise<JWTPayload | null> {
  return extractUserUncached(c, false)
}

async function extractUserUncached(c: Context<AppType>, allowCookie = true): Promise<JWTPayload | null> {
  // Keep unrelated auth's existing case-sensitive behavior; Mastodon bearer auth is case-insensitive.
  const authHeader = c.req.header('Authorization')
  const bearer = allowCookie ? (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null) : authHeader?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (bearer) {
    const token = bearer
    // 先尝试 JWT
    const payload = await verifyJWT(token, c.env.JWT_SECRET)
    if (payload) return { ...payload, oauth_scopes: undefined, is_super_admin: undefined }
    // JWT 失败，尝试 OAuth token
    const oauthUser = await lookupOAuthToken(c.env.abdl_space_db, token)
    if (oauthUser) return oauthUser
  }
  // Fallback to Cookie
  const cookieHeader = allowCookie ? c.req.header('Cookie') : undefined
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;\s*)token=([^;]+)/)
    if (match) {
      const payload = await verifyJWT(match[1], c.env.JWT_SECRET)
      if (payload) return { ...payload, oauth_scopes: undefined, is_super_admin: undefined }
      // Also try OAuth token in cookie
      const oauthUser = await lookupOAuthToken(c.env.abdl_space_db, match[1])
      if (oauthUser) return oauthUser
    }
  }
  return null
}

type UserSessionState = {
  role?: string
  username?: string
  email?: string
  banned?: number
  password_changed_at: string | null
  auth_invalid_before?: number | null
}

// 恢复期旧库可能没有 auth_invalid_before。新库直接用合并查询；只有遇到明确的
// 缺列错误时才缓存为 legacy 并回退，正常生产请求仍只有一条 users 查询。
const LEGACY_AUTH_SCHEMA_RETRY_MS = 60_000
const authInvalidBeforeSupport = new WeakMap<object, { supported: boolean; expiresAt: number }>()

function isMissingAuthInvalidBefore(error: unknown): boolean {
  return error instanceof Error
    && /auth_invalid_before/i.test(error.message)
    && /(no such column|no column named|unknown column)/i.test(error.message)
}

async function queryUserSessionState(db: D1Database, userId: number, includeRole: boolean): Promise<UserSessionState | null> {
  const dbKey = db as object
  const roleField = includeRole ? 'role, ' : ''
  // users.* includes banned when present without ALTER/PRAGMA on each request in legacy DBs.
  const currentFields = includeRole ? ', users.*' : ''
  const support = authInvalidBeforeSupport.get(dbKey)
  if (support?.supported === false && Date.now() < support.expiresAt) {
    return queryOne<UserSessionState>(db, `SELECT ${roleField}password_changed_at${currentFields} FROM users WHERE id = ?`, [userId])
  }

  try {
    const user = await queryOne<UserSessionState>(
      db,
      `SELECT ${roleField}password_changed_at, auth_invalid_before${currentFields} FROM users WHERE id = ?`,
      [userId]
    )
    authInvalidBeforeSupport.set(dbKey, { supported: true, expiresAt: Number.POSITIVE_INFINITY })
    return user
  } catch (error) {
    if (!isMissingAuthInvalidBefore(error)) throw error
    authInvalidBeforeSupport.set(dbKey, { supported: false, expiresAt: Date.now() + LEGACY_AUTH_SCHEMA_RETRY_MS })
    return queryOne<UserSessionState>(db, `SELECT ${roleField}password_changed_at${currentFields} FROM users WHERE id = ?`, [userId])
  }
}

/**
 * 密码修改或管理员强制撤销后旧 JWT 失效（仅 JWT，跳过 OAuth token）。
 * 秒级时间戳无法证明同一秒内的先后，故使用 <= fail-closed。
 */
export function checkSessionStale(
  payload: JWTPayload,
  passwordChangedAt: string | null | undefined,
  authInvalidBefore?: number | null,
): string | null {
  if (payload.iat <= 0) return null // OAuth token, skip check
  const tokenIat = payload.iat > 1e12 ? Math.floor(payload.iat / 1000) : payload.iat
  if (passwordChangedAt) {
    const pwdChangedSec = Math.floor(new Date(passwordChangedAt).getTime() / 1000)
    if (tokenIat <= pwdChangedSec) return 'Session expired, please login again'
  }
  if (authInvalidBefore != null && tokenIat <= authInvalidBefore) {
    return 'Session expired, please login again'
  }
  return null
}

/**
 * 共享会话新鲜度检查，供 sponsor/baby-verification/novel 等非标准鉴权路径调用。
 */
export async function assertSessionNotStale(payload: JWTPayload, db: D1Database): Promise<string | null> {
  if (payload.iat <= 0) return null // OAuth token, skip check
  const user = await queryUserSessionState(db, payload.sub, false)
  if (!user) return 'Session expired, please login again'
  return checkSessionStale(payload, user.password_changed_at, user.auth_invalid_before)
}

/** Resolve current role and JWT freshness without any cross-request authority cache. */
export async function refreshUserSession(payload: JWTPayload, db: D1Database): Promise<JWTPayload | null> {
  const current = await queryUserSessionState(db, payload.sub, true)
  if (!current || current.banned || checkSessionStale(payload, current.password_changed_at, current.auth_invalid_before)) return null
  return { ...payload, role: current.role ?? '', is_super_admin: isSuperAdmin(payload.sub, current.role) }
}

/**
 * JWT 认证中间件，从 Authorization: Bearer <token> 或 Cookie 提取并验证 JWT
 * 验证成功后设置 c.set('user', payload)，失败返回 401
 *
 * role 与 password_changed_at 同在 users 表，单条查询取回（原每请求 2 条 → 1 条）
 */
export async function authMiddleware(c: Context<AppType>, next: Next): Promise<Response | void> {
  const payload = await extractUser(c)
  if (!payload) {
    return c.json({ error: 'Authentication required' }, 401)
  }

  const currentUser = await queryUserSessionState(c.env.abdl_space_db, payload.sub, true)
  if (!currentUser) {
    return c.json({ error: 'Session expired, please login again' }, 401)
  }
  if (currentUser.banned) return c.json({ error: 'Account banned' }, 403)

  const staleError = checkSessionStale(payload, currentUser.password_changed_at, currentUser.auth_invalid_before)
  if (staleError) {
    return c.json({ error: staleError }, 401)
  }

  c.set('user', { ...payload, role: currentUser.role ?? '', is_super_admin: isSuperAdmin(payload.sub, currentUser.role) })
  await next()
}

/**
 * 管理员鉴权中间件，要求 role === 'admin'
 * 先进行 JWT 认证，再检查角色
 */
export async function adminMiddleware(c: Context<AppType>, next: Next): Promise<Response | void> {
  const payload = await extractUser(c)
  if (!payload) {
    return c.json({ error: 'Authentication required' }, 401)
  }

  const currentUser = await queryUserSessionState(c.env.abdl_space_db, payload.sub, true)
  if (!currentUser) {
    return c.json({ error: 'Session expired, please login again' }, 401)
  }
  if (currentUser.banned) return c.json({ error: 'Account banned' }, 403)

  const staleError = checkSessionStale(payload, currentUser.password_changed_at, currentUser.auth_invalid_before)
  if (staleError) {
    return c.json({ error: staleError }, 401)
  }

  if (currentUser.role !== 'admin') {
    return c.json({ error: 'Admin access required' }, 403)
  }

  c.set('user', { ...payload, role: currentUser.role, is_super_admin: isSuperAdmin(payload.sub, currentUser.role) })
  await next()
}
