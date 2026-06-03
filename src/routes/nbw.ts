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

/** 根据请求来源返回对应的 NBW OAuth 配置 */
function getNBWConfig(c: any): { clientId: string; clientSecret: string; redirectUri: string } {
  const origin = c.req.header('Origin') || c.req.header('Referer') || ''
  if (origin.includes('m.abdl-space.top')) {
    return {
      clientId: c.env.NBW_CLIENT_ID_MOBILE || c.env.NBW_CLIENT_ID || '',
      clientSecret: c.env.NBW_CLIENT_SECRET_MOBILE || c.env.NBW_CLIENT_SECRET || '',
      redirectUri: c.env.NBW_REDIRECT_URI_MOBILE || c.env.NBW_REDIRECT_URI || '',
    }
  }
  return {
    clientId: c.env.NBW_CLIENT_ID || '',
    clientSecret: c.env.NBW_CLIENT_SECRET || '',
    redirectUri: c.env.NBW_REDIRECT_URI || '',
  }
}

/**
 * 签发短时效 NBW 绑定 token（JWT 嵌入 uid/username/avatar，10 分钟有效）
 * 解决 Workers 多实例进程内 Map 不共享的问题
 */
async function signNBWBindToken(data: { uid: string; username: string; avatar: string | null }, secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' }
  const now = Date.now()
  const payload = { ...data, type: 'nbw_bind', iat: now, exp: now + 10 * 60 * 1000 } // 10 分钟
  const encoder = new TextEncoder()
  const headerB64 = btoa(JSON.stringify(header)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const payloadB64 = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const signInput = `${headerB64}.${payloadB64}`
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(signInput))
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${signInput}.${sigB64}`
}

async function verifyNBWBindToken(token: string, secret: string): Promise<{ uid: string; username: string; avatar: string | null } | null> {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
    const signInput = `${parts[0]}.${parts[1]}`
    const sig = Uint8Array.from(atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
    const valid = await crypto.subtle.verify('HMAC', key, sig, encoder.encode(signInput))
    if (!valid) return null
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
    if (payload.type !== 'nbw_bind' || !payload.exp || payload.exp < Date.now()) return null
    return { uid: payload.uid, username: payload.username, avatar: payload.avatar || null }
  } catch { return null }
}

/**
 * GET /api/auth/nbw/config — 返回公开的 OAuth 配置（不含 secret）
 * 根据请求来源（Origin/Referer）返回对应的 OAuth 配置
 */
nbw.get('/config', (c) => {
  const { clientId, redirectUri } = getNBWConfig(c)
  return c.json({
    client_id: clientId,
    redirect_uri: redirectUri,
  });
});

/**
 * POST /api/auth/nbw/callback — NewBabyWorld OAuth 回调
 * Body: { code: string }
 * Response: { action: 'login', token, user } | { action: 'register', nbw_user }
 */
nbw.post('/callback', async (c) => {
  const { clientId, clientSecret, redirectUri } = getNBWConfig(c)

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

  // 3. 检查是否已绑定（CAST 兼容 4349.0 vs "4349" 的格式差异）
  let existing: { id: number; username: string; email: string; avatar: string | null; role: string } | null = null
  try {
    existing = await queryOne(
      db, 'SELECT id, username, email, avatar, role FROM users WHERE CAST(nbw_uid AS TEXT) = ?', [String(nbwUser.uid)]
    )
  } catch (e) {
    console.error('nbw_uid query failed (migration needed?):', e)
  }

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

  // 4. 未绑定，签发短时效绑定 token 返回给前端
  let bindToken: string
  try {
    bindToken = await signNBWBindToken(
      { uid: nbwUser.uid, username: nbwUser.username || '', avatar: nbwUser.avatar || null },
      c.env.JWT_SECRET
    )
  } catch (e) {
    console.error('signNBWBindToken failed:', e)
    return c.json({ error: '绑定令牌签发失败' }, 500)
  }

  return c.json({
    action: 'choose',
    nbw_token: bindToken,
    nbw_user: {
      uid: nbwUser.uid,
      username: nbwUser.username || '',
      avatar: nbwUser.avatar || null,
    },
  })
})

/**
 * POST /api/auth/nbw/bind-existing — 用已有账号登录并绑定 NBW
 * Body: { login: string, password: string, nbw_token: string }
 */
nbw.post('/bind-existing', async (c) => {
  let body: { login?: string; password?: string; nbw_token?: string }
  try { body = await c.req.json() } catch { return c.json({ error: '无效请求' }, 400) }
  if (!body.login || !body.password || !body.nbw_token) return c.json({ error: '缺少必要参数' }, 400)

  const db = c.env.abdl_space_db

  // 1. 先验证 ABDL Space 账号密码（token 在验证成功后再消费）
  const user = await queryOne<{ id: number; username: string; email: string; avatar: string | null; role: string; password_hash: string }>(
    db, 'SELECT id, username, email, avatar, role, password_hash FROM users WHERE username = ? OR email = ?',
    [body.login, body.login]
  )
  if (!user) return c.json({ error: '用户名或密码错误' }, 401)

  const { verifyPassword } = await import('../lib/auth.ts')
  const valid = await verifyPassword(body.password, user.password_hash)
  if (!valid) return c.json({ error: '用户名或密码错误' }, 401)

  // 2. 密码验证通过后，验证 NBW 绑定 token
  const cached = await verifyNBWBindToken(body.nbw_token, c.env.JWT_SECRET)
  if (!cached) return c.json({ error: '授权信息已过期或无效，请重新登录' }, 400)

  // 3. 检查该 NBW UID 是否已被其他用户绑定
  const alreadyBound = await queryOne<{ id: number }>(
    db, 'SELECT id FROM users WHERE CAST(nbw_uid AS TEXT) = ?', [String(cached.uid)]
  )
  if (alreadyBound && alreadyBound.id !== user.id) {
    return c.json({ error: '该宝宝新天地账户已被其他用户绑定' }, 409)
  }

  // 4. 绑定 + 登录
  await run(db, 'UPDATE users SET nbw_uid = ?, nbw_username = ? WHERE id = ?', [String(cached.uid), cached.username || null, user.id])
  const token = await signJWT({ sub: user.id, username: user.username, email: user.email, role: user.role }, c.env.JWT_SECRET)
  c.header('Set-Cookie', `token=${token}; ${tokenCookieOptions}`)

  return c.json({
    message: '绑定并登录成功',
    user: { id: user.id, username: user.username, email: user.email, avatar: user.avatar, role: user.role },
    nbw_uid: cached.uid,
    nbw_username: cached.username || null,
  })
})

/**
 * POST /api/auth/nbw/bind — 绑定 NewBabyWorld 账户（需登录）
 * Body: { code: string }
 */
nbw.post('/bind', authMiddleware, async (c) => {
  const user = c.get('user')
  const { clientId, clientSecret, redirectUri } = getNBWConfig(c)

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
    db, 'SELECT id FROM users WHERE CAST(nbw_uid AS TEXT) = ?', [String(nbwUser.uid)]
  )
  if (alreadyBound && alreadyBound.id !== user.sub) {
    return c.json({ error: '该宝宝新天地账户已被其他用户绑定' }, 409)
  }

  // 绑定
  await run(db, 'UPDATE users SET nbw_uid = ?, nbw_username = ? WHERE id = ?', [String(nbwUser.uid), nbwUser.username || null, user.sub])

  return c.json({ message: '绑定成功', nbw_uid: nbwUser.uid, nbw_username: nbwUser.username || null })
})

export default nbw
