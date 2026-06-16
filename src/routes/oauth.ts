import { Hono } from 'hono'
const DEFAULT_AVATAR = 'https://img.abdl-space.top/file/system/1781439303787_play_store_512.png'
import type { Env, JWTPayload } from '../types/index.ts'
import {
  OAUTH_CONFIG, ALL_SCOPES, SCOPE_DESCRIPTIONS,
  getClient, verifyClientSecret,
  createAuthorizationCode, consumeAuthorizationCode,
  issueToken, refreshAccessToken, revokeToken, introspectToken,
  type GrantType,
} from '../lib/oauth.ts'
import { queryOne } from '../lib/db.ts'
import { authMiddleware } from '../middleware/auth.ts'
import { rateLimit } from '../lib/rate-limit.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const oauth = new Hono<AppType>()

// 令牌端点限速：每 IP 每分钟 20 次
oauth.use('/token', rateLimit('oauth-token', 60_000, 20))
// 授权端点限速：每 IP 每分钟 30 次
oauth.use('/authorize', rateLimit('oauth-authorize', 60_000, 30))

/* ============================================================
 * GET /oauth/authorize — 授权端点
 * 如果用户已登录，自动签发 code 并 redirect
 * 如果未登录，返回 HTML 登录页面
 * ============================================================ */
oauth.get('/authorize', async (c) => {
  const clientId = c.req.query('client_id')
  const redirectUri = c.req.query('redirect_uri')
  const scope = c.req.query('scope') || 'read write follow push'
  const state = c.req.query('state') || ''
  const responseType = c.req.query('response_type') || 'code'
  const codeChallenge = c.req.query('code_challenge')
  const codeChallengeMethod = c.req.query('code_challenge_method')

  if (responseType !== 'code') return c.text('unsupported_response_type', 400)
  if (!clientId) return c.text('client_id required', 400)
  if (!redirectUri) return c.text('redirect_uri required', 400)

  const client = await getClient(c.env.abdl_space_db, clientId)
  if (!client || !client.active) return c.text('invalid_client', 400)
  if (!client.redirect_uris.includes(redirectUri)) return c.text('invalid_redirect_uri', 400)

  const requestedScopes = scope.split(' ').filter(s => ALL_SCOPES.includes(s as any))
  if (requestedScopes.length === 0) return c.text('invalid_scope', 400)

  // Check if user is already logged in (JWT in cookie or header)
  let userId: number | null = null
  try {
    const auth = c.req.header('Authorization')
    if (auth) {
      const { mastodonAuth } = await import('../mastodon/shared.ts')
      const user = await mastodonAuth(c)
      if (user) userId = user.sub
    }
  } catch {}

  if (userId) {
    // Already logged in — auto-authorize and redirect
    const code = await createAuthorizationCode(
      c.env.abdl_space_db, clientId, userId, redirectUri, scope, codeChallenge, codeChallengeMethod
    )
    const sep = redirectUri.includes('?') ? '&' : '?'
    const url = `${redirectUri}${sep}code=${code}${state ? `&state=${encodeURIComponent(state)}` : ''}`
    return c.redirect(url, 302)
  }

  // Not logged in — return HTML login page
  const params = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, scope, state,
    ...(codeChallenge ? { code_challenge: codeChallenge } : {}),
    ...(codeChallengeMethod ? { code_challenge_method: codeChallengeMethod } : {}),
  })

  return c.html(`<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ABDL Space - 登录授权</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family: -apple-system, system-ui, sans-serif; background:#f0f2f5; display:flex; justify-content:center; align-items:center; min-height:100vh; }
    .card { background:#fff; border-radius:16px; padding:32px; width:90%; max-width:400px; box-shadow:0 2px 12px rgba(0,0,0,0.1); text-align:center; }
    .logo { width:64px; height:64px; border-radius:16px; margin-bottom:16px; }
    h2 { margin-bottom:8px; color:#1a1a1a; }
    .desc { color:#666; font-size:14px; margin-bottom:24px; }
    input { width:100%; padding:12px; border:1px solid #ddd; border-radius:8px; margin-bottom:12px; font-size:15px; outline:none; }
    input:focus { border-color:#196584; }
    button { width:100%; padding:12px; background:#196584; color:#fff; border:none; border-radius:8px; font-size:15px; font-weight:600; cursor:pointer; }
    button:hover { background:#145268; }
    .error { color:#d32f2f; font-size:13px; margin-bottom:12px; display:none; }
  </style>
</head>
<body>
  <div class="card">
    <img class="logo" src="https://img.abdl-space.top/file/system/1781439303787_play_store_512.png" alt="ABDL Space">
    <h2>ABDL Space</h2>
    <p class="desc">登录以授权 ${client.name || 'Moshidon'} 访问你的账号</p>
    <div class="error" id="error"></div>
    <form method="POST" action="/oauth/authorize/login">
      <input type="hidden" name="params" value="${encodeURIComponent(params.toString())}">
      <input type="text" name="login" placeholder="用户名或邮箱" required autocomplete="username">
      <input type="password" name="password" placeholder="密码" required autocomplete="current-password">
      <button type="submit">登录并授权</button>
    </form>
  </div>
</body>
</html>`)
})

/* ============================================================
 * POST /oauth/authorize/login — 处理登录表单，登录后签发 code 并 redirect
 * ============================================================ */
oauth.post('/authorize/login', async (c) => {
  const formText = await c.req.text()
  const form = Object.fromEntries(new URLSearchParams(formText))
  const { login, password } = form
  const paramsStr = form.params

  if (!login || !password) return c.text('请输入用户名和密码', 400)

  // 验证用户凭据
  const user = await queryOne<{ id: number; password_hash: string; username: string }>(
    c.env.abdl_space_db, 'SELECT id, password_hash, username FROM users WHERE username = ? OR email = ?', [login, login]
  )
  if (!user) {
    return c.html('<html><body><h3>用户名或密码错误</h3><script>history.back()</script></body></html>', 401)
  }

  // 验证密码
  const { verifyPassword } = await import('../lib/auth.ts')
  const valid = await verifyPassword(password, user.password_hash)
  if (!valid) {
    return c.html('<html><body><h3>用户名或密码错误</h3><script>history.back()</script></body></html>', 401)
  }

  // 解析 OAuth 参数
  const params = new URLSearchParams(paramsStr)
  const clientId = params.get('client_id')!
  const redirectUri = params.get('redirect_uri')!
  const scope = params.get('scope') || 'read write follow push'
  const state = params.get('state') || ''
  const codeChallenge = params.get('code_challenge') || undefined
  const codeChallengeMethod = params.get('code_challenge_method') || undefined

  const code = await createAuthorizationCode(
    c.env.abdl_space_db, clientId, user.id, redirectUri, scope, codeChallenge, codeChallengeMethod
  )

  const sep = redirectUri.includes('?') ? '&' : '?'
  const url = `${redirectUri}${sep}code=${code}${state ? `&state=${encodeURIComponent(state)}` : ''}`
  return c.redirect(url, 302)
})

/* ============================================================
 * POST /oauth/token — 令牌端点
 * Body (form-urlencoded or JSON):
 *   grant_type=authorization_code&code=xxx&redirect_uri=xxx&client_id=xxx&client_secret=xxx
 *   grant_type=refresh_token&refresh_token=xxx&client_id=xxx&client_secret=xxx
 * ============================================================ */
oauth.post('/token', async (c) => {
  let body: Record<string, string>
  const contentType = c.req.header('Content-Type') || ''

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const text = await c.req.text()
    body = Object.fromEntries(new URLSearchParams(text))
  } else {
    try { body = await c.req.json() } catch { return c.json({ error: 'invalid body' }, 400) }
  }

  const grantType = body.grant_type as GrantType
  const clientId = body.client_id
  const clientSecret = body.client_secret

  if (!clientId) {
    return c.json({ error: 'client_id required' }, 401)
  }

  // 获取 client
  const client = await getClient(c.env.abdl_space_db, clientId)
  if (!client || !client.active) return c.json({ error: 'invalid_client' }, 401)

  // 公开客户端（PKCE）不需要 secret，机密客户端需要
  const isPublicClient = client.token_endpoint_auth_method === 'none'
  if (!isPublicClient) {
    if (!clientSecret) return c.json({ error: 'client_secret required' }, 401)
    const valid = await verifyClientSecret(c.env.abdl_space_db, clientId, clientSecret)
    if (!valid) return c.json({ error: 'invalid_client' }, 401)
  }

  if (grantType === 'authorization_code') {
    if (!client.grant_types.includes('authorization_code')) {
      return c.json({ error: 'unauthorized_grant_type' }, 400)
    }

    const { code, redirect_uri, code_verifier } = body
    if (!code || !redirect_uri) {
      return c.json({ error: 'code and redirect_uri required' }, 400)
    }

    // 公开客户端必须使用 PKCE
    if (isPublicClient && !code_verifier) {
      return c.json({ error: 'code_verifier required for public clients' }, 400)
    }

    const result = await consumeAuthorizationCode(
      c.env.abdl_space_db, code, clientId, redirect_uri, code_verifier
    )
    if (!result.valid) {
      return c.json({ error: result.error }, 400)
    }

    const token = await issueToken(c.env.abdl_space_db, clientId, result.userId!, result.scopes!)
    return c.json(token)
  }

  if (grantType === 'refresh_token') {
    if (!client.grant_types.includes('refresh_token')) {
      return c.json({ error: 'unauthorized_grant_type' }, 400)
    }

    const { refresh_token } = body
    if (!refresh_token) return c.json({ error: 'refresh_token required' }, 400)

    const result = await refreshAccessToken(c.env.abdl_space_db, refresh_token, clientId)
    if (!result.valid) return c.json({ error: result.error }, 400)

    return c.json(result.result)
  }

  return c.json({ error: 'unsupported_grant_type' }, 400)
})

/* ============================================================
 * POST /oauth/revoke — 吊销令牌
 * Body: { token, token_type_hint? }
 * ============================================================ */
oauth.post('/revoke', async (c) => {
  let body: { token?: string; token_type_hint?: string }
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid body' }, 400) }

  if (!body.token) return c.json({ error: 'token required' }, 400)

  const hint = body.token_type_hint === 'refresh_token' ? 'refresh_token' : 'access_token'
  await revokeToken(c.env.abdl_space_db, body.token, hint)

  // RFC 7009: 无论 token 是否存在都返回 200
  return c.json({ success: true })
})

/* ============================================================
 * POST /oauth/introspect — 令牌自省（资源服务器用）
 * Body: { token }
 * ============================================================ */
oauth.post('/introspect', async (c) => {
  let body: { token?: string }
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid body' }, 400) }

  if (!body.token) return c.json({ active: false })

  const result = await introspectToken(c.env.abdl_space_db, body.token, c.env.abdl_space_db)
  return c.json(result)
})

/* ============================================================
 * GET /oauth/scopes — 获取所有可用 scope
 * ============================================================ */
oauth.get('/scopes', (c) => {
  return c.json({
    scopes: ALL_SCOPES.map(s => ({
      value: s,
      description: SCOPE_DESCRIPTIONS[s],
    })),
  })
})

/* ============================================================
 * GET /oauth/userinfo — OAuth2 用户信息端点（类似 OIDC）
 * Headers: Authorization: Bearer <access_token>
 * ============================================================ */
oauth.get('/userinfo', async (c) => {
  const auth = c.req.header('Authorization')
  if (!auth) return c.json({ error: 'missing authorization' }, 401)
  const match = auth.match(/^Bearer\s+(.+)$/i)
  if (!match) return c.json({ error: 'invalid authorization' }, 401)

  const result = await introspectToken(c.env.abdl_space_db, match[1], c.env.abdl_space_db)
  if (!result.active || !result.sub) return c.json({ error: 'invalid token' }, 401)

  const scopes = (result.scope || '').split(' ')
  const user = await queryOne<{
    id: number; username: string; email: string; avatar: string | null;
    bio: string | null; role: string; created_at: string
  }>(c.env.abdl_space_db, 'SELECT id, username, email, avatar, bio, role, created_at FROM users WHERE id = ?', [result.sub])

  if (!user) return c.json({ error: 'user not found' }, 404)

  const info: Record<string, unknown> = { sub: user.id, username: user.username }
  if (scopes.includes('email')) info.email = user.email
  if (scopes.includes('profile')) {
    info.avatar = user.avatar
    info.bio = user.bio
    info.role = user.role
    info.created_at = user.created_at
  }

  return c.json(info)
})

/* ============================================================
 * GET /oauth/tokens — 获取当前用户已授权的 OAuth 应用列表
 * ============================================================ */
oauth.get('/tokens', authMiddleware, async (c) => {
  const user = c.get('user')
  const { getUserTokens } = await import('../lib/oauth.ts')
  const tokens = await getUserTokens(c.env.abdl_space_db, user.sub)
  return c.json({ tokens })
})

/* ============================================================
 * POST /oauth/revoke-client — 吊销某个 OAuth 应用的所有令牌
 * Body: { client_id }
 * ============================================================ */
oauth.post('/revoke-client', authMiddleware, async (c) => {
  const user = c.get('user')
  let body: { client_id?: string }
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid body' }, 400) }
  if (!body.client_id) return c.json({ error: 'client_id required' }, 400)

  const { revokeAllUserTokensForClient } = await import('../lib/oauth.ts')
  const count = await revokeAllUserTokensForClient(c.env.abdl_space_db, user.sub, body.client_id)
  return c.json({ success: true, revoked: count })
})

export default oauth
