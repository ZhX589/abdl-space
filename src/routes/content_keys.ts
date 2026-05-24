import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { query, queryOne, run } from '../lib/db.ts'
import { authMiddleware } from '../middleware/auth.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const contentKeys = new Hono<AppType>()

/* ============================================================
 * 工具函数
 * ============================================================ */

/** 生成 API Key: ak_ + 48 字符随机 hex */
function generateApiKey(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
  return `ak_${hex}`
}

async function sha256(input: string, salt?: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = salt ? encoder.encode(salt + ':' + input) : encoder.encode(input)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/* ============================================================
 * API Key 管理 — 需要登录
 * ============================================================ */

/**
 * GET /api/content/keys — 获取当前用户的所有 Content API Key
 */
contentKeys.get('/', authMiddleware, async (c) => {
  const user = c.get('user')
  const rows = await query<{
    id: number; key_prefix: string; label: string | null;
    permissions: string; rate_limit: number; active: number;
    last_used: number | null; use_count: number; created_at: number
  }>(
    c.env.abdl_space_db,
    'SELECT id, key_prefix, label, permissions, rate_limit, active, last_used, use_count, created_at FROM content_api_keys WHERE owner_id = ? ORDER BY created_at DESC',
    [user.sub]
  )
  return c.json({
    keys: rows.map(r => ({
      id: r.id,
      key_prefix: r.key_prefix,
      label: r.label,
      permissions: r.permissions.split(','),
      rate_limit: r.rate_limit,
      active: !!r.active,
      last_used: r.last_used,
      use_count: r.use_count,
      created_at: r.created_at,
    })),
  })
})

/**
 * POST /api/content/keys — 创建新 Content API Key
 * Body: { label?: string, permissions?: string[], rate_limit?: number }
 * Response: { id, key, key_prefix, ... }  ← 只返回一次完整 key
 */
contentKeys.post('/', authMiddleware, async (c) => {
  const user = c.get('user')
  let body: { label?: string; permissions?: string[]; rate_limit?: number }
  try { body = await c.req.json() } catch { body = {} }

  // 限制每个用户最多 10 个 key
  const count = await queryOne<{ cnt: number }>(
    c.env.abdl_space_db,
    'SELECT COUNT(*) as cnt FROM content_api_keys WHERE owner_id = ?',
    [user.sub]
  )
  if (count && count.cnt >= 10) {
    return c.json({ error: '每个用户最多创建 10 个 API Key' }, 400)
  }

  // 创建频率限制：同一用户 10 秒内只能创建 1 个
  const recent = await queryOne<{ cnt: number }>(
    c.env.abdl_space_db,
    'SELECT COUNT(*) as cnt FROM content_api_keys WHERE owner_id = ? AND created_at > ?',
    [user.sub, nowSeconds() - 10]
  )
  if (recent && recent.cnt > 0) {
    return c.json({ error: '创建过于频繁，请稍后再试' }, 429)
  }

  const validPerms = ['read_posts', 'read_rankings', 'read_diapers']
  const permissions = (body.permissions || validPerms).filter(p => validPerms.includes(p))
  if (permissions.length === 0) {
    return c.json({ error: `permissions 无效。可选: ${validPerms.join(', ')}` }, 400)
  }

  const rawKey = generateApiKey()
  const keyHash = await sha256(rawKey, 'abdl-content-key')
  const keyPrefix = rawKey.slice(0, 11)  // "ak_" + 前8字符
  const rateLimit = Math.min(Math.max(body.rate_limit || 200, 1), 10000)
  const now = nowSeconds()

  const result = await run(
    c.env.abdl_space_db,
    `INSERT INTO content_api_keys (key_prefix, key_hash, label, permissions, rate_limit, active, created_at, owner_id)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    [keyPrefix, keyHash, body.label || null, permissions.join(','), rateLimit, now, user.sub]
  )

  return c.json({
    id: result.meta.last_row_id,
    key: rawKey,          // ⚠️ 仅此一次返回完整 key
    key_prefix: keyPrefix,
    label: body.label || null,
    permissions,
    rate_limit: rateLimit,
    active: true,
    created_at: now,
  })
})

/**
 * PATCH /api/content/keys/:id — 更新 key（label/permissions/rate_limit/active）
 */
contentKeys.patch('/:id', authMiddleware, async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)

  const existing = await queryOne<{ id: number; owner_id: number }>(
    c.env.abdl_space_db,
    'SELECT id, owner_id FROM content_api_keys WHERE id = ?',
    [id]
  )
  if (!existing) return c.json({ error: 'API Key 不存在' }, 404)
  if (existing.owner_id !== user.sub) return c.json({ error: '无权操作' }, 403)

  let body: { label?: string; permissions?: string[]; rate_limit?: number; active?: boolean }
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid body' }, 400) }

  const sets: string[] = []
  const params: unknown[] = []

  if (body.label !== undefined) { sets.push('label = ?'); params.push(body.label) }
  if (body.permissions) {
    const validPerms = ['read_posts', 'read_rankings', 'read_diapers']
    const filtered = body.permissions.filter(p => validPerms.includes(p))
    if (filtered.length === 0) return c.json({ error: 'permissions 无效' }, 400)
    sets.push('permissions = ?'); params.push(filtered.join(','))
  }
  if (body.rate_limit !== undefined) { sets.push('rate_limit = ?'); params.push(Math.min(Math.max(body.rate_limit, 1), 10000)) }
  if (body.active !== undefined) { sets.push('active = ?'); params.push(body.active ? 1 : 0) }

  if (sets.length === 0) return c.json({ error: 'No fields to update' }, 400)

  params.push(id)
  await run(c.env.abdl_space_db, `UPDATE content_api_keys SET ${sets.join(', ')} WHERE id = ?`, params)

  return c.json({ message: '已更新' })
})

/**
 * DELETE /api/content/keys/:id — 删除 key
 */
contentKeys.delete('/:id', authMiddleware, async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)

  const existing = await queryOne<{ id: number; owner_id: number }>(
    c.env.abdl_space_db,
    'SELECT id, owner_id FROM content_api_keys WHERE id = ?',
    [id]
  )
  if (!existing) return c.json({ error: 'API Key 不存在' }, 404)
  if (existing.owner_id !== user.sub) return c.json({ error: '无权操作' }, 403)

  await run(c.env.abdl_space_db, 'DELETE FROM content_api_keys WHERE id = ?', [id])
  return c.json({ message: '已删除' })
})

export default contentKeys

/* ============================================================
 * 外部 API Key 验证工具函数（供 content_v1 路由使用）
 * ============================================================ */

export async function validateContentApiKey(
  db: D1Database,
  rawKey: string
): Promise<{ valid: boolean; keyId?: number; permissions?: string[]; rateLimit?: number; ownerId?: number }> {
  const keyHash = await sha256(rawKey, 'abdl-content-key')
  const row = await queryOne<{
    id: number; permissions: string; rate_limit: number; active: number; owner_id: number
  }>(
    db,
    'SELECT id, permissions, rate_limit, active, owner_id FROM content_api_keys WHERE key_hash = ?',
    [keyHash]
  )
  if (!row || !row.active) return { valid: false }
  return {
    valid: true,
    keyId: row.id,
    permissions: row.permissions.split(','),
    rateLimit: row.rate_limit,
    ownerId: row.owner_id,
  }
}

export async function recordContentKeyUsage(db: D1Database, keyId: number): Promise<void> {
  await run(db,
    'UPDATE content_api_keys SET last_used = ?, use_count = use_count + 1 WHERE id = ?',
    [nowSeconds(), keyId]
  )
}
