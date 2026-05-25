import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { queryOne, run } from '../lib/db.ts'
import { signJWT } from '../lib/auth.ts'
import { hashPassword } from '../lib/auth.ts'
import { authMiddleware } from '../middleware/auth.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const nbw = new Hono<AppType>()

const NBW_TOKEN_URL = 'https://www.newbabyworld.top/oauth/token.php'
const NBW_USERINFO_URL = 'https://www.newbabyworld.top/oauth/userinfo.php'

const tokenCookieOptions = 'HttpOnly; Secure; SameSite=None; Domain=.abdl-space.top; Path=/; Max-Age=604800'

/**
 * GET /api/auth/nbw/config — 返回公开的 OAuth 配置（不含 secret）
 */
nbw.get('/config', (c) => {
  return c.json({
    client_id: c.env.NBW_CLIENT_ID || '',
    redirect_uri: c.env.NBW_REDIRECT_URI || '',
  });
});

/**
 * POST /api/auth/nbw/callback — NewBabyWorld OAuth 回调
 * Body: { code: string }
 * Response: { action: 'login', token, user } | { action: 'register', nbw_user }
 */
nbw.post('/callback', async (c) => {
  const clientId = c.env.NBW_CLIENT_ID
  const clientSecret = c.env.NBW_CLIENT_SECRET
  const redirectUri = c.env.NBW_REDIRECT_URI

  if (!clientId || !clientSecret || !redirectUri) {
    return c.json({ error: 'NewBabyWorld OAuth 未配置' }, 500)
  }

  let body: { code?: string }
  try { body = await c.req.json() } catch { return c.json({ error: '无效请求' }, 400) }
  if (!body.code) return c.json({ error: '缺少授权码' }, 400)

  // 1. 用 code 换 token
  let tokenData: { access_token?: string; uid?: string }
  try {
    const tokenRes = await fetch(NBW_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code: body.code,
        redirect_uri: redirectUri,
      }),
    })
    if (!tokenRes.ok) {
      const err = await tokenRes.text()
      return c.json({ error: `Token 交换失败: ${err}` }, 400)
    }
    tokenData = await tokenRes.json()
  } catch (e) {
    return c.json({ error: 'Token 请求失败' }, 502)
  }

  if (!tokenData.access_token) {
    return c.json({ error: '未获取到 access_token' }, 400)
  }

  // 2. 获取用户信息
  let nbwUser: { uid: string; username: string; avatar?: string; groupid?: string }
  try {
    const userRes = await fetch(`${NBW_USERINFO_URL}?access_token=${tokenData.access_token}`)
    if (!userRes.ok) return c.json({ error: '获取用户信息失败' }, 400)
    const userData = await userRes.json()
    if (userData.errcode !== 0) return c.json({ error: userData.errmsg || '获取用户信息失败' }, 400)
    nbwUser = userData.data
  } catch (e) {
    return c.json({ error: '用户信息请求失败' }, 502)
  }

  if (!nbwUser?.uid) return c.json({ error: '用户信息无效' }, 400)

  const db = c.env.abdl_space_db

  // 3. 检查是否已绑定
  const existing = await queryOne<{ id: number; username: string; email: string; avatar: string | null; role: string }>(
    db, 'SELECT id, username, email, avatar, role FROM users WHERE nbw_uid = ?', [nbwUser.uid]
  )

  if (existing) {
    // 已绑定，直接登录
    const token = await signJWT({ sub: existing.id, username: existing.username, email: existing.email, role: existing.role }, c.env.JWT_SECRET)
    c.header('Set-Cookie', `token=${token}; ${tokenCookieOptions}`)
    return c.json({
      action: 'login',
      token,
      user: { id: existing.id, username: existing.username, email: existing.email, avatar: existing.avatar, role: existing.role },
    })
  }

  // 4. 未绑定，返回 NBW 用户信息供选择（绑定已有或注册新账号）
  return c.json({
    action: 'choose',
    nbw_code: body.code,
    nbw_user: {
      uid: nbwUser.uid,
      username: nbwUser.username || '',
      avatar: nbwUser.avatar || null,
    },
  })
})

/**
 * POST /api/auth/nbw/bind-existing — 用已有账号登录并绑定 NBW
 * Body: { login: string, password: string, nbw_code: string }
 */
nbw.post('/bind-existing', async (c) => {
  const clientId = c.env.NBW_CLIENT_ID
  const clientSecret = c.env.NBW_CLIENT_SECRET
  const redirectUri = c.env.NBW_REDIRECT_URI

  if (!clientId || !clientSecret || !redirectUri) {
    return c.json({ error: 'NewBabyWorld OAuth 未配置' }, 500)
  }

  let body: { login?: string; password?: string; nbw_code?: string }
  try { body = await c.req.json() } catch { return c.json({ error: '无效请求' }, 400) }
  if (!body.login || !body.password || !body.nbw_code) return c.json({ error: '缺少必要参数' }, 400)

  const db = c.env.abdl_space_db

  // 1. 验证 ABDL Space 账号密码
  const user = await queryOne<{ id: number; username: string; email: string; avatar: string | null; role: string; password_hash: string }>(
    db, 'SELECT id, username, email, avatar, role, password_hash FROM users WHERE username = ? OR email = ?',
    [body.login, body.login]
  )
  if (!user) return c.json({ error: '用户名或密码错误' }, 401)

  const { verifyPassword } = await import('../lib/auth.ts')
  const valid = await verifyPassword(body.password, user.password_hash)
  if (!valid) return c.json({ error: '用户名或密码错误' }, 401)

  // 2. 用 nbw_code 换 token 获取 NBW 用户信息
  let tokenData: { access_token?: string }
  try {
    const tokenRes = await fetch(NBW_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code: body.nbw_code,
        redirect_uri: redirectUri,
      }),
    })
    if (!tokenRes.ok) return c.json({ error: 'Token 交换失败' }, 400)
    tokenData = await tokenRes.json()
  } catch { return c.json({ error: 'Token 请求失败' }, 502) }
  if (!tokenData.access_token) return c.json({ error: '未获取到 access_token' }, 400)

  let nbwUser: { uid: string; username: string }
  try {
    const userRes = await fetch(`${NBW_USERINFO_URL}?access_token=${tokenData.access_token}`)
    if (!userRes.ok) return c.json({ error: '获取用户信息失败' }, 400)
    const userData = await userRes.json()
    if (userData.errcode !== 0) return c.json({ error: userData.errmsg || '获取用户信息失败' }, 400)
    nbwUser = userData.data
  } catch { return c.json({ error: '用户信息请求失败' }, 502) }
  if (!nbwUser?.uid) return c.json({ error: '用户信息无效' }, 400)

  // 3. 检查该 NBW UID 是否已被其他用户绑定
  const alreadyBound = await queryOne<{ id: number }>(
    db, 'SELECT id FROM users WHERE nbw_uid = ?', [nbwUser.uid]
  )
  if (alreadyBound && alreadyBound.id !== user.id) {
    return c.json({ error: '该宝宝新天地账户已被其他用户绑定' }, 409)
  }

  // 4. 绑定 + 登录
  await run(db, 'UPDATE users SET nbw_uid = ?, nbw_username = ? WHERE id = ?', [nbwUser.uid, nbwUser.username || null, user.id])
  const token = await signJWT({ sub: user.id, username: user.username, email: user.email, role: user.role }, c.env.JWT_SECRET)
  c.header('Set-Cookie', `token=${token}; ${tokenCookieOptions}`)

  return c.json({
    message: '绑定并登录成功',
    token,
    user: { id: user.id, username: user.username, email: user.email, avatar: user.avatar, role: user.role },
    nbw_uid: nbwUser.uid,
    nbw_username: nbwUser.username || null,
  })
})

/**
 * POST /api/auth/nbw/bind — 绑定 NewBabyWorld 账户（需登录）
 * Body: { code: string }
 */
nbw.post('/bind', authMiddleware, async (c) => {
  const user = c.get('user')
  const clientId = c.env.NBW_CLIENT_ID
  const clientSecret = c.env.NBW_CLIENT_SECRET
  const redirectUri = c.env.NBW_REDIRECT_URI

  if (!clientId || !clientSecret || !redirectUri) {
    return c.json({ error: 'NewBabyWorld OAuth 未配置' }, 500)
  }

  let body: { code?: string }
  try { body = await c.req.json() } catch { return c.json({ error: '无效请求' }, 400) }
  if (!body.code) return c.json({ error: '缺少授权码' }, 400)

  // 换 token
  let tokenData: { access_token?: string; uid?: string }
  try {
    const tokenRes = await fetch(NBW_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code: body.code,
        redirect_uri: redirectUri,
      }),
    })
    if (!tokenRes.ok) return c.json({ error: 'Token 交换失败' }, 400)
    tokenData = await tokenRes.json()
  } catch { return c.json({ error: 'Token 请求失败' }, 502) }

  if (!tokenData.access_token) return c.json({ error: '未获取到 access_token' }, 400)

  // 获取用户信息
  let nbwUser: { uid: string; username: string }
  try {
    const userRes = await fetch(`${NBW_USERINFO_URL}?access_token=${tokenData.access_token}`)
    if (!userRes.ok) return c.json({ error: '获取用户信息失败' }, 400)
    const userData = await userRes.json()
    if (userData.errcode !== 0) return c.json({ error: userData.errmsg || '获取用户信息失败' }, 400)
    nbwUser = userData.data
  } catch { return c.json({ error: '用户信息请求失败' }, 502) }

  if (!nbwUser?.uid) return c.json({ error: '用户信息无效' }, 400)

  const db = c.env.abdl_space_db

  // 检查该 NBW UID 是否已被其他用户绑定
  const alreadyBound = await queryOne<{ id: number }>(
    db, 'SELECT id FROM users WHERE nbw_uid = ?', [nbwUser.uid]
  )
  if (alreadyBound && alreadyBound.id !== user.sub) {
    return c.json({ error: '该宝宝新天地账户已被其他用户绑定' }, 409)
  }

  // 绑定
  await run(db, 'UPDATE users SET nbw_uid = ?, nbw_username = ? WHERE id = ?', [nbwUser.uid, nbwUser.username || null, user.sub])

  return c.json({ message: '绑定成功', nbw_uid: nbwUser.uid, nbw_username: nbwUser.username || null })
})

export default nbw
