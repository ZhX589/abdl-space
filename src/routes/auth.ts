import { Hono } from 'hono'
import type { Env, JWTPayload, RegisterRequest, LoginRequest, LoginResponse, User } from '../types/index.ts'
import { hashPassword, verifyPassword, signJWT } from '../lib/auth.ts'
import { queryOne, query, run } from '../lib/db.ts'
import { authMiddleware } from '../middleware/auth.ts'
import { getNBWConfig } from '../lib/nbw.ts'
import { sendTencentEmail } from '../lib/ses.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const auth = new Hono<AppType>()

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const CODE_TTL_MINUTES = 5
const EMAIL_COOLDOWN_SECONDS = 60
const MAX_CODE_REQUESTS = 5
const MAX_VERIFY_ATTEMPTS = 5  // 验证码最多尝试 5 次
const RATE_LIMIT_WINDOW = 60   // 秒
const RATE_LIMIT_MAX = 10      // 每窗口最大请求数

const tokenCookieOptions = 'HttpOnly; Secure; SameSite=None; Domain=.abdl-space.top; Path=/; Max-Age=604800'

// ============================================================
// 工具函数
// ============================================================

function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000))
}

/** SHA-256 哈希（用于验证码） */
async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** D1 限流：检查并递增 */
async function checkD1RateLimit(
  db: D1Database,
  key: string,
  windowSeconds: number,
  maxRequests: number
): Promise<{ allowed: boolean; remaining: number }> {
  const now = new Date()
  const windowStart = new Date(Math.floor(now.getTime() / (windowSeconds * 1000)) * windowSeconds * 1000).toISOString()
  const expiresAt = new Date(now.getTime() + windowSeconds * 2 * 1000).toISOString()

  const existing = await queryOne<{ count: number; window_start: string }>(
    db,
    'SELECT count, window_start FROM rate_limits WHERE key = ?',
    [key]
  )

  if (!existing || existing.window_start !== windowStart) {
    // 新窗口
    await run(
      db,
      'INSERT OR REPLACE INTO rate_limits (key, count, window_start, expires_at) VALUES (?, 1, ?, ?)',
      [key, windowStart, expiresAt]
    )
    return { allowed: true, remaining: maxRequests - 1 }
  }

  if (existing.count >= maxRequests) {
    return { allowed: false, remaining: 0 }
  }

  await run(db, 'UPDATE rate_limits SET count = count + 1 WHERE key = ?', [key])
  return { allowed: true, remaining: maxRequests - existing.count - 1 }
}

/** 清理过期限流记录 */
async function cleanupRateLimits(db: D1Database): Promise<void> {
  await run(db, "DELETE FROM rate_limits WHERE expires_at < datetime('now')")
}



// ============================================================
// POST /api/auth/send-code — 发送邮箱验证码
// ============================================================
auth.post('/send-code', async (c) => {
  const db = c.env.abdl_space_db
  const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() || 'unknown'

  // IP 限流（D1）
  const ipLimit = await checkD1RateLimit(db, `ip:send-code:${ip}`, RATE_LIMIT_WINDOW, RATE_LIMIT_MAX)
  if (!ipLimit.allowed) {
    return c.json({ error: '操作太频繁，请稍后再试' }, 429)
  }

  const body = await c.req.json<{ email: string; type: string }>()
  const { email: emailAddress, type } = body

  if (!emailAddress || !EMAIL_REGEX.test(emailAddress)) {
    return c.json({ error: '请输入有效的邮箱地址' }, 400)
  }
  if (!['register', 'bind', 'reset'].includes(type)) {
    return c.json({ error: '无效的验证码类型' }, 400)
  }

  if (type === 'bind') {
    const authHeader = c.req.header('Authorization')
    if (!authHeader || !authHeader.startsWith('Bearer ')) return c.json({ error: '请先登录' }, 401)
    const { verifyJWT } = await import('../lib/auth.ts')
    const payload = await verifyJWT(authHeader.slice(7), c.env.JWT_SECRET)
    if (!payload) return c.json({ error: '登录已过期，请重新登录' }, 401)
  }

  // reset 类型：检查邮箱是否已注册，未注册则静默返回（防枚举+防邮件轰炸）
  if (type === 'reset') {
    const userExists = await queryOne<User>(db, 'SELECT id FROM users WHERE email = ?', [emailAddress])
    if (!userExists) {
      // 静默成功，不发邮件
      return c.json({ message: '如果该邮箱已注册，验证码将发送到您的邮箱' })
    }
  }

  // 邮箱+类型限流（D1）
  const emailLimit = await checkD1RateLimit(db, `email:${type}:${emailAddress}`, EMAIL_COOLDOWN_SECONDS, 1)
  if (!emailLimit.allowed) {
    return c.json({ error: `请等待 ${EMAIL_COOLDOWN_SECONDS} 秒后再发送` }, 429)
  }

  // 检查累计未过期未使用次数
  const countRow = await queryOne<{ cnt: number }>(
    db,
    `SELECT COUNT(*) as cnt FROM email_verifications 
     WHERE email = ? AND type = ? AND used = 0 AND expires_at > datetime('now')`,
    [emailAddress, type]
  )
  if (countRow && countRow.cnt >= MAX_CODE_REQUESTS) {
    return c.json({ error: '该邮箱验证码请求次数已达上限，请稍后再试' }, 429)
  }

  // 作废旧验证码
  await run(
    db,
    `UPDATE email_verifications SET used = 1 WHERE email = ? AND type = ? AND used = 0`,
    [emailAddress, type]
  )

  // 生成验证码并存储哈希
  const code = generateCode()
  const codeHash = await sha256(code)
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString()

  await run(
    db,
    `INSERT INTO email_verifications (user_id, email, code_hash, type, expires_at) VALUES (NULL, ?, ?, ?, ?)`,
    [emailAddress, codeHash, type, expiresAt]
  )

  // 发送邮件（腾讯云 SES 模板）
  const subjects: Record<string, string> = {
    register: '【ABDL Space】注册验证码',
    bind: '【ABDL Space】邮箱绑定验证码',
    reset: '【ABDL Space】密码重置验证码',
  }

  try {
    await sendTencentEmail(
      emailAddress,
      subjects[type],
      Number(c.env.SES_TEMPLATE_ID),
      JSON.stringify({ code }),
      { TENCENT_SECRET_ID: c.env.TENCENT_SECRET_ID, TENCENT_SECRET_KEY: c.env.TENCENT_SECRET_KEY, SES_FROM_EMAIL: c.env.SES_FROM_EMAIL, SES_REGION: c.env.SES_REGION }
    )
  } catch (err) {
    console.error('SES error:', err)
    return c.json({ error: '发送验证码失败，请稍后再试' }, 500)
  }

  // 偶尔清理过期限流记录
  if (Math.random() < 0.05) {
    cleanupRateLimits(db).catch(() => {})
  }

  return c.json({ message: '验证码已发送' })
})

// ============================================================
// 通用验证码校验（带尝试次数限制）
// ============================================================
async function verifyCode(
  db: D1Database,
  email: string,
  code: string,
  type: string
): Promise<{ valid: boolean; recordId?: number; error?: string }> {
  const codeHash = await sha256(code)

  const record = await queryOne<{ id: number; attempts: number }>(
    db,
    `SELECT id, attempts FROM email_verifications 
     WHERE email = ? AND code_hash = ? AND type = ? AND used = 0 
     AND expires_at > datetime('now')
     ORDER BY id DESC LIMIT 1`,
    [email, codeHash, type]
  )

  if (!record) {
    return { valid: false, error: '验证码无效或已过期' }
  }

  // 检查尝试次数
  if (record.attempts >= MAX_VERIFY_ATTEMPTS) {
    // 标记为已使用，防止继续尝试
    await run(db, 'UPDATE email_verifications SET used = 1 WHERE id = ?', [record.id])
    return { valid: false, error: '验证码尝试次数过多，请重新获取' }
  }

  // 递增尝试次数
  await run(db, 'UPDATE email_verifications SET attempts = attempts + 1 WHERE id = ?', [record.id])

  return { valid: true, recordId: record.id }
}

// ============================================================
// POST /api/auth/register — 注册（需要邮箱验证码）
// ============================================================
auth.post('/register', async (c) => {
  const db = c.env.abdl_space_db
  const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() || 'unknown'

  const ipLimit = await checkD1RateLimit(db, `ip:register:${ip}`, RATE_LIMIT_WINDOW, RATE_LIMIT_MAX)
  if (!ipLimit.allowed) {
    return c.json({ error: '操作太频繁，请稍后再试' }, 429)
  }

  const body = await c.req.json<{ username: string; password: string; email: string; code?: string; nbw_code?: string; nbw_token?: string }>()
  const { username, password, email: emailAddress, code, nbw_code, nbw_token } = body
  const isNBW = !!nbw_code || !!nbw_token

  if (!emailAddress || !password || !username) {
    return c.json({ error: '请填写所有字段' }, 400)
  }
  if (!EMAIL_REGEX.test(emailAddress)) {
    return c.json({ error: '请输入有效的邮箱地址' }, 400)
  }
  if (password.length < 8) {
    return c.json({ error: '密码至少 8 位' }, 400)
  }
  if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}/.test(password)) {
    return c.json({ error: '密码需包含大小写字母和数字' }, 400)
  }
  if (username.length < 2 || username.length > 32) {
    return c.json({ error: '用户名 2-32 个字符' }, 400)
  }

  // NBW 注册：跳过邮箱验证码校验，但验证 NBW code/token 获取 uid
  let nbw_uid: string | null = null
  let nbw_username: string | null = null
  if (isNBW) {
    if (nbw_token) {
      // 新流程：验证 JWT 绑定 token
      try {
        const parts = nbw_token.split('.')
        if (parts.length === 3) {
          const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
          if (payload.type === 'nbw_bind' && payload.exp && payload.exp > Date.now()) {
            nbw_uid = payload.uid
            nbw_username = payload.username || null
          }
        }
      } catch {}
      if (!nbw_uid) return c.json({ error: 'NBW 授权信息已过期或无效，请重新登录' }, 400)
    } else {
      // 旧流程：用 code 换 token
      const { clientId, clientSecret, redirectUri } = getNBWConfig(c)
      if (!clientId || !clientSecret || !redirectUri) {
        return c.json({ error: 'NewBabyWorld OAuth 未配置' }, 500)
      }
      try {
        const tokenRes = await fetch('https://www.newbabyworld.top/oauth/token.php', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId, client_secret: clientSecret,
            grant_type: 'authorization_code', code: nbw_code, redirect_uri: redirectUri,
          }),
        })
        if (!tokenRes.ok) return c.json({ error: 'NBW 授权码无效' }, 400)
        const tokenData = await tokenRes.json() as { access_token?: string }
        if (!tokenData.access_token) return c.json({ error: 'NBW Token 获取失败' }, 400)
        const userRes = await fetch(`https://www.newbabyworld.top/oauth/userinfo.php?access_token=${tokenData.access_token}`)
        if (!userRes.ok) return c.json({ error: 'NBW 用户信息获取失败' }, 400)
        const userData = await userRes.json() as { errcode?: number; data?: { uid?: string; username?: string } }
        if (userData.errcode !== 0 || !userData.data?.uid) return c.json({ error: 'NBW 用户信息无效' }, 400)
        nbw_uid = userData.data.uid
        nbw_username = userData.data.username || null
      } catch {
        return c.json({ error: 'NBW 验证请求失败' }, 502)
      }
    }
  } else {
    result = await verifyCode(db, emailAddress, code, 'register')
    if (!result.valid) {
      return c.json({ error: result.error }, 400)
    }
    // 标记验证码已使用
    await run(db, 'UPDATE email_verifications SET used = 1 WHERE id = ?', [result.recordId])
  }

  // 检查用户名/邮箱是否已存在（模糊提示防枚举）
  const existing = await queryOne<User>(
    db,
    'SELECT id FROM users WHERE email = ? OR username = ?',
    [emailAddress, username]
  )
  if (existing) {
    return c.json({ error: '注册信息已被使用，请更换邮箱或用户名' }, 409)
  }

  const passwordHash = await hashPassword(password)
  const insertResult = await run(
    db,
    'INSERT INTO users (email, password_hash, username, email_verified, nbw_uid, nbw_username) VALUES (?, ?, ?, 1, ?, ?)',
    [emailAddress, passwordHash, username, isNBW ? String(nbw_uid) : null, isNBW ? nbw_username : null]
  )
  const userId = insertResult.meta.last_row_id as number
  const token = await signJWT({ sub: userId, username, email: emailAddress, role: 'user' }, c.env.JWT_SECRET)

  c.header('Set-Cookie', `token=${token}; ${tokenCookieOptions}`)

  return c.json({
    token,
    user: { id: userId, email: emailAddress, username, avatar: null, role: 'user' },
  }, 201)
})

// ============================================================
// POST /api/auth/login — 登录
// ============================================================
auth.post('/login', async (c) => {
  const db = c.env.abdl_space_db
  const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() || 'unknown'

  const ipLimit = await checkD1RateLimit(db, `ip:login:${ip}`, RATE_LIMIT_WINDOW, RATE_LIMIT_MAX)
  if (!ipLimit.allowed) {
    return c.json({ error: '操作太频繁，请稍后再试' }, 429)
  }

  const body = await c.req.json<LoginRequest>()
  const { login, password } = body

  if (!login || !password) {
    return c.json({ error: 'login and password are required' }, 400)
  }

  const user = await queryOne<User>(
    db,
    'SELECT id, email, username, password_hash, avatar, role FROM users WHERE email = ? OR username = ?',
    [login, login]
  )
  if (!user) {
    return c.json({ error: 'Invalid credentials' }, 401)
  }

  const valid = await verifyPassword(password, user.password_hash)
  if (!valid) {
    return c.json({ error: 'Invalid credentials' }, 401)
  }

  const token = await signJWT({ sub: user.id, username: user.username, email: user.email, role: user.role }, c.env.JWT_SECRET)

  c.header('Set-Cookie', `token=${token}; ${tokenCookieOptions}`)

  return c.json({
    token,
    user: { id: user.id, email: user.email, username: user.username, avatar: user.avatar, role: user.role }
  } satisfies LoginResponse)
})

// ============================================================
// POST /api/auth/reset-password — 找回密码
// ============================================================
auth.post('/reset-password', async (c) => {
  const db = c.env.abdl_space_db
  const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() || 'unknown'

  const ipLimit = await checkD1RateLimit(db, `ip:reset:${ip}`, RATE_LIMIT_WINDOW, RATE_LIMIT_MAX)
  if (!ipLimit.allowed) {
    return c.json({ error: '操作太频繁，请稍后再试' }, 429)
  }

  const body = await c.req.json<{ email: string; code: string; newPassword: string }>()
  const { email: emailAddress, code, newPassword } = body

  if (!emailAddress || !code || !newPassword) {
    return c.json({ error: '请填写所有字段' }, 400)
  }
  if (newPassword.length < 8) {
    return c.json({ error: '密码至少 8 位' }, 400)
  }
  if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}/.test(newPassword)) {
    return c.json({ error: '密码需包含大小写字母和数字' }, 400)
  }

  // 验证码校验
  const result = await verifyCode(db, emailAddress, code, 'reset')
  if (!result.valid) {
    return c.json({ error: result.error }, 400)
  }

  await run(db, 'UPDATE email_verifications SET used = 1 WHERE id = ?', [result.recordId])

  // 查找用户（模糊提示防枚举）
  const user = await queryOne<User>(db, 'SELECT id FROM users WHERE email = ?', [emailAddress])
  if (!user) {
    return c.json({ error: '验证码无效或已过期' }, 400)
  }

  const passwordHash = await hashPassword(newPassword)
  await run(db, 'UPDATE users SET password_hash = ?, password_changed_at = CURRENT_TIMESTAMP WHERE id = ?', [passwordHash, user.id])

  return c.json({ message: '密码已重置，请重新登录' })
})

// ============================================================
// POST /api/auth/bind-email — 绑定/换绑邮箱（需登录）
// ============================================================
auth.post('/bind-email', authMiddleware, async (c) => {
  const db = c.env.abdl_space_db
  const payload = c.get('user')
  const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() || 'unknown'

  const ipLimit = await checkD1RateLimit(db, `ip:bind:${ip}`, RATE_LIMIT_WINDOW, RATE_LIMIT_MAX)
  if (!ipLimit.allowed) {
    return c.json({ error: '操作太频繁，请稍后再试' }, 429)
  }

  const body = await c.req.json<{ email: string; code: string }>()
  const { email: emailAddress, code } = body

  if (!emailAddress || !EMAIL_REGEX.test(emailAddress)) {
    return c.json({ error: '请输入有效的邮箱地址' }, 400)
  }
  if (!code) {
    return c.json({ error: '请输入验证码' }, 400)
  }

  // 验证码校验
  const result = await verifyCode(db, emailAddress, code, 'bind')
  if (!result.valid) {
    return c.json({ error: result.error }, 400)
  }

  await run(db, 'UPDATE email_verifications SET used = 1 WHERE id = ?', [result.recordId])

  // 检查邮箱是否已被其他用户绑定（模糊提示）
  const emailTaken = await queryOne<User>(
    db,
    'SELECT id FROM users WHERE email = ? AND id != ?',
    [emailAddress, payload.sub]
  )
  if (emailTaken) {
    return c.json({ error: '该邮箱无法使用，请更换邮箱' }, 409)
  }

  await run(db, 'UPDATE users SET email = ?, email_verified = 1 WHERE id = ?', [emailAddress, payload.sub])

  return c.json({ message: '邮箱绑定成功' })
})

// ============================================================
// GET /api/auth/me — 获取当前用户完整信息
// ============================================================
auth.get('/me', authMiddleware, async (c) => {
  const payload = c.get('user')
  const user = await queryOne<User>(
    c.env.abdl_space_db,
    'SELECT id, email, username, avatar, role, age, region, weight, waist, hip, style_preference, bio, email_verified, nbw_uid, nbw_username, created_at FROM users WHERE id = ?',
    [payload.sub]
  )
  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }
  // 如果是通过 Authorization header 认证的（切换账户），同时设置 cookie
  const authHeader = c.req.header('Authorization')
  if (authHeader && authHeader.startsWith('Bearer ')) {
    c.header('Set-Cookie', `token=${authHeader.slice(7)}; ${tokenCookieOptions}`)
  }
  return c.json({
    id: user.id,
    email: user.email,
    username: user.username,
    avatar: user.avatar,
    role: user.role,
    age: user.age,
    region: user.region,
    weight: user.weight,
    waist: user.waist,
    hip: user.hip,
    style_preference: user.style_preference,
    bio: user.bio,
    email_verified: user.email_verified,
    nbw_uid: user.nbw_uid || null,
    nbw_username: user.nbw_username || null,
    created_at: user.created_at
  })
})

/**
 * POST /api/auth/logout — 登出，清除 cookie
 */
auth.post('/logout', async (c) => {
  c.header('Set-Cookie', `token=; HttpOnly; Secure; SameSite=None; Domain=.abdl-space.top; Path=/; Max-Age=0`)
  return c.json({ message: '已登出' })
})

export default auth
