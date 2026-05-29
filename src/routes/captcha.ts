import { Hono } from 'hono'
import type { Env } from '../types/index.ts'
import { captchaService } from '../lib/captcha.ts'
import { rateLimit } from '../lib/rate-limit.ts'
import { assessRisk } from '../lib/risk-assessment.ts'
import type { RiskLevel } from '../lib/risk-assessment.ts'

type AppType = { Bindings: Env }

const captcha = new Hono<AppType>()

// 限速
captcha.use('/challenge', rateLimit('captcha-challenge', 60_000, 30))
captcha.use('/verify', rateLimit('captcha-verify', 60_000, 60))
captcha.use('/risk', rateLimit('captcha-risk', 60_000, 60))
captcha.use('/turnstile/verify', rateLimit('captcha-turnstile', 60_000, 60))

/* ============================================================
 * POST /api/captcha/risk — 获取风险等级和验证流程
 *
 * 前端调用此接口获取当前 IP 的风险等级，决定验证流程：
 * - low:  随机选择 turnstile 或 quantum
 * - high: 先 turnstile，再 quantum
 *
 * Response: {
 *   risk: 'low' | 'high',
 *   flow: 'turnstile' | 'quantum' | 'both',
 *   turnstile_site_key: string  // 前端需要
 * }
 */
captcha.post('/risk', async (c) => {
  const ip = c.req.header('CF-Connecting-IP')
    || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim()
    || 'unknown'
  const ua = c.req.header('User-Agent')

  const { level } = await assessRisk(c.env.abdl_space_db, ip, ua)

  let flow: 'turnstile' | 'quantum' | 'both'
  if (level === 'high') {
    flow = 'both'
  } else {
    // 低风险: 随机选择
    flow = Math.random() < 0.5 ? 'turnstile' : 'quantum'
  }

  return c.json({
    risk: level,
    flow,
    turnstile_site_key: c.env.TURNSTILE_SITE_KEY || '',
  })
})

/* ============================================================
 * POST /api/captcha/challenge — 创建验证挑战
 *
 * Body: { type?: 'quantum' | 'turnstile' }
 * Response: { session_id, type, challenge?, ttl }
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

  const type = (body.type || 'quantum') as 'quantum' | 'turnstile'

  if (type !== 'quantum' && type !== 'turnstile') {
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

/* ============================================================
 * POST /api/captcha/verify — 验证 Quantum 答案
 *
 * Body: { session_id, answer }
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

/* ============================================================
 * POST /api/captcha/turnstile/verify — 验证 Turnstile token
 *
 * Body: { session_id, token }
 * Response: { success, attempts_left?, locked?, lock_seconds? }
 */
captcha.post('/turnstile/verify', async (c) => {
  const ip = c.req.header('CF-Connecting-IP')
    || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim()
    || 'unknown'

  let body: { session_id?: string; token?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid request body' }, 400)
  }

  const { session_id, token } = body

  if (!session_id || !token) {
    return c.json({ error: 'session_id and token are required' }, 400)
  }

  const secretKey = c.env.TURNSTILE_SECRET_KEY
  if (!secretKey) {
    console.error('TURNSTILE_SECRET_KEY not configured')
    return c.json({ error: '验证码服务未配置' }, 500)
  }

  try {
    const result = await captchaService.verifyTurnstile(
      c.env.abdl_space_db,
      session_id,
      token,
      ip,
      secretKey
    )
    return c.json({
      success: result.success,
      attempts_left: result.attemptsLeft,
      locked: result.locked || undefined,
      lock_seconds: result.lockSeconds || undefined,
    })
  } catch (err) {
    console.error('turnstile verify error:', err)
    return c.json({ error: '验证码服务异常' }, 500)
  }
})

/**
 * GET /api/captcha/status — 健康检查
 */
captcha.get('/status', (c) => {
  return c.json({
    status: 'ok',
    types: ['quantum', 'turnstile'],
    turnstile_configured: !!c.env.TURNSTILE_SITE_KEY,
    version: '2.0.0',
  })
})

export default captcha
