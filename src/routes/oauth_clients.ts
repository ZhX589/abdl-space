import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import {
  createClient, getClient, getClientsByOwner, updateClient, deleteClient,
  getUserTokens, revokeAllUserTokensForClient,
  ALL_SCOPES,
} from '../lib/oauth.ts'
import { authMiddleware } from '../middleware/auth.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const oauthClients = new Hono<AppType>()

/* ============================================================
 * OAuth Client 管理 — 需要登录（开发者自助管理）
 * ============================================================ */

/**
 * GET /api/oauth/clients — 获取当前用户的所有 OAuth 客户端
 */
oauthClients.get('/', authMiddleware, async (c) => {
  const user = c.get('user')
  const clients = await getClientsByOwner(c.env.abdl_space_db, user.sub)
  return c.json({
    clients: clients.map(cl => ({
      ...cl,
      // 不返回 client_secret hash
      has_secret: true,
    })),
  })
})

/**
 * POST /api/oauth/clients — 创建新 OAuth 客户端
 * Body: { name, description?, logo_url?, homepage_url?, redirect_uris, scopes? }
 * Response: { client, raw_secret }  ← 仅此一次返回完整 secret
 */
oauthClients.post('/', authMiddleware, async (c) => {
  const user = c.get('user')
  let body: {
    name?: string; description?: string; logo_url?: string;
    homepage_url?: string; redirect_uris?: string[]; scopes?: string[]
  }
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid body' }, 400) }

  if (!body.name || !body.redirect_uris?.length) {
    return c.json({ error: 'name and redirect_uris required' }, 400)
  }

  try {
    const { client, raw_secret } = await createClient(c.env.abdl_space_db, user.sub, {
      name: body.name,
      description: body.description,
      logo_url: body.logo_url,
      homepage_url: body.homepage_url,
      redirect_uris: body.redirect_uris,
      scopes: body.scopes,
    })
    return c.json({ client, raw_secret })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg === 'MAX_CLIENTS') return c.json({ error: '最多创建 20 个 OAuth 客户端' }, 400)
    if (msg === 'INVALID_REDIRECT_URIS') return c.json({ error: 'redirect_uris 格式无效' }, 400)
    console.error('create oauth client error:', err)
    return c.json({ error: '创建失败' }, 500)
  }
})

/**
 * PATCH /api/oauth/clients/:clientId — 更新客户端
 */
oauthClients.patch('/:clientId', authMiddleware, async (c) => {
  const user = c.get('user')
  const clientId = c.req.param('clientId')

  let body: Record<string, unknown>
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid body' }, 400) }

  const ok = await updateClient(c.env.abdl_space_db, clientId, user.sub, body as any)
  if (!ok) return c.json({ error: '客户端不存在或无权操作' }, 404)
  return c.json({ message: '已更新' })
})

/**
 * DELETE /api/oauth/clients/:clientId — 删除客户端
 */
oauthClients.delete('/:clientId', authMiddleware, async (c) => {
  const user = c.get('user')
  const clientId = c.req.param('clientId')

  const ok = await deleteClient(c.env.abdl_space_db, clientId, user.sub)
  if (!ok) return c.json({ error: '客户端不存在或无权操作' }, 404)
  return c.json({ message: '已删除' })
})

/**
 * GET /api/oauth/clients/:clientId — 获取单个客户端详情
 */
oauthClients.get('/:clientId', authMiddleware, async (c) => {
  const user = c.get('user')
  const clientId = c.req.param('clientId')
  const client = await getClient(c.env.abdl_space_db, clientId)
  if (!client || client.owner_id !== user.sub) return c.json({ error: 'not found' }, 404)
  return c.json({ client })
})

/* ============================================================
 * 用户已授权 Token 管理
 * ============================================================ */

/**
 * GET /api/oauth/my-tokens — 获取当前用户已授权的 token 列表
 */
oauthClients.get('/my-tokens', authMiddleware, async (c) => {
  const user = c.get('user')
  const tokens = await getUserTokens(c.env.abdl_space_db, user.sub)
  return c.json({ tokens })
})

/**
 * POST /api/oauth/revoke-client — 吊销某个客户端的所有 token
 * Body: { client_id }
 */
oauthClients.post('/revoke-client', authMiddleware, async (c) => {
  const user = c.get('user')
  let body: { client_id?: string }
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid body' }, 400) }
  if (!body.client_id) return c.json({ error: 'client_id required' }, 400)

  const count = await revokeAllUserTokensForClient(c.env.abdl_space_db, user.sub, body.client_id)
  return c.json({ message: `已吊销 ${count} 个 token` })
})

/* ============================================================
 * 公开信息（无需登录）
 * ============================================================ */

/**
 * GET /api/oauth/scopes — 可用 scope 列表
 */
oauthClients.get('/scopes', (c) => {
  return c.json({ scopes: ALL_SCOPES })
})

export default oauthClients
