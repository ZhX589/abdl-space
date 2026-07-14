import type { Context, Next } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { verifyJWT } from '../lib/auth.ts'
import { queryOne } from '../lib/db.ts'

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
  }
}

/**
 * Extract and verify JWT or OAuth token from Authorization header or Cookie
 * Returns payload or null
 */
async function extractUser(c: Context<AppType>): Promise<JWTPayload | null> {
  // Try Authorization header first
  const authHeader = c.req.header('Authorization')
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7)
    // 先尝试 JWT
    const payload = await verifyJWT(token, c.env.JWT_SECRET)
    if (payload) return payload
    // JWT 失败，尝试 OAuth token
    const oauthUser = await lookupOAuthToken(c.env.abdl_space_db, token)
    if (oauthUser) return oauthUser
  }
  // Fallback to Cookie
  const cookieHeader = c.req.header('Cookie')
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;\s*)token=([^;]+)/)
    if (match) {
      const payload = await verifyJWT(match[1], c.env.JWT_SECRET)
      if (payload) return payload
      // Also try OAuth token in cookie
      const oauthUser = await lookupOAuthToken(c.env.abdl_space_db, match[1])
      if (oauthUser) return oauthUser
    }
  }
  return null
}

/**
 * BUG-177: 密码修改后旧 JWT 失效（仅 JWT，跳过 OAuth token）
 * 抽取为共享函数，authMiddleware 和 adminMiddleware 都调用
 */
async function assertSessionNotStale(payload: JWTPayload, db: D1Database): Promise<string | null> {
  if (payload.iat <= 0) return null // OAuth token, skip check
  const user = await queryOne<{ password_changed_at: string | null }>(
    db,
    'SELECT password_changed_at FROM users WHERE id = ?',
    [payload.sub]
  )
  if (!user) return 'Session expired, please login again'
  if (user?.password_changed_at) {
    const pwdChangedSec = Math.floor(new Date(user.password_changed_at).getTime() / 1000)
    const tokenIat = payload.iat > 1e12 ? Math.floor(payload.iat / 1000) : payload.iat
    if (tokenIat < pwdChangedSec) {
      return 'Session expired, please login again'
    }
  }
  return null
}

/**
 * JWT 认证中间件，从 Authorization: Bearer <token> 或 Cookie 提取并验证 JWT
 * 验证成功后设置 c.set('user', payload)，失败返回 401
 */
export async function authMiddleware(c: Context<AppType>, next: Next): Promise<Response | void> {
  const payload = await extractUser(c)
  if (!payload) {
    return c.json({ error: 'Authentication required' }, 401)
  }

  const staleError = await assertSessionNotStale(payload, c.env.abdl_space_db)
  if (staleError) {
    return c.json({ error: staleError }, 401)
  }

  const currentUser = await queryOne<{ role: string }>(
    c.env.abdl_space_db,
    'SELECT role FROM users WHERE id = ?',
    [payload.sub]
  )
  if (!currentUser) {
    return c.json({ error: 'Authentication required' }, 401)
  }

  c.set('user', { ...payload, role: currentUser.role })
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

  const staleError = await assertSessionNotStale(payload, c.env.abdl_space_db)
  if (staleError) {
    return c.json({ error: staleError }, 401)
  }

  const currentUser = await queryOne<{ role: string }>(
    c.env.abdl_space_db,
    'SELECT role FROM users WHERE id = ?',
    [payload.sub]
  )
  if (currentUser?.role !== 'admin') {
    return c.json({ error: 'Admin access required' }, 403)
  }

  c.set('user', payload)
  await next()
}
