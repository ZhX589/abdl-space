import { Hono } from 'hono'
import type { Env } from '../types/index.ts'
import { captchaService } from '../lib/captcha.ts'
import { validateApiKey, recordKeyUsage } from './captcha_keys.ts'

type AppType = { Bindings: Env }

const captchaV1 = new Hono<AppType>()

/** 从 Authorization: Bearer <key> 提取 key */
function extractApiKey(c: { req: { header: (name: string) => string | undefined } }): string | null {
  const auth = c.req.header('Authorization')
  if (!auth) return null
  const match = auth.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : null
}

function getClientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  return c.req.header('CF-Connecting-IP')
    || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim()
    || 'unknown'
}

/* ============================================================
 * 外部 API — 需要 API Key 鉴权
 * ============================================================ */

/**
 * POST /api/v1/captcha/create
 * Headers: Authorization: Bearer cv_xxxx
 * Body: { type?: "quantum" }
 * Response: { session_id, type, challenge, ttl }
 */
captchaV1.post('/create', async (c) => {
  const rawKey = extractApiKey(c)
  if (!rawKey) return c.json({ error: 'Missing Authorization header' }, 401)

  const keyInfo = await validateApiKey(c.env.abdl_space_db, rawKey)
  if (!keyInfo.valid) return c.json({ error: 'Invalid or disabled API key' }, 401)
  if (!keyInfo.permissions!.includes('create')) return c.json({ error: 'Key does not have "create" permission' }, 403)

  // 记录使用
  c.executionCtx.waitUntil(recordKeyUsage(c.env.abdl_space_db, keyInfo.keyId!))

  let body: { type?: string }
  try { body = await c.req.json() } catch { body = {} }
  const type = (body.type || 'quantum') as 'quantum'
  if (type !== 'quantum') return c.json({ error: `Unsupported type: ${type}` }, 400)

  const ip = getClientIp(c)
  try {
    const result = await captchaService.createChallenge(c.env.abdl_space_db, type, ip)
    return c.json({
      session_id: result.sessionId,
      type: result.type,
      challenge: result.challenge,
      ttl: result.ttl,
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg === 'RATE_LIMITED') return c.json({ error: 'Rate limited' }, 429)
    console.error('v1 captcha create error:', err)
    return c.json({ error: 'Internal error' }, 500)
  }
})

/**
 * POST /api/v1/captcha/check
 * Headers: Authorization: Bearer cv_xxxx
 * Body: { session_id: string, answer: string }
 * Response: { verified: boolean, token?: string }
 */
captchaV1.post('/check', async (c) => {
  const rawKey = extractApiKey(c)
  if (!rawKey) return c.json({ error: 'Missing Authorization header' }, 401)

  const keyInfo = await validateApiKey(c.env.abdl_space_db, rawKey)
  if (!keyInfo.valid) return c.json({ error: 'Invalid or disabled API key' }, 401)
  if (!keyInfo.permissions!.includes('check')) return c.json({ error: 'Key does not have "check" permission' }, 403)

  c.executionCtx.waitUntil(recordKeyUsage(c.env.abdl_space_db, keyInfo.keyId!))

  let body: { session_id?: string; answer?: string }
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid body' }, 400) }

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
      verified: result.success,
      token: result.token || undefined,
      attempts_left: result.attemptsLeft,
      locked: result.locked || undefined,
      lock_seconds: result.lockSeconds || undefined,
    })
  } catch (err) {
    console.error('v1 captcha check error:', err)
    return c.json({ error: 'Internal error' }, 500)
  }
})

/**
 * GET /api/v1/captcha/types — 可用验证类型列表
 */
captchaV1.get('/types', (c) => {
  return c.json({ types: ['quantum'] })
})

export default captchaV1
