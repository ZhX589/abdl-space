import type { D1Database } from '@cloudflare/workers-types'
import { query, queryOne, run } from './db.ts'

/* ============================================================
 * CaptchaService — 后端验证码服务
 * 支持多种验证类型，当前实现: quantum (QuantumVerify 节点序列)
 * ============================================================ */

export type CaptchaType = 'quantum'

interface ChallengeResult {
  sessionId: string
  type: CaptchaType
  challenge: QuantumChallenge
  ttl: number
}

interface QuantumChallenge {
  /** 节点定义（位置/标签） */
  nodes: { id: string; x: number; y: number }[]
  /** canvas 尺寸 */
  width: number
  height: number
  /** 正确节点顺序（前端用于高亮渲染） */
  order: string[]
}

interface VerifyResult {
  success: boolean
  token?: string       // 一次性验证令牌 (JWT)
  attemptsLeft?: number
  locked?: boolean
  lockSeconds?: number
}

/* ---- 配置 ---- */
const CHALLENGE_TTL_S    = 300    // 挑战有效期 5 分钟
const MAX_ATTEMPTS       = 5
const LOCK_DURATION_S    = 300    // 锁定时长 5 分钟
const IP_WINDOW_S        = 300    // IP 限速窗口
const IP_MAX_CHALLENGES  = 20     // 窗口内最大 challenge 请求数
const TOKEN_TTL_S        = 120    // 一次性令牌有效期 2 分钟

/** Quantum 节点定义（与前端一致） */
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

function shuffle(arr: string[]): string[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(input)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function getClientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  return c.req.header('CF-Connecting-IP')
    || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim()
    || 'unknown'
}

/* ---- 签发一次性验证令牌 ---- */

async function signCaptchaToken(sessionId: string, secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' }
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    sub: sessionId,
    typ: 'captcha',
    iat: now,
    exp: now + TOKEN_TTL_S,
  }

  const encoder = new TextEncoder()
  const headerB64 = btoa(JSON.stringify(header)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const payloadB64 = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const signInput = `${headerB64}.${payloadB64}`

  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(signInput))
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  return `${signInput}.${sigB64}`
}

/** 验证一次性 captcha token（业务中间件调用） */
export async function verifyCaptchaToken(token: string, secret: string): Promise<boolean> {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return false

    const [headerB64, payloadB64, sigB64] = parts
    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    )

    const sigStr = sigB64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (sigB64.length % 4)) % 4)
    const sigBytes = Uint8Array.from(atob(sigStr), c => c.charCodeAt(0))

    const valid = await crypto.subtle.verify(
      'HMAC', key, sigBytes, encoder.encode(`${headerB64}.${payloadB64}`)
    )
    if (!valid) return false

    const payloadStr = payloadB64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (payloadB64.length % 4)) % 4)
    const payload = JSON.parse(atob(payloadStr))

    if (payload.typ !== 'captcha') return false
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return false

    return true
  } catch {
    return false
  }
}

/* ============================================================
 * CaptchaService 类
 * ============================================================ */

export class CaptchaService {
  /**
   * 创建一个新的验证挑战
   */
  async createChallenge(
    db: D1Database,
    type: CaptchaType,
    ip: string
  ): Promise<ChallengeResult> {
    // IP 限速
    await this.enforceIpLimit(db, ip)

    const sessionId = generateId()
    const now = nowSeconds()

    if (type === 'quantum') {
      const order = shuffle(['α', 'β', 'γ', 'δ', 'ε'])
      const answerStr = order.join(',')
      const salt = generateId().slice(0, 16)
      const answerHash = await sha256(answerStr + salt)

      const challenge: QuantumChallenge = {
        nodes: QUANTUM_NODES,
        width: QUANTUM_WIDTH,
        height: QUANTUM_HEIGHT,
        order,  // 包含在返回中，前端需要用于高亮渲染
      }

      await run(db,
        `INSERT INTO captcha_sessions
          (session_id, type, challenge, answer_hash, salt, attempts, max_attempts,
           locked_until, ip, created_at, expires_at, used)
         VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?, 0)`,
        [
          sessionId,
          type,
          JSON.stringify({ ...challenge }),  // 完整挑战数据（含 order）存库
          answerHash,
          salt,
          MAX_ATTEMPTS,
          ip,
          now,
          now + CHALLENGE_TTL_S,
        ]
      )

      return {
        sessionId,
        type,
        challenge,   // 返回给前端（含 order，用于高亮渲染）
        ttl: CHALLENGE_TTL_S,
      }
    }

    throw new Error(`Unsupported captcha type: ${type}`)
  }

  /**
   * 验证用户提交的答案
   */
  async verify(
    db: D1Database,
    sessionId: string,
    answer: string,
    secret: string
  ): Promise<VerifyResult> {
    const session = await queryOne<{
      type: string
      answer_hash: string
      salt: string
      attempts: number
      max_attempts: number
      locked_until: number
      expires_at: number
      used: number
    }>(
      db,
      'SELECT type, answer_hash, salt, attempts, max_attempts, locked_until, expires_at, used FROM captcha_sessions WHERE session_id = ?',
      [sessionId]
    )

    if (!session) {
      return { success: false, attemptsLeft: 0 }
    }

    // 已使用
    if (session.used) {
      return { success: false, attemptsLeft: 0 }
    }

    // 已过期
    if (nowSeconds() > session.expires_at) {
      return { success: false, attemptsLeft: 0 }
    }

    // 已锁定
    if (session.locked_until > 0 && Date.now() / 1000 < session.locked_until) {
      const lockSec = Math.ceil(session.locked_until - Date.now() / 1000)
      return { success: false, locked: true, lockSeconds: lockSec, attemptsLeft: 0 }
    }

    // 校验答案
    const answerHash = await sha256(answer + session.salt)
    const isCorrect = answerHash === session.answer_hash

    if (isCorrect) {
      // 标记已使用
      await run(db,
        'UPDATE captcha_sessions SET used = 1 WHERE session_id = ?',
        [sessionId]
      )
      // 签发一次性令牌
      const token = await signCaptchaToken(sessionId, secret)
      return { success: true, token }
    }

    // 答案错误
    const newAttempts = session.attempts + 1
    const attemptsLeft = Math.max(0, session.max_attempts - newAttempts)

    if (newAttempts >= session.max_attempts) {
      // 锁定
      const lockUntil = nowSeconds() + LOCK_DURATION_S
      await run(db,
        'UPDATE captcha_sessions SET attempts = ?, locked_until = ? WHERE session_id = ?',
        [newAttempts, lockUntil, sessionId]
      )
      return { success: false, locked: true, lockSeconds: LOCK_DURATION_S, attemptsLeft: 0 }
    }

    await run(db,
      'UPDATE captcha_sessions SET attempts = ? WHERE session_id = ?',
      [newAttempts, sessionId]
    )
    return { success: false, attemptsLeft }
  }

  /**
   * IP 频率限制
   */
  private async enforceIpLimit(db: D1Database, ip: string): Promise<void> {
    const cutoff = nowSeconds() - IP_WINDOW_S
    const row = await queryOne<{ cnt: number }>(
      db,
      'SELECT COUNT(*) as cnt FROM captcha_sessions WHERE ip = ? AND created_at > ?',
      [ip, cutoff]
    )
    if (row && row.cnt >= IP_MAX_CHALLENGES) {
      throw new Error('RATE_LIMITED')
    }
  }

  /**
   * 清理过期会话（可在请求时懒调用）
   */
  async cleanup(db: D1Database): Promise<number> {
    const now = nowSeconds()
    const result = await run(db,
      'DELETE FROM captcha_sessions WHERE expires_at < ?',
      [now]
    )
    return result.meta.changes ?? 0
  }
}

export const captchaService = new CaptchaService()
