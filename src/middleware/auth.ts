import type { Context, Next } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { verifyJWT } from '../lib/auth.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

/**
 * JWT 认证中间件，从 Authorization: Bearer <token> 提取并验证 JWT
 * 验证成功后设置 c.set('user', payload)，失败返回 401
 */
export async function authMiddleware(c: Context<AppType>, next: Next): Promise<Response | void> {
  const authHeader = c.req.header('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401)
  }

  const token = authHeader.slice(7)
  const payload = await verifyJWT(token, c.env.JWT_SECRET)
  if (!payload) {
    return c.json({ error: 'Invalid or expired token' }, 401)
  }

  c.set('user', payload)
  await next()
}
