/**
 * 创始成员计划 (Beta) 路由
 * - GET  /api/beta/info      — 获取活动信息（名额、截止时间、状态）
 * - POST /api/beta/beta-register — 创始成员预注册
 *
 * 与 /api/auth/register 差异：
 * 1. 注册成功后用户 is_beta_user = 1
 * 2. 注册时校验名额：未满员 + 未截止
 * 3. 邀请码仅作为身份记录，不发放奖励
 */
import { Hono } from 'hono'
import type { Env, JWTPayload, User } from '../types/index.ts'
import { hashPassword, signJWT } from '../lib/auth.ts'
import { queryOne, run } from '../lib/db.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const beta = new Hono<AppType>()

// 创始成员计划基础配置
const BETA_CONFIG = {
  name: 'ABDL Space 创始成员计划',
  capacity: 120,
  endsAt: '2026-07-31T23:59:59Z',
  status: 'active' as 'active' | 'full' | 'ended',
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/
const USERNAME_MIN = 2
const USERNAME_MAX = 32
const PASSWORD_MIN = 8

const tokenCookieOptions = 'HttpOnly; Secure; SameSite=None; Domain=.abdl-space.top; Path=/; Max-Age=604800'

/** 检查 Beta 计划是否还可注册（未满员 + 未截止） */
function checkBetaAvailability(now: Date, used: number): { ok: boolean; status: string; error?: string } {
  if (BETA_CONFIG.status === 'ended') {
    return { ok: false, status: 'ended', error: '活动已结束' }
  }
  if (new Date(BETA_CONFIG.endsAt) < now) {
    return { ok: false, status: 'ended', error: '活动已截止' }
  }
  if (used >= BETA_CONFIG.capacity) {
    return { ok: false, status: 'full', error: '名额已满' }
  }
  return { ok: true, status: 'active' }
}

// ============================================================
// GET /api/beta/info — 公开接口，获取活动信息
// ============================================================
beta.get('/info', async (c) => {
  try {
    // 统计当前创始成员数
    const result = await queryOne<{ count: number }>(
      c.env.abdl_space_db,
      'SELECT COUNT(*) AS count FROM users WHERE is_beta_user = 1',
    )
    const used = result?.count ?? 0

    const availability = checkBetaAvailability(new Date(), used)

    return c.json({
      name: BETA_CONFIG.name,
      endsAt: BETA_CONFIG.endsAt,
      capacity: BETA_CONFIG.capacity,
      used,
      status: availability.status,
    })
  } catch (e) {
    console.error('GET /api/beta/info error:', e)
    return c.json({
      name: BETA_CONFIG.name,
      endsAt: BETA_CONFIG.endsAt,
      capacity: BETA_CONFIG.capacity,
      used: 0,
      status: BETA_CONFIG.status,
    })
  }
})

// ============================================================
// POST /api/beta/beta-register — 创始成员预注册
// ============================================================
beta.post('/beta-register', async (c) => {
  try {
  const db = c.env.abdl_space_db
  const body = await c.req.json<{
    username: string
    email: string
    password: string
    code: string
    inviteCode?: string
    captchaToken?: string
  }>()
  const { username, email: emailAddress, password, code, inviteCode } = body

  if (!username || !emailAddress || !password || !code) {
    return c.json({ error: '请填写所有字段' }, 400)
  }
  if (!EMAIL_REGEX.test(emailAddress)) {
    return c.json({ error: '请输入有效的邮箱地址' }, 400)
  }
  if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
    return c.json({ error: `用户名 ${USERNAME_MIN}-${USERNAME_MAX} 个字符` }, 400)
  }
  if (password.length < PASSWORD_MIN || !PASSWORD_REGEX.test(password)) {
    return c.json({ error: '密码至少 8 位且需包含大小写字母和数字' }, 400)
  }
  if (code.length !== 6) {
    return c.json({ error: '请输入 6 位验证码' }, 400)
  }

  // 1. 校验名额 / 截止时间
  const countResult = await queryOne<{ count: number }>(
    db,
    'SELECT COUNT(*) AS count FROM users WHERE is_beta_user = 1',
  )
  const used = countResult?.count ?? 0
  const availability = checkBetaAvailability(new Date(), used)
  if (!availability.ok) {
    return c.json({ error: availability.error || '活动不可用', code: `beta_${availability.status}` }, 403)
  }

  // 2. 校验邮箱验证码
  const codeHash = await sha256(code)
  const record = await queryOne<{ id: number; attempts: number }>(
    db,
    `SELECT id, attempts FROM email_verifications
     WHERE email = ? AND code_hash = ? AND type = 'register' AND used = 0
     AND expires_at > datetime('now')
     ORDER BY id DESC LIMIT 1`,
    [emailAddress, codeHash],
  )
  if (!record) {
    return c.json({ error: '验证码无效或已过期' }, 400)
  }
  if (record.attempts >= 5) {
    await run(db, 'UPDATE email_verifications SET used = 1 WHERE id = ?', [record.id])
    return c.json({ error: '验证码尝试次数过多，请重新获取' }, 429)
  }
  await run(db, 'UPDATE email_verifications SET attempts = attempts + 1, used = 1 WHERE id = ?', [record.id])

  // 3. 检查用户名/邮箱是否已存在
  const existing = await queryOne<User>(
    db,
    'SELECT id FROM users WHERE email = ? OR username = ?',
    [emailAddress, username],
  )
  if (existing) {
    return c.json({ error: '注册信息已被使用，请更换邮箱或用户名' }, 409)
  }

  // 4. 再次检查名额（防并发超额）
  const finalCount = await queryOne<{ count: number }>(
    db,
    'SELECT COUNT(*) AS count FROM users WHERE is_beta_user = 1',
  )
  if ((finalCount?.count ?? 0) >= BETA_CONFIG.capacity) {
    return c.json({ error: '名额已满', code: 'beta_full' }, 403)
  }

  // 5. 创建用户（is_beta_user = 1）
  const passwordHash = await hashPassword(password)
  const insertResult = await run(
    db,
    `INSERT INTO users
       (email, password_hash, username, email_verified, is_beta_user, beta_registered_at)
     VALUES (?, ?, ?, 1, 1, datetime('now'))`,
    [emailAddress, passwordHash, username],
  )
  const userId = insertResult.meta.last_row_id as number

  // 6. 初始化积分/经验
  await db.batch([
    db.prepare('INSERT INTO points (user_id, balance, total_earned, total_spent) VALUES (?, 0, 0, 0)').bind(userId),
    db.prepare('INSERT INTO experience (user_id, current_exp, total_exp, current_level, newbie_rating_bonus_count, current_streak, last_checkin_date) VALUES (?, 0, 0, 1, 0, 0, NULL)').bind(userId),
  ])

  // 7. 邀请码记录（如有）- 仅记录，不发放奖励
  if (inviteCode && inviteCode.trim()) {
    try {
      const inviterRecord = await queryOne<{ creator_id: number; used_by: number | null; expires_at: string }>(
        db,
        'SELECT creator_id, used_by, expires_at FROM invite_codes WHERE code = ?',
        [inviteCode.trim()],
      )
      if (inviterRecord && !inviterRecord.used_by && new Date(inviterRecord.expires_at) > new Date()) {
        await run(
          db,
          'UPDATE invite_codes SET used_by = ?, used_at = CURRENT_TIMESTAMP WHERE code = ? AND used_by IS NULL',
          [userId, inviteCode.trim()],
        )
      }
    } catch (e) {
      // 邀请码处理失败不阻塞注册
      console.error('invite code record error:', e)
    }
  }

  // 8. 签发 JWT + Cookie
  const token = await signJWT(
    { sub: userId, username, email: emailAddress, role: 'user' },
    c.env.JWT_SECRET,
  )
  c.header('Set-Cookie', `token=${token}; ${tokenCookieOptions}`)

  return c.json({
    token,
    user: {
      id: userId,
      email: emailAddress,
      username,
      avatar: null,
      role: 'user',
      is_beta_user: 1,
    },
    beta: {
      is_beta_user: true,
      registered_at: new Date().toISOString(),
    },
  }, 201)
  } catch (e) {
    console.error('POST /api/beta/beta-register error:', e)
    return c.json({ error: '注册失败: ' + (e instanceof Error ? e.message : String(e)) }, 500)
  }
})

/** SHA-256 哈希（用于验证码） */
async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export default beta
