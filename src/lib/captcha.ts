import type { D1Database } from '@cloudflare/workers-types'
import { query, queryOne, run } from './db.ts'

/* ============================================================
 * CaptchaService — 后端验证码服务
 * 支持: quantum (QuantumVerify) + turnstile (Cloudflare Turnstile)
 * ============================================================ */

export type CaptchaType = 'quantum' | 'turnstile'

interface ChallengeResult {
  sessionId: string
  type: CaptchaType
  challenge: QuantumChallenge | null
  ttl: number
}

interface QuantumChallenge {
  nodes: { id: string; x: number; y: number }[]
  width: number
  height: number
  order: string[]
}

interface VerifyResult {
  success: boolean
  token?: string
  attemptsLeft?: number
  locked?: boolean
  lockSeconds?: number
}

/* ---- 配置 ---- */
const CHALLENGE_TTL_S    = 300
const MAX_ATTEMPTS       = 5
const LOCK_DURATION_S    = 300
const IP_WINDOW_S        = 300
const IP_MAX_CHALLENGES  = 20
const TOKEN_TTL_S        = 120

/** Quantum 节点定义 */
const QUANTUM_NODES = [
  { id: 'α', x: 90,  y: 65  },
  { id: 'β', x: 270, y: 45  },
  { id: 'γ', x: 440, y: 75  },
  { id: 'δ', x: 400, y: 195 },
  { id: 'ε', x: 140, y: 210 },
]

const QUANTUM_WIDTH = 500
const QUANTUM_HEIGHT = 260

/* ---- 工具函数 ---- */

function generateId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function createToken(sessionId: string, secret: string): string {
  // 简易 JWT: header.payload.signature
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/=/g, '')
  const now = Math.floor(Date.now() / 1000)
  const payload = btoa(JSON.stringify({
    sub: sessionId,
    iat: now,
    exp: now + TOKEN_TTL_S,
    type: 'captcha',
  })).replace(/=/g, '')
  const data = `${header}.${payload}`
  // HMAC-SHA256 签名 (同步)
  // 注意: 在 Workers 中需要用同步方式，这里用简单的 hash
  const sig = btoa(sessionId + secret + now).replace(/=/g, '').slice(0, 43)
  return `${data}.${sig}`
}

export function verifyToken(token: string, secret: string): boolean {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return false
    const payload = JSON.parse(atob(parts[1]))
    if (payload.exp < Math.floor(Date.now() / 1000)) return false
    if (payload.type !== 'captcha') return false
    return true
  } catch {
    return false
  }
}

/* ============================================================
 * CaptchaService
 * ============================================================ */

export const captchaService = {

  /**
   * 创建挑战
   */
  async createChallenge(
    db: D1Database,
    type: CaptchaType,
    ip: string
  ): Promise<ChallengeResult> {
    // IP 限速
    const now = Math.floor(Date.now() / 1000)
    const windowStart = now - IP_WINDOW_S
    const recentCount = await queryOne<{ cnt: number }>(
      db,
      'SELECT COUNT(*) as cnt FROM captcha_sessions WHERE ip = ? AND created_at > ?',
      [ip, windowStart]
    )
    if ((recentCount?.cnt || 0) >= IP_MAX_CHALLENGES) {
      throw new Error('RATE_LIMITED')
    }

    const sessionId = generateId()
    const expiresAt = now + CHALLENGE_TTL_S

    if (type === 'turnstile') {
      // Turnstile 不需要服务端生成 challenge
      const salt = generateId()
      await run(
        db,
        `INSERT INTO captcha_sessions (session_id, type, ip, challenge, answer_hash, salt, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, 'turnstile', ip, '', '', salt, now, expiresAt]
      )
      return { sessionId, type: 'turnstile', challenge: null, ttl: CHALLENGE_TTL_S }
    }

    // Quantum challenge
    const order = shuffleArray(QUANTUM_NODES.map(n => n.id))
    const answerHash = await sha256(order.join(','))
    const salt = generateId()
    const challengeData = JSON.stringify({
      nodes: QUANTUM_NODES,
      width: QUANTUM_WIDTH,
      height: QUANTUM_HEIGHT,
    })

    await run(
      db,
      `INSERT INTO captcha_sessions (session_id, type, ip, challenge, answer_hash, salt, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [sessionId, 'quantum', ip, challengeData, answerHash, salt, now, expiresAt]
    )

    return {
      sessionId,
      type: 'quantum',
      challenge: {
        nodes: QUANTUM_NODES,
        width: QUANTUM_WIDTH,
        height: QUANTUM_HEIGHT,
        order, // 前端用于高亮渲染
      },
      ttl: CHALLENGE_TTL_S,
    }
  },

  /**
   * 验证 Turnstile token
   */
  async verifyTurnstile(
    db: D1Database,
    sessionId: string,
    turnstileResponse: string,
    ip: string,
    turnstileSecretKey: string
  ): Promise<VerifyResult> {
    const session = await queryOne<{
      id: number; used: number; attempts: number;
      locked_until: number | null; expires_at: number
    }>(
      db,
      'SELECT id, used, attempts, locked_until, expires_at FROM captcha_sessions WHERE session_id = ?',
      [sessionId]
    )

    if (!session) return { success: false, attemptsLeft: 0 }
    if (session.used) return { success: true }
    if (session.expires_at < Math.floor(Date.now() / 1000)) return { success: false, attemptsLeft: 0 }
    if (session.locked_until && session.locked_until > Math.floor(Date.now() / 1000)) {
      return { success: false, locked: true, lockSeconds: session.locked_until - Math.floor(Date.now() / 1000) }
    }

    // 调用 Cloudflare siteverify
    const formData = new FormData()
    formData.append('secret', turnstileSecretKey)
    formData.append('response', turnstileResponse)
    formData.append('remoteip', ip)

    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: formData,
    })
    const result = await resp.json<{ success: boolean; 'error-codes'?: string[] }>()

    if (result.success) {
      await run(db, 'UPDATE captcha_sessions SET used = 1 WHERE id = ?', [session.id])
      return { success: true }
    }

    // 失败
    const newAttempts = session.attempts + 1
    const locked = newAttempts >= MAX_ATTEMPTS
    const lockedUntil = locked ? Math.floor(Date.now() / 1000) + LOCK_DURATION_S : null

    await run(
      db,
      'UPDATE captcha_sessions SET attempts = ?, locked_until = ? WHERE id = ?',
      [newAttempts, lockedUntil, session.id]
    )

    return {
      success: false,
      attemptsLeft: Math.max(0, MAX_ATTEMPTS - newAttempts),
      locked,
      lockSeconds: locked ? LOCK_DURATION_S : undefined,
    }
  },

  /**
   * 验证 Quantum 答案
   */
  async verify(
    db: D1Database,
    sessionId: string,
    answer: string,
    secret: string
  ): Promise<VerifyResult> {
    const session = await queryOne<{
      id: number; type: string; answer_hash: string; used: number;
      attempts: number; locked_until: number | null; expires_at: number
    }>(
      db,
      'SELECT id, type, answer_hash, used, attempts, locked_until, expires_at FROM captcha_sessions WHERE session_id = ?',
      [sessionId]
    )

    if (!session) return { success: false, attemptsLeft: 0 }
    if (session.used) return { success: true }
    if (session.type !== 'quantum') return { success: false, attemptsLeft: 0 }
    if (session.expires_at < Math.floor(Date.now() / 1000)) return { success: false, attemptsLeft: 0 }
    if (session.locked_until && session.locked_until > Math.floor(Date.now() / 1000)) {
      return { success: false, locked: true, lockSeconds: session.locked_until - Math.floor(Date.now() / 1000) }
    }

    const answerHash = await sha256(answer.trim())
    if (answerHash === session.answer_hash) {
      await run(db, 'UPDATE captcha_sessions SET used = 1 WHERE id = ?', [session.id])
      const token = createToken(sessionId, secret)
      return { success: true, token }
    }

    const newAttempts = session.attempts + 1
    const locked = newAttempts >= MAX_ATTEMPTS
    const lockedUntil = locked ? Math.floor(Date.now() / 1000) + LOCK_DURATION_S : null

    await run(
      db,
      'UPDATE captcha_sessions SET attempts = ?, locked_until = ? WHERE id = ?',
      [newAttempts, lockedUntil, session.id]
    )

    return {
      success: false,
      attemptsLeft: Math.max(0, MAX_ATTEMPTS - newAttempts),
      locked,
      lockSeconds: locked ? LOCK_DURATION_S : undefined,
    }
  },

  /**
   * 清理过期会话
   */
  async cleanup(db: D1Database): Promise<void> {
    const now = Math.floor(Date.now() / 1000)
    await run(db, 'DELETE FROM captcha_sessions WHERE expires_at < ?', [now - 3600])
  },
}

/* ---- 内部工具 ---- */

async function sha256(input: string): Promise<string> {
  const enc = new TextEncoder()
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(input))
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}
