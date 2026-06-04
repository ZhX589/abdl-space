import type { Context, Next } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { verifyToken } from '../lib/captcha.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

/**
 * 验证码中间件 — 校验 X-Captcha-Token 头
 * 用于需要人机验证的业务接口（发帖、评分、推荐等）
 *
 * 用法: app.post('/api/posts', authMiddleware, captchaMiddleware, handler)
 */
export async function captchaMiddleware(c: Context<AppType>, next: Next) {
  const token = c.req.header('X-Captcha-Token')

  if (!token) {
    return c.json({ error: '请完成人机验证', code: 'CAPTCHA_REQUIRED' }, 403)
  }

  const valid = await verifyToken(token, c.env.JWT_SECRET)

  if (!valid) {
    return c.json({ error: '验证令牌无效或已过期，请重新验证', code: 'CAPTCHA_INVALID' }, 403)
  }

  await next()
}
