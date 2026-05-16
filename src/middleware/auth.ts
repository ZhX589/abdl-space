import type { Context, Next } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { verifyJWT } from '../lib/auth.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

/**
 * Extract and verify JWT from Authorization header or Cookie
 * Returns payload or null
 */
async function extractUser(c: Context<AppType>): Promise<JWTPayload | null> {
  // Try Authorization header first
  const authHeader = c.req.header('Authorization')
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7)
    const payload = await verifyJWT(token, c.env.JWT_SECRET)
    if (payload) return payload
  }
  // Fallback to Cookie
  const cookieHeader = c.req.header('Cookie')
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;\s*)token=([^;]+)/)
    if (match) {
      const payload = await verifyJWT(match[1], c.env.JWT_SECRET)
      if (payload) return payload
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
  c.set('user', payload)
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
  if (payload.role !== 'admin') {
    return c.json({ error: 'Admin access required' }, 403)
  }
  c.set('user', payload)
  await next()
}
