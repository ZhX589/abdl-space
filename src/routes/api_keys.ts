import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { query, queryOne, run } from '../lib/db.ts'
import { adminMiddleware } from '../middleware/auth.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const apiKeys = new Hono<AppType>()

/**
 * GET /api/api_keys — 获取所有 API key（不返回 key_value 明文）
 */
apiKeys.get('/', adminMiddleware, async (c) => {
  const rows = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    'SELECT id, provider, label, created_at, updated_at FROM api_keys ORDER BY provider'
  )
  return c.json({ keys: rows.map(r => ({
    id: r.id,
    provider: r.provider,
    label: r.label ?? null,
    has_key: !!r.provider,
    created_at: r.created_at,
    updated_at: r.updated_at
  })) })
})

/**
 * POST /api/api_keys — 设置或更新 API key
 */
apiKeys.post('/', adminMiddleware, async (c) => {
  const body = await c.req.json<{ provider: string; key_value: string; label?: string }>()
  const { provider, key_value, label } = body

  if (!provider || !key_value) {
    return c.json({ error: 'provider and key_value are required' }, 400)
  }
  if (!['deepseek', 'openai', 'anthropic'].includes(provider)) {
    return c.json({ error: 'provider must be deepseek, openai, or anthropic' }, 400)
  }

  const existing = await queryOne<{ id: number }>(
    c.env.abdl_space_db,
    'SELECT id FROM api_keys WHERE provider = ?',
    [provider]
  )

  if (existing) {
    await run(
      c.env.abdl_space_db,
      'UPDATE api_keys SET key_value = ?, label = ?, updated_at = CURRENT_TIMESTAMP WHERE provider = ?',
      [key_value, label ?? null, provider]
    )
    return c.json({ message: `${provider} API key updated` })
  } else {
    await run(
      c.env.abdl_space_db,
      'INSERT INTO api_keys (provider, key_value, label) VALUES (?, ?, ?)',
      [provider, key_value, label ?? null]
    )
    return c.json({ message: `${provider} API key saved` }, 201)
  }
})

/**
 * DELETE /api/api_keys/:provider — 删除 API key
 */
apiKeys.delete('/:provider', adminMiddleware, async (c) => {
  const provider = c.req.param('provider')

  const existing = await queryOne<{ id: number }>(
    c.env.abdl_space_db,
    'SELECT id FROM api_keys WHERE provider = ?',
    [provider]
  )
  if (!existing) return c.json({ error: 'API key not found' }, 404)

  await run(c.env.abdl_space_db, 'DELETE FROM api_keys WHERE provider = ?', [provider])
  return c.json({ message: `${provider} API key deleted` })
})

export default apiKeys