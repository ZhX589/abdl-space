import { Hono } from 'hono'
import type { Env, JWTPayload, RegisterRequest, LoginRequest, LoginResponse, User } from '../types/index.ts'
import { hashPassword, verifyPassword, signJWT, checkRateLimit, getClientIp } from '../lib/auth.ts'
import { queryOne, query, run } from '../lib/db.ts'
import { authMiddleware } from '../middleware/auth.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const auth = new Hono<AppType>()

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const CODE_TTL_MINUTES = 5
const RESEND_COOLDOWN_SECONDS = 60
const MAX_CODE_REQUESTS = 5

const tokenCookieOptions = 'HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800'

/** 生成 6 位验证码 */
function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000))
}

/** 发送邮件（Resend API） */
async function sendEmail(to: string, subject: string, html: string, apiKey: string): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'ABDL Space <admin@abdl-space.top>',
      to: [to],
      subject,
      html,
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Resend API error: ${res.status} ${err}`)
  }
}

/** 验证码邮件 HTML 模板 */
function codeEmailHtml(code: string): string {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
      <div style="text-align: center; margin-bottom: 24px;">
        <h2 style="color: #333; margin: 0;">ABDL Space</h2>
      </div>
      <div style="background: #f8f9fa; border-radius: 12px; padding: 24px; text-align: center;">
        <p style="color: #666; font-size: 14px; margin: 0 0 12px;">您的验证码为：</p>
        <div style="font-size: 36px; font-weight: 700; letter-spacing: 8px; color: #333; font-family: monospace;">${code}</div>
        <p style="color: #999; font-size: 12px; margin: 16px 0 0;">验证码 ${CODE_TTL_MINUTES} 分钟内有效，请勿泄露给他人</p>
      </div>
      <p style="color: #bbb; font-size: 11px; text-align: center; margin-top: 24px;">如非本人操作，请忽略此邮件</p>
    </div>
  `
}

// ============================================================
// POST /api/auth/send-code — 发送邮箱验证码
// Body: { email, type: 'register' | 'bind' | 'reset' }
// ============================================================
auth.post('/send-code', async (c) => {
  const ip = getClientIp(c)
  const rateLimit = checkRateLimit(ip)
  if (!rateLimit.allowed) {
    c.header('Retry-After', String(Math.ceil(rateLimit.resetIn / 1000)))
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

  // bind 类型需要登录
  if (type === 'bind') {
    const authHeader = c.req.header('Authorization')
    if (!authHeader) return c.json({ error: '请先登录' }, 401)
  }

  const db = c.env.abdl_space_db

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

  // 检查冷却时间
  const recent = await queryOne<{ id: number }>(
    db,
    `SELECT id FROM email_verifications 
     WHERE email = ? AND type = ? AND created_at > datetime('now', '-${RESEND_COOLDOWN_SECONDS} seconds')
     ORDER BY id DESC LIMIT 1`,
    [emailAddress, type]
  )
  if (recent) {
    return c.json({ error: `请等待 ${RESEND_COOLDOWN_SECONDS} 秒后再发送` }, 429)
  }

  // 作废旧验证码
  await run(
    db,
    `UPDATE email_verifications SET used = 1 WHERE email = ? AND type = ? AND used = 0`,
    [emailAddress, type]
  )

  // 生成并存储新验证码
  const code = generateCode()
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString()

  await run(
    db,
    `INSERT INTO email_verifications (user_id, email, code, type, expires_at) VALUES (NULL, ?, ?, ?, ?)`,
    [emailAddress, code, type, expiresAt]
  )

  // 发送邮件
  const subjects: Record<string, string> = {
    register: '【ABDL Space】注册验证码',
    bind: '【ABDL Space】邮箱绑定验证码',
    reset: '【ABDL Space】密码重置验证码',
  }

  try {
    await sendEmail(emailAddress, subjects[type], codeEmailHtml(code), c.env.RESEND_API_KEY)
  } catch (err) {
    console.error('Resend error:', err)
    return c.json({ error: '发送验证码失败，请稍后再试' }, 500)
  }

  return c.json({ message: '验证码已发送' })
})

// ============================================================
// POST /api/auth/register — 注册（需要邮箱验证码）
// Body: { username, password, email, code }
// ============================================================
auth.post('/register', async (c) => {
  const ip = getClientIp(c)
  const rateLimit = checkRateLimit(ip)
  if (!rateLimit.allowed) {
    c.header('Retry-After', String(Math.ceil(rateLimit.resetIn / 1000)))
    return c.json({ error: '操作太频繁，请稍后再试' }, 429)
  }

  const body = await c.req.json<{ username: string; password: string; email: string; code: string }>()
  const { username, password, email: emailAddress, code } = body

  if (!emailAddress || !password || !username || !code) {
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

  const db = c.env.abdl_space_db

  // 验证码校验
  const record = await queryOne<{ id: number }>(
    db,
    `SELECT id FROM email_verifications 
     WHERE email = ? AND code = ? AND type = 'register' AND used = 0 
     AND expires_at > datetime('now')
     ORDER BY id DESC LIMIT 1`,
    [emailAddress, code]
  )
  if (!record) {
    return c.json({ error: '验证码无效或已过期' }, 400)
  }

  // 标记验证码已使用
  await run(db, 'UPDATE email_verifications SET used = 1 WHERE id = ?', [record.id])

  // 检查用户名/邮箱是否已存在
  const existing = await queryOne<User>(
    db,
    'SELECT id FROM users WHERE email = ? OR username = ?',
    [emailAddress, username]
  )
  if (existing) {
    return c.json({ error: '邮箱或用户名已被使用' }, 409)
  }

  // 创建用户（注册即验证邮箱）
  const passwordHash = await hashPassword(password)
  const result = await run(
    db,
    'INSERT INTO users (email, password_hash, username, email_verified) VALUES (?, ?, ?, 1)',
    [emailAddress, passwordHash, username]
  )
  const userId = result.meta.last_row_id as number
  const token = await signJWT({ sub: userId, username, email: emailAddress, role: 'user' }, c.env.JWT_SECRET)

  c.header('Set-Cookie', `token=${token}; ${tokenCookieOptions}`)

  return c.json({
    token,
    user: { id: userId, email: emailAddress, username, avatar: null, role: 'user' },
  }, 201)
})

// ============================================================
// POST /api/auth/login — 登录（支持 email 或 username）
// ============================================================
auth.post('/login', async (c) => {
  const ip = getClientIp(c)
  const rateLimit = checkRateLimit(ip)
  if (!rateLimit.allowed) {
    c.header('Retry-After', String(Math.ceil(rateLimit.resetIn / 1000)))
    return c.json({ error: '操作太频繁，请稍后再试' }, 429)
  }

  const body = await c.req.json<LoginRequest>()
  const { login, password } = body

  if (!login || !password) {
    return c.json({ error: 'login and password are required' }, 400)
  }

  const user = await queryOne<User>(
    c.env.abdl_space_db,
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

  const response: LoginResponse = {
    token,
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      avatar: user.avatar,
      role: user.role
    }
  }
  return c.json(response)
})

// ============================================================
// POST /api/auth/reset-password — 找回密码
// Body: { email, code, newPassword }
// ============================================================
auth.post('/reset-password', async (c) => {
  const ip = getClientIp(c)
  const rateLimit = checkRateLimit(ip)
  if (!rateLimit.allowed) {
    c.header('Retry-After', String(Math.ceil(rateLimit.resetIn / 1000)))
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

  const db = c.env.abdl_space_db

  // 验证码校验
  const record = await queryOne<{ id: number }>(
    db,
    `SELECT id FROM email_verifications 
     WHERE email = ? AND code = ? AND type = 'reset' AND used = 0 
     AND expires_at > datetime('now')
     ORDER BY id DESC LIMIT 1`,
    [emailAddress, code]
  )
  if (!record) {
    return c.json({ error: '验证码无效或已过期' }, 400)
  }

  await run(db, 'UPDATE email_verifications SET used = 1 WHERE id = ?', [record.id])

  // 查找用户
  const user = await queryOne<User>(db, 'SELECT id FROM users WHERE email = ?', [emailAddress])
  if (!user) {
    return c.json({ error: '该邮箱未注册' }, 404)
  }

  // 更新密码
  const passwordHash = await hashPassword(newPassword)
  await run(db, 'UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, user.id])

  return c.json({ message: '密码已重置，请重新登录' })
})

// ============================================================
// POST /api/auth/bind-email — 绑定/换绑邮箱（需登录）
// Body: { email, code }
// ============================================================
auth.post('/bind-email', authMiddleware, async (c) => {
  const payload = c.get('user')
  const body = await c.req.json<{ email: string; code: string }>()
  const { email: emailAddress, code } = body

  if (!emailAddress || !EMAIL_REGEX.test(emailAddress)) {
    return c.json({ error: '请输入有效的邮箱地址' }, 400)
  }
  if (!code) {
    return c.json({ error: '请输入验证码' }, 400)
  }

  const db = c.env.abdl_space_db

  // 验证码校验
  const record = await queryOne<{ id: number }>(
    db,
    `SELECT id FROM email_verifications 
     WHERE email = ? AND code = ? AND type = 'bind' AND used = 0 
     AND expires_at > datetime('now')
     ORDER BY id DESC LIMIT 1`,
    [emailAddress, code]
  )
  if (!record) {
    return c.json({ error: '验证码无效或已过期' }, 400)
  }

  await run(db, 'UPDATE email_verifications SET used = 1 WHERE id = ?', [record.id])

  // 检查邮箱是否已被其他用户绑定
  const emailTaken = await queryOne<User>(
    db,
    'SELECT id FROM users WHERE email = ? AND id != ?',
    [emailAddress, payload.sub]
  )
  if (emailTaken) {
    return c.json({ error: '该邮箱已被其他用户绑定' }, 409)
  }

  // 更新邮箱
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
    'SELECT id, email, username, avatar, role, age, region, weight, waist, hip, style_preference, bio, email_verified, created_at FROM users WHERE id = ?',
    [payload.sub]
  )
  if (!user) {
    return c.json({ error: 'User not found' }, 404)
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
    created_at: user.created_at
  })
})

export default auth
