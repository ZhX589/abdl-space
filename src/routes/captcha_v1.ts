import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Env } from '../types/index.ts'
import { captchaService } from '../lib/captcha.ts'
import { validateApiKey, recordKeyUsage } from './captcha_keys.ts'
import { rateLimit } from '../lib/rate-limit.ts'
import { assessRisk } from '../lib/risk-assessment.ts'
import { EMBED_JS } from '../lib/embed-bundle.ts'

type AppType = { Bindings: Env }

const captchaV1 = new Hono<AppType>()

// 外部 API 允许任意来源（API Key 鉴权，不需要 cookie）
captchaV1.use('*', cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'OPTIONS'],
}))

// 限速：每 API Key 每分钟 60 次（通过 IP 限速，API Key 限速在服务端逻辑中）
captchaV1.use('*', rateLimit('v1-captcha', 60_000, 120))

/**
 * GET /api/v1/captcha/embed.js — 嵌入式 SDK 脚本
 * 第三方开发者通过 <script src="https://api.abdl-space.top/api/v1/captcha/embed.js"></script> 引入
 */
captchaV1.get('/embed.js', (c) => {
  return new Response(EMBED_JS, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    },
  })
})

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
  const type = (body.type || 'quantum') as 'quantum' | 'turnstile'
  if (type !== 'quantum' && type !== 'turnstile') return c.json({ error: `Unsupported type: ${type}` }, 400)

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
 * POST /api/v1/captcha/risk — 获取风险等级
 * Headers: Authorization: Bearer cv_xxxx
 * Response: { risk, flow, turnstile_site_key }
 */
captchaV1.post('/risk', async (c) => {
  const rawKey = extractApiKey(c)
  if (!rawKey) return c.json({ error: 'Missing Authorization header' }, 401)

  const keyInfo = await validateApiKey(c.env.abdl_space_db, rawKey)
  if (!keyInfo.valid) return c.json({ error: 'Invalid or disabled API key' }, 401)

  c.executionCtx.waitUntil(recordKeyUsage(c.env.abdl_space_db, keyInfo.keyId!))

  const ip = getClientIp(c)
  const ua = c.req.header('User-Agent')
  const { level } = await assessRisk(c.env.abdl_space_db, ip, ua)

  let flow: 'turnstile' | 'quantum' | 'both'
  if (level === 'high') {
    flow = 'both'
  } else {
    flow = Math.random() < 0.5 ? 'turnstile' : 'quantum'
  }

  return c.json({
    risk: level,
    flow,
    turnstile_site_key: c.env.TURNSTILE_SITE_KEY || '',
  })
})

/**
 * POST /api/v1/captcha/turnstile/verify — 验证 Turnstile
 * Headers: Authorization: Bearer cv_xxxx
 * Body: { session_id, token }
 * Response: { verified, attempts_left?, locked?, lock_seconds? }
 */
captchaV1.post('/turnstile/verify', async (c) => {
  const rawKey = extractApiKey(c)
  if (!rawKey) return c.json({ error: 'Missing Authorization header' }, 401)

  const keyInfo = await validateApiKey(c.env.abdl_space_db, rawKey)
  if (!keyInfo.valid) return c.json({ error: 'Invalid or disabled API key' }, 401)

  c.executionCtx.waitUntil(recordKeyUsage(c.env.abdl_space_db, keyInfo.keyId!))

  const ip = getClientIp(c)
  let body: { session_id?: string; token?: string }
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid body' }, 400) }

  const { session_id, token } = body
  if (!session_id || !token) return c.json({ error: 'session_id and token are required' }, 400)

  const secretKey = c.env.TURNSTILE_SECRET_KEY
  if (!secretKey) return c.json({ error: 'Turnstile not configured' }, 500)

  try {
    const result = await captchaService.verifyTurnstile(
      c.env.abdl_space_db, session_id, token, ip, secretKey
    )
    return c.json({
      verified: result.success,
      attempts_left: result.attemptsLeft,
      locked: result.locked || undefined,
      lock_seconds: result.lockSeconds || undefined,
    })
  } catch (err) {
    console.error('v1 turnstile verify error:', err)
    return c.json({ error: 'Internal error' }, 500)
  }
})

/**
 * GET /api/v1/captcha/types — 可用验证类型列表
 */
captchaV1.get('/types', (c) => {
  return c.json({ types: ['quantum', 'turnstile'] })
})

export default captchaV1
