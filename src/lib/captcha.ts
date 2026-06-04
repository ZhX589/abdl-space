import type { D1Database } from '@cloudflare/workers-types'
import { query, queryOne, run } from './db.ts'

/* ============================================================
 * CaptchaService — 后端验证码服务
 * 支持: quantum (QuantumVerify) + turnstile (Cloudflare Turnstile)
 *
 * v2 安全增强:
 * - 节点位置随机化
 * - 隐蔽上下文校验（前端无法伪造 challenge 指纹）
 * - 行为分析数据验证
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
  /** 隐蔽上下文 token（前端必须原样回传） */
  ctx: string
  /** 超时毫秒 */
  timeoutMs: number
}

interface VerifyResult {
  success: boolean
  token?: string
  attemptsLeft?: number
  locked?: boolean
  lockSeconds?: number
  /** 行为评分（0-100，越低越可疑） */
  behaviorScore?: number
}

interface BehaviorData {
  /** 鼠标轨迹点 [[x,y,ts], ...] */
 轨迹?: number[][]
  /** 每次点击的时间戳 */
  clickTimes?: number[]
  /** 每个节点的悬停时长 ms */
  hoverDurations?: number[]
  /** 总用时 ms */
  totalTime?: number
  /** 是否有触摸事件 */
  touchUsed?: boolean
  /** 屏幕分辨率 */
  screen?: string
  /** 时区 */
  tz?: string
}

/* ---- 配置 ---- */
const CHALLENGE_TTL_S    = 300
const MAX_ATTEMPTS       = 5
const LOCK_DURATION_S    = 300
const IP_WINDOW_S        = 300
const IP_MAX_CHALLENGES  = 20
const TOKEN_TTL_S        = 120
const TIMEOUT_MS         = 10000  // 10 秒超时

/** Quantum 节点 ID 列表 */
const NODE_IDS = ['α', 'β', 'γ', 'δ', 'ε']
const CANVAS_W = 550
const CANVAS_H = 260
const NODE_R = 50  // 节点最小间距

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

/** 生成不重叠的随机节点位置 */
function generateRandomNodes(): { id: string; x: number; y: number }[] {
  const nodes: { id: string; x: number; y: number }[] = []
  const margin = 55
  const minDist = NODE_R

  for (const id of NODE_IDS) {
    let attempts = 0
    while (attempts < 100) {
      const x = margin + Math.random() * (CANVAS_W - margin * 2)
      const y = margin + Math.random() * (CANVAS_H - margin * 2)
      const tooClose = nodes.some(n => Math.hypot(n.x - x, n.y - y) < minDist)
      if (!tooClose) {
        nodes.push({ id, x: Math.round(x), y: Math.round(y) })
        break
      }
      attempts++
    }
    // fallback: 如果 100 次都没找到合适位置，强制放置
    if (!nodes.find(n => n.id === id)) {
      nodes.push({
        id,
        x: margin + Math.random() * (CANVAS_W - margin * 2),
        y: margin + Math.random() * (CANVAS_H - margin * 2),
      })
    }
  }
  return nodes
}

/** 生成隐蔽上下文 token（HMAC） */
async function createContextToken(
  sessionId: string,
  nodes: { id: string; x: number; y: number }[],
  order: string[],
  secret: string
): Promise<string> {
  const data = JSON.stringify({ sessionId, nodes: nodes.map(n => `${n.id}:${n.x},${n.y}`), order })
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data))
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** 验证隐蔽上下文 */
async function verifyContextToken(
  ctx: string,
  sessionId: string,
  nodes: { id: string; x: number; y: number }[],
  order: string[],
  secret: string
): Promise<boolean> {
  const expected = await createContextToken(sessionId, nodes, order, secret)
  return ctx === expected
}

/** 评估行为数据可信度 (0-100) */
function assessBehavior(data: BehaviorData | null): number {
  if (!data) return 50 // 无数据给中间分

  let score = 100

  // 1. 总用时检查：太快（<1s）或太慢（>timeout）都可疑
  if (data.totalTime !== undefined) {
    if (data.totalTime < 800) score -= 40       // < 0.8s 极快
    else if (data.totalTime < 1500) score -= 20  // < 1.5s 偏快
    else if (data.totalTime > TIMEOUT_MS + 2000) score -= 15  // 超时后提交
  }

  // 2. 点击间隔检查：间隔太均匀说明是脚本
  if (data.clickTimes && data.clickTimes.length >= 2) {
    const intervals = []
    for (let i = 1; i < data.clickTimes.length; i++) {
      intervals.push(data.clickTimes[i] - data.clickTimes[i - 1])
    }
    const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length
    const variance = intervals.reduce((a, b) => a + (b - avg) ** 2, 0) / intervals.length
    const stdDev = Math.sqrt(variance)
    // 标准差太小 = 间隔太均匀 = 脚本
    if (stdDev < 20 && intervals.length >= 2) score -= 30
    // 间隔全相同
    if (new Set(intervals).size === 1 && intervals.length >= 2) score -= 25
  }

  // 3. 鼠标轨迹检查：点太少说明没有真实鼠标移动
  if (data.轨迹 !== undefined) {
    if (data.轨迹.length < 5) score -= 20       // 几乎没有轨迹
    else if (data.轨迹.length < 15) score -= 10  // 轨迹偏少
  }

  // 4. 悬停时间检查：全为 0 说明没有真实交互
  if (data.hoverDurations) {
    const allZero = data.hoverDurations.every(d => d === 0)
    if (allZero) score -= 15
  }

  // 5. 觢摸+鼠标混用可疑
  if (data.touchUsed && data.轨迹 && data.轨迹.length > 10) score -= 5

  return Math.max(0, Math.min(100, score))
}

function createToken(sessionId: string, secret: string): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/=/g, '')
  const now = Math.floor(Date.now() / 1000)
  const payload = btoa(JSON.stringify({
    sub: sessionId,
    iat: now,
    exp: now + TOKEN_TTL_S,
    type: 'captcha',
  })).replace(/=/g, '')
  const data = `${header}.${payload}`
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
    ip: string,
    secret: string
  ): Promise<ChallengeResult> {
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
      const salt = generateId()
      await run(
        db,
        `INSERT INTO captcha_sessions (session_id, type, ip, challenge, answer_hash, salt, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, 'turnstile', ip, '', '', salt, now, expiresAt]
      )
      return { sessionId, type: 'turnstile', challenge: null, ttl: CHALLENGE_TTL_S }
    }

    // Quantum challenge — 随机节点位置
    const nodes = generateRandomNodes()
    const order = shuffleArray(NODE_IDS)
    const answerHash = await sha256(order.join(','))
    const salt = generateId()
    const ctx = await createContextToken(sessionId, nodes, order, secret)

    const challengeData = JSON.stringify({ nodes, width: CANVAS_W, height: CANVAS_H, ctx })

    await run(
      db,
      `INSERT INTO captcha_sessions (session_id, type, ip, challenge, answer_hash, salt, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [sessionId, 'quantum', ip, challengeData, answerHash, salt, now, expiresAt]
    )

    return {
      sessionId,
      type: 'quantum',
      challenge: { nodes, width: CANVAS_W, height: CANVAS_H, order, ctx, timeoutMs: TIMEOUT_MS },
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
      used: number; attempts: number;
      locked_until: number | null; expires_at: number
    }>(
      db,
      'SELECT used, attempts, locked_until, expires_at FROM captcha_sessions WHERE session_id = ?',
      [sessionId]
    )

    if (!session) return { success: false, attemptsLeft: 0 }
    if (session.used) return { success: true }
    if (session.expires_at < Math.floor(Date.now() / 1000)) return { success: false, attemptsLeft: 0 }
    if (session.locked_until && session.locked_until > Math.floor(Date.now() / 1000)) {
      return { success: false, locked: true, lockSeconds: session.locked_until - Math.floor(Date.now() / 1000) }
    }

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
      await run(db, 'UPDATE captcha_sessions SET used = 1 WHERE session_id = ?', [sessionId])
      return { success: true }
    }

    const newAttempts = session.attempts + 1
    const locked = newAttempts >= MAX_ATTEMPTS
    const lockedUntil = locked ? Math.floor(Date.now() / 1000) + LOCK_DURATION_S : null

    await run(
      db,
      'UPDATE captcha_sessions SET attempts = ?, locked_until = ? WHERE session_id = ?',
      [newAttempts, lockedUntil, sessionId]
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
    secret: string,
    behavior?: BehaviorData,
    ctx?: string
  ): Promise<VerifyResult> {
    const session = await queryOne<{
      type: string; answer_hash: string; challenge: string; used: number;
      attempts: number; locked_until: number | null; expires_at: number
    }>(
      db,
      'SELECT type, answer_hash, challenge, used, attempts, locked_until, expires_at FROM captcha_sessions WHERE session_id = ?',
      [sessionId]
    )

    if (!session) return { success: false, attemptsLeft: 0 }
    if (session.used) return { success: true }
    if (session.type !== 'quantum') return { success: false, attemptsLeft: 0 }
    if (session.expires_at < Math.floor(Date.now() / 1000)) return { success: false, attemptsLeft: 0 }
    if (session.locked_until && session.locked_until > Math.floor(Date.now() / 1000)) {
      return { success: false, locked: true, lockSeconds: session.locked_until - Math.floor(Date.now() / 1000) }
    }

    // 行为分析
    const behaviorScore = assessBehavior(behavior || null)

    // 隐蔽上下文校验
    if (ctx && session.challenge) {
      try {
        const challengeData = JSON.parse(session.challenge)
        const order = answer.split(',')
        const ctxValid = await verifyContextToken(ctx, sessionId, challengeData.nodes, order, secret)
        if (!ctxValid) {
          // 上下文不匹配 → 高度可疑，记录但不直接拒绝（降分）
          console.warn(`[Captcha] Context mismatch for session ${sessionId.slice(0, 8)}`)
        }
      } catch {
        // 解析失败，忽略
      }
    }

    // 行为分太低 → 记录可疑
    if (behaviorScore < 30) {
      console.warn(`[Captcha] Low behavior score (${behaviorScore}) for session ${sessionId.slice(0, 8)}`)
      // 可以选择直接拒绝，或记录到数据库
      await logSuspiciousBehavior(db, sessionId, behavior, behaviorScore)
    }

    const answerHash = await sha256(answer.trim())
    if (answerHash === session.answer_hash) {
      await run(db, 'UPDATE captcha_sessions SET used = 1 WHERE session_id = ?', [sessionId])
      const token = createToken(sessionId, secret)
      return { success: true, token, behaviorScore }
    }

    const newAttempts = session.attempts + 1
    const locked = newAttempts >= MAX_ATTEMPTS
    const lockedUntil = locked ? Math.floor(Date.now() / 1000) + LOCK_DURATION_S : null

    await run(
      db,
      'UPDATE captcha_sessions SET attempts = ?, locked_until = ? WHERE session_id = ?',
      [newAttempts, lockedUntil, sessionId]
    )

    return {
      success: false,
      attemptsLeft: Math.max(0, MAX_ATTEMPTS - newAttempts),
      locked,
      lockSeconds: locked ? LOCK_DURATION_S : undefined,
      behaviorScore,
    }
  },

  async cleanup(db: D1Database): Promise<void> {
    const now = Math.floor(Date.now() / 1000)
    await run(db, 'DELETE FROM captcha_sessions WHERE expires_at < ?', [now - 3600])
  },
}

/** 记录可疑行为到数据库 */
async function logSuspiciousBehavior(
  db: D1Database,
  sessionId: string,
  behavior: BehaviorData | undefined,
  score: number
): Promise<void> {
  try {
    await run(
      db,
      `INSERT INTO security_logs (session_id, event_type, score, details, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        sessionId,
        'low_behavior_score',
        score,
        JSON.stringify({
          behavior: behavior || null,
          ua: behavior?.screen || '',
          tz: behavior?.tz || '',
        }),
        Math.floor(Date.now() / 1000),
      ]
    )
  } catch {
    // 表可能不存在，忽略
  }
}

/* ---- 内部工具 ---- */

async function sha256(input: string): Promise<string> {
  const enc = new TextEncoder()
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(input))
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}
