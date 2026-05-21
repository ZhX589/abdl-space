import { Hono } from 'hono'
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

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const oauth = new Hono<AppType>()

/* ============================================================
 * GET /oauth/authorize — 授权端点（返回授权页面数据）
 * 前端调用: GET /api/oauth/authorize?client_id=xxx&redirect_uri=xxx&scope=xxx&state=xxx&response_type=code
 *
 * 注意: 这个端点不直接 redirect，而是返回 JSON 给前端
 * 前端渲染同意页面，用户确认后 POST /oauth/authorize
 * ============================================================ */
oauth.get('/authorize', authMiddleware, async (c) => {
  const clientId = c.req.query('client_id')
  const redirectUri = c.req.query('redirect_uri')
  const scope = c.req.query('scope') || 'profile'
  const state = c.req.query('state') || ''
  const responseType = c.req.query('response_type') || 'code'
  const codeChallenge = c.req.query('code_challenge')
  const codeChallengeMethod = c.req.query('code_challenge_method')

  if (responseType !== 'code') {
    return c.json({ error: 'unsupported_response_type' }, 400)
  }
  if (!clientId) return c.json({ error: 'client_id required' }, 400)
  if (!redirectUri) return c.json({ error: 'redirect_uri required' }, 400)

  const client = await getClient(c.env.abdl_space_db, clientId)
  if (!client || !client.active) {
    return c.json({ error: 'invalid_client' }, 400)
  }
  if (!client.redirect_uris.includes(redirectUri)) {
    return c.json({ error: 'invalid_redirect_uri' }, 400)
  }

  const requestedScopes = scope.split(' ').filter(s => ALL_SCOPES.includes(s as any))
  if (requestedScopes.length === 0) {
    return c.json({ error: 'invalid_scope' }, 400)
  }

  // 获取用户信息
  const user = c.get('user')
  const dbUser = await queryOne<{ id: number; username: string; avatar: string | null }>(
    c.env.abdl_space_db, 'SELECT id, username, avatar FROM users WHERE id = ?', [user.sub]
  )

  return c.json({
    client: {
      client_id: client.client_id,
      name: client.name,
      description: client.description,
      logo_url: client.logo_url,
      homepage_url: client.homepage_url,
    },
    user: dbUser ? { id: dbUser.id, username: dbUser.username, avatar: dbUser.avatar } : null,
    scopes: requestedScopes.map(s => ({
      value: s,
      description: SCOPE_DESCRIPTIONS[s as keyof typeof SCOPE_DESCRIPTIONS] || s,
    })),
    state,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
    expires_in: OAUTH_CONFIG.CODE_TTL_S,
  })
})

/* ============================================================
 * POST /oauth/authorize — 用户确认授权，签发授权码
 * Body: { client_id, redirect_uri, scope, state?, code_challenge?, code_challenge_method? }
 * ============================================================ */
oauth.post('/authorize', authMiddleware, async (c) => {
  let body: {
    client_id?: string; redirect_uri?: string; scope?: string;
    state?: string; code_challenge?: string; code_challenge_method?: string;
    approved?: boolean
  }
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid body' }, 400) }

  const { client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, approved } = body

  if (!approved) {
    // 用户拒绝授权
    if (!redirect_uri || !client_id) return c.json({ error: 'denied' }, 403)
    const sep = redirect_uri.includes('?') ? '&' : '?'
    return c.json({
      redirect: `${redirect_uri}${sep}error=access_denied&state=${encodeURIComponent(state || '')}`,
    })
  }

  if (!client_id || !redirect_uri || !scope) {
    return c.json({ error: 'client_id, redirect_uri, scope required' }, 400)
  }

  const client = await getClient(c.env.abdl_space_db, client_id)
  if (!client || !client.active) return c.json({ error: 'invalid_client' }, 400)
  if (!client.redirect_uris.includes(redirect_uri)) return c.json({ error: 'invalid_redirect_uri' }, 400)

  const user = c.get('user')
  const code = await createAuthorizationCode(
    c.env.abdl_space_db,
    client_id,
    user.sub,
    redirect_uri,
    scope,
    code_challenge,
    code_challenge_method
  )

  const sep = redirect_uri.includes('?') ? '&' : '?'
  const redirectUrl = `${redirect_uri}${sep}code=${code}${state ? `&state=${encodeURIComponent(state)}` : ''}`

  return c.json({ redirect: redirectUrl })
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

export default oauth
