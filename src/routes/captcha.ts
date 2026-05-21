import { Hono } from 'hono'
import type { Env } from '../types/index.ts'
import { captchaService } from '../lib/captcha.ts'

type AppType = { Bindings: Env }

const captcha = new Hono<AppType>()

/* ============================================================
 * 内部 API — 前端直连调用
 * ============================================================ */

/**
 * POST /api/captcha/challenge
 * Body: { type?: "quantum" }
 * Response: { session_id, challenge, ttl }
 */
captcha.post('/challenge', async (c) => {
  const ip = c.req.header('CF-Connecting-IP')
    || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim()
    || 'unknown'

  let body: { type?: string }
  try {
    body = await c.req.json()
  } catch {
    body = {}
  }

  const type = (body.type || 'quantum') as 'quantum'

  if (type !== 'quantum') {
    return c.json({ error: `Unsupported captcha type: ${type}` }, 400)
  }

  try {
    // 惰性清理过期会话（1% 概率）
    if (Math.random() < 0.01) {
      c.executionCtx.waitUntil(captchaService.cleanup(c.env.abdl_space_db))
    }

    const result = await captchaService.createChallenge(c.env.abdl_space_db, type, ip)
    return c.json({
      session_id: result.sessionId,
      type: result.type,
      challenge: result.challenge,
      ttl: result.ttl,
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg === 'RATE_LIMITED') {
      return c.json({ error: '请求过于频繁，请稍后再试' }, 429)
    }
    console.error('captcha challenge error:', err)
    return c.json({ error: '验证码服务异常' }, 500)
  }
})

/**
 * POST /api/captcha/verify
 * Body: { session_id: string, answer: string }
 * Response: { success, token?, attempts_left?, locked?, lock_seconds? }
 */
captcha.post('/verify', async (c) => {
  let body: { session_id?: string; answer?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid request body' }, 400)
  }

  const { session_id, answer } = body

  if (!session_id || typeof answer !== 'string') {
    return c.json({ error: 'session_id and answer are required' }, 400)
  }

  try {
    const result = await captchaService.verify(
      c.env.abdl_space_db,
      session_id,
      answer,
      c.env.JWT_SECRET
    )
    return c.json({
      success: result.success,
      token: result.token || undefined,
      attempts_left: result.attemptsLeft,
      locked: result.locked || undefined,
      lock_seconds: result.lockSeconds || undefined,
    })
  } catch (err) {
    console.error('captcha verify error:', err)
    return c.json({ error: '验证码服务异常' }, 500)
  }
})

/**
 * GET /api/captcha/status — 健康检查
 */
captcha.get('/status', (c) => {
  return c.json({
    status: 'ok',
    types: ['quantum'],
    version: '1.0.0',
  })
})

export default captcha
