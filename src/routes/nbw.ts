import { Hono } from 'hono'
const DEFAULT_AVATAR = 'https://img.abdl-space.top/file/system/1781439303787_play_store_512.png'
import type { Env, JWTPayload } from '../types/index.ts'
import { queryOne, run } from '../lib/db.ts'
import { signJWT } from '../lib/auth.ts'
import { hashPassword } from '../lib/auth.ts'
import { authMiddleware } from '../middleware/auth.ts'
import { getNBWConfig, getAppNBWConfig } from '../lib/nbw.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const nbw = new Hono<AppType>()

/** UTF-8 安全的 base64url 编码/解码（username/avatar 可能含中文） */
function utf8ToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function base64UrlToUtf8(str: string): string {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4)
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

const NBW_TOKEN_URL = 'https://www.newbabyworld.top/oauth/token.php'
const NBW_USERINFO_URL = 'https://www.newbabyworld.top/oauth/userinfo.php'

const tokenCookieOptions = 'HttpOnly; Secure; SameSite=None; Domain=.abdl-space.top; Path=/; Max-Age=604800'



/**
 * 签发短时效 NBW 绑定 token（JWT 嵌入 uid/username/avatar，10 分钟有效）
 * 解决 Workers 多实例进程内 Map 不共享的问题
 * 使用 UTF-8 安全 base64url（username/avatar 可能含中文）
 */
async function signNBWBindToken(data: { uid: string; username: string; avatar: string | null }, secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' }
  const now = Date.now()
  const payload = { ...data, type: 'nbw_bind', iat: now, exp: now + 10 * 60 * 1000 } // 10 分钟
  const encoder = new TextEncoder()
  const headerB64 = utf8ToBase64Url(encoder.encode(JSON.stringify(header)))
  const payloadB64 = utf8ToBase64Url(encoder.encode(JSON.stringify(payload)))
  const signInput = `${headerB64}.${payloadB64}`
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(signInput))
  const sigB64 = utf8ToBase64Url(new Uint8Array(signature))
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
    const payload = JSON.parse(base64UrlToUtf8(parts[1]))
    if (payload.type !== 'nbw_bind' || !payload.exp || payload.exp < Date.now()) return null
    return { uid: payload.uid, username: payload.username, avatar: payload.avatar || DEFAULT_AVATAR }
  } catch { return null }
}

/**
 * GET /api/auth/nbw/config — 返回公开的 OAuth 配置（不含 secret）
 * 根据请求来源（Origin）返回对应的 OAuth 配置
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
      user: { id: existing.id, username: existing.username, email: existing.email, avatar: existing.avatar ?? DEFAULT_AVATAR, role: existing.role },
    })
  }

  // 4. 未绑定，签发短时效绑定 token 返回给前端
  let bindToken: string
  try {
    bindToken = await signNBWBindToken(
      { uid: nbwUser.uid, username: nbwUser.username || '', avatar: nbwUser.avatar || DEFAULT_AVATAR },
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
      avatar: nbwUser.avatar || DEFAULT_AVATAR,
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

/**
 * POST /api/auth/nbw/unbind — 解除 NewBabyWorld 账户绑定（需登录）
 * 删除用户的 nbw_uid 和 nbw_username
 * 若用户未设置密码且未验证邮箱，提示先设置密码（避免账号无法登录）
 */
nbw.post('/unbind', authMiddleware, async (c) => {
  const user = c.get('user')
  const db = c.env.abdl_space_db

  const row = await queryOne<{ nbw_uid: string | null; password_hash: string | null; email_verified: number | null; email: string | null }>(
    db, 'SELECT nbw_uid, password_hash, email_verified, email FROM users WHERE id = ?', [user.sub]
  )
  if (!row) return c.json({ error: '用户不存在' }, 404)
  if (!row.nbw_uid) return c.json({ error: '未绑定宝宝新天地账户' }, 400)

  // 防护：未设置密码 且 邮箱未验证 则不允许解绑（避免账号锁死）
  const hasPassword = !!row.password_hash
  const hasVerifiedEmail = !!(row.email_verified && row.email)
  if (!hasPassword && !hasVerifiedEmail) {
    return c.json({ error: '请先设置密码或绑定并验证邮箱后再解绑' }, 400)
  }

  await run(db, 'UPDATE users SET nbw_uid = NULL, nbw_username = NULL WHERE id = ?', [user.sub])

  return c.json({ message: '已解绑宝宝新天地账户' })
})

/**
 * GET /api/auth/nbw/mobile-start — App NBW 登录入口
 * 构造 NBW 授权 URL 并 302 重定向
 * 参数: state（CSRF 防护）
 */
nbw.get('/mobile-start', async (c) => {
  const { clientId, redirectUri } = getAppNBWConfig(c.env)
  if (!clientId) return c.text('NBW OAuth 未配置', 500)

  // 保留 App 传来的 state 中的 action 信息
  const clientState = c.req.query('state') || ''
  const stateData = { ts: Date.now(), nonce: crypto.randomUUID(), clientState }
  const signedState = btoa(JSON.stringify(stateData)).replace(/=/g, '')

  const url = new URL('https://www.newbabyworld.top/oauth/authorize.php')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('state', signedState)

  return c.redirect(url.toString(), 302)
})

/**
 * GET /api/auth/nbw/mobile-callback — App NBW 回调
 * NBW 授权完成后重定向到此端点
 * 参数: code, state
 * 已绑定 → 302 abdl-space://callback?token={jwt}
 * 未绑定 → 302 错误页 HTML
 * 注意: 不设置 Set-Cookie（隔离网页端登录状态）
 */
nbw.get('/mobile-callback', async (c) => {
  const code = c.req.query('code')
  if (!code) {
    return c.html(errorPage('授权失败：缺少授权码'), 200, { 'Content-Type': 'text/html; charset=utf-8' })
  }

  // 验证签名 state（替代 cookie 方案，支持跨域重定向链）
  const state = c.req.query('state')
  if (!state) {
    return c.html(errorPage('授权验证失败：缺少 state'), 200, { 'Content-Type': 'text/html; charset=utf-8' })
  }
  try {
    const data = JSON.parse(atob(state))
    if (!data.ts || Date.now() - data.ts > 10 * 60 * 1000) {
      return c.html(errorPage('授权已过期，请重试'), 200, { 'Content-Type': 'text/html; charset=utf-8' })
    }
  } catch {
    return c.html(errorPage('授权验证失败'), 200, { 'Content-Type': 'text/html; charset=utf-8' })
  }

  const { clientId, clientSecret, redirectUri } = getAppNBWConfig(c.env)
  if (!clientId || !clientSecret) {
    return c.html(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>配置错误</title></head><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#f5f5f5;">
<div style="background:#fff;border-radius:12px;padding:32px;text-align:center;max-width:400px;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
<h2 style="color:#d32f2f;">服务配置错误</h2>
<p style="color:#666;margin:16px 0;">NBW OAuth 未配置，请联系管理员。</p>
</div></body></html>`, 200, { 'Content-Type': 'text/html; charset=utf-8' })
  }

  const db = c.env.abdl_space_db

  // 1. code → NBW access_token
  let tokenData: { access_token?: string }
  try {
    const tokenRes = await fetch(NBW_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId, client_secret: clientSecret,
        grant_type: 'authorization_code', code, redirect_uri: redirectUri,
      }),
    })
    if (!tokenRes.ok) {
      return c.html(errorPage('NBW 授权码无效，请重试'), 200, { 'Content-Type': 'text/html; charset=utf-8' })
    }
    tokenData = await tokenRes.json()
  } catch {
    return c.html(errorPage('NBW 服务请求失败，请稍后重试'), 200, { 'Content-Type': 'text/html; charset=utf-8' })
  }

  if (!tokenData.access_token) {
    return c.html(errorPage('NBW Token 获取失败'), 200, { 'Content-Type': 'text/html; charset=utf-8' })
  }

  // 2. access_token → NBW 用户信息
  let nbwUser: { uid: string; username: string; avatar?: string }
  try {
    const userRes = await fetch(`${NBW_USERINFO_URL}?access_token=${tokenData.access_token}`)
    if (!userRes.ok) {
      return c.html(errorPage('NBW 用户信息获取失败'), 200, { 'Content-Type': 'text/html; charset=utf-8' })
    }
    const userData = await userRes.json()
    if (userData.errcode !== 0 || !userData.data?.uid) {
      return c.html(errorPage('NBW 用户信息无效'), 200, { 'Content-Type': 'text/html; charset=utf-8' })
    }
    nbwUser = userData.data
  } catch {
    return c.html(errorPage('NBW 用户信息请求失败'), 200, { 'Content-Type': 'text/html; charset=utf-8' })
  }

  // 3. 查 DB 是否已绑定
  let existing: { id: number; username: string; email: string; avatar: string | null; role: string } | null = null
  try {
    existing = await queryOne(
      db, 'SELECT id, username, email, avatar, role FROM users WHERE CAST(nbw_uid AS TEXT) = ?', [String(nbwUser.uid)]
    )
  } catch {}

  if (existing) {
    // 已绑定 → 判断来源：如果是绑定流程，返回 nbw_bind；如果是登录流程，返回 token
    const referer = c.req.header('Referer') || ''
    const isFromBind = state && state.includes('bind')
    if (isFromBind) {
      // 绑定流程 → 返回绑定成功
      return c.redirect(`abdl-space://callback?nbw_bind=success&nbw_user=${encodeURIComponent(existing.username)}`, 302)
    }
    // 登录流程 → 签发 JWT
    const token = await signJWT({ sub: existing.id, username: existing.username, email: existing.email, role: existing.role }, c.env.JWT_SECRET)
    try {
      await db.prepare('UPDATE users SET has_app = 1 WHERE id = ? AND has_app = 0').bind(existing.id).run()
    } catch {}
    return c.redirect(`abdl-space://callback?token=${encodeURIComponent(token)}`, 302)
  }

  // 4. 未绑定 → 区分绑定流程和登录流程
  const isBindFlow = data.clientState && data.clientState.includes('bind')
  if (isBindFlow) {
    // 绑定流程 → 返回需要绑定的提示
    return c.redirect(`abdl-space://callback?nbw_bind=need_bind&nbw_user=${encodeURIComponent(nbwUser.username || '')}`, 302)
  }
  // 登录流程 → 返回错误页
  return c.html(errorPage('该宝宝新天地账号尚未绑定 ABDL Space 账号，请先在 ABDL Space 网页端完成绑定后再使用此登录方式。'), 200, { 'Content-Type': 'text/html; charset=utf-8' })
})

function errorPage(message: string): string {
  const safe = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录失败</title></head><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#f5f5f5;margin:0;">
<div style="background:#fff;border-radius:12px;padding:32px;text-align:center;max-width:400px;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
<img src="https://img.abdl-space.top/file/system/1781439303787_play_store_512.png" style="width:48px;height:48px;border-radius:8px;margin-bottom:16px;">
<h2 style="color:#d32f2f;margin-bottom:8px;">登录失败</h2>
<p style="color:#666;margin:0;">${safe}</p>
</div></body></html>`
}

export default nbw
