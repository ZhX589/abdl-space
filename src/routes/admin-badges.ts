import { Hono } from 'hono'
import type { Env } from '../types/index.ts'
import { query, queryOne, run } from '../lib/db.ts'
import { adminMiddleware } from '../middleware/auth.ts'

type AppType = { Bindings: Env; Variables: { user: { sub: number; role: string } } }

const adminBadges = new Hono<AppType>()

adminBadges.use('*', adminMiddleware)

const COLOR_RE = /^#[0-9a-fA-F]{6}$/

/**
 * GET /api/admin/badges — 徽章定义列表（含持有人数）
 */
adminBadges.get('/', async (c) => {
  const rows = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT b.key, b.name, b.description, b.color, b.icon, b.condition_type, b.condition_value,
            (SELECT COUNT(*) FROM user_badges ub WHERE ub.badge_key = b.key) AS holders
     FROM badges b ORDER BY b.id`
  )
  return c.json({ badges: rows })
})

/**
 * POST /api/admin/badges — 新建徽章定义
 * Body: { key, name, description?, color }
 */
adminBadges.post('/', async (c) => {
  const body = await c.req.json<{
    key?: string; name?: string; description?: string; color?: string; icon?: string
  }>()
  const key = body?.key?.trim() || ''
  const name = body?.name?.trim() || ''
  const description = body?.description?.trim() || ''
  const color = body?.color?.trim() || '#7C4DFF'
  const icon = body?.icon?.trim() || 'verified'
  if (!key || key.length > 64 || !name || name.length > 64) {
    return c.json({ error: 'key 与 name 必填且长度 ≤ 64' }, 422)
  }
  if (!COLOR_RE.test(color)) return c.json({ error: 'color 必须为 #RRGGBB' }, 422)
  const exists = await queryOne(c.env.abdl_space_db, 'SELECT key FROM badges WHERE key = ?', [key])
  if (exists) return c.json({ error: `徽章 ${key} 已存在` }, 409)
  await run(c.env.abdl_space_db,
    'INSERT INTO badges (key, name, icon, description, color, condition_type, condition_value) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [key, name, icon, description, color, 'manual', 0])
  return c.json({ success: true, key }, 201)
})

/**
 * PATCH /api/admin/badges/:key — 更新徽章定义（名称/描述/颜色）
 */
adminBadges.patch('/:key', async (c) => {
  const key = c.req.param('key')
  const body = await c.req.json<{ name?: string; description?: string; color?: string }>()
  const row = await queryOne(c.env.abdl_space_db, 'SELECT key FROM badges WHERE key = ?', [key])
  if (!row) return c.json({ error: '徽章不存在' }, 404)
  const name = body?.name?.trim()
  const description = body?.description?.trim()
  const color = body?.color?.trim()
  if (color && !COLOR_RE.test(color)) return c.json({ error: 'color 必须为 #RRGGBB' }, 422)
  await run(c.env.abdl_space_db,
    `UPDATE badges SET
       name = COALESCE(?, name),
       description = COALESCE(?, description),
       color = COALESCE(?, color)
     WHERE key = ?`,
    [name || null, description || null, color || null, key])
  return c.json({ success: true, key })
})

/**
 * POST /api/admin/badges/grant — 颁发徽章
 * Body: { badge_key, username? | user_id? }
 */
adminBadges.post('/grant', async (c) => {
  const body = await c.req.json<{ badge_key?: string; username?: string; user_id?: number }>()
  const badgeKey = body?.badge_key?.trim() || ''
  if (!badgeKey) return c.json({ error: 'badge_key 必填' }, 422)
  const badge = await queryOne(c.env.abdl_space_db, 'SELECT key FROM badges WHERE key = ?', [badgeKey])
  if (!badge) return c.json({ error: '徽章不存在' }, 404)

  let userId: number | null = null
  if (body?.user_id != null && Number.isFinite(Number(body.user_id))) {
    userId = Number(body.user_id)
  } else if (body?.username?.trim()) {
    const u = await queryOne<{ id: number }>(c.env.abdl_space_db, 'SELECT id FROM users WHERE username = ?', [body.username.trim()])
    userId = u?.id ?? null
  }
  if (!userId) return c.json({ error: '用户不存在' }, 404)

  const owned = await queryOne(c.env.abdl_space_db,
    'SELECT id FROM user_badges WHERE user_id = ? AND badge_key = ?', [userId, badgeKey])
  if (owned) return c.json({ error: '该用户已持有此徽章' }, 409)
  // acknowledged_at 留空：App 下次启动会弹窗提示新徽章
  await run(c.env.abdl_space_db,
    'INSERT INTO user_badges (user_id, badge_key, acknowledged_at) VALUES (?, ?, NULL)', [userId, badgeKey])
  return c.json({ success: true, user_id: userId, badge_key: badgeKey }, 201)
})

/**
 * POST /api/admin/badges/revoke — 收回徽章
 * Body: { badge_key, username? | user_id? }
 */
adminBadges.post('/revoke', async (c) => {
  const body = await c.req.json<{ badge_key?: string; username?: string; user_id?: number }>()
  const badgeKey = body?.badge_key?.trim() || ''
  if (!badgeKey) return c.json({ error: 'badge_key 必填' }, 422)

  let userId: number | null = null
  if (body?.user_id != null && Number.isFinite(Number(body.user_id))) {
    userId = Number(body.user_id)
  } else if (body?.username?.trim()) {
    const u = await queryOne<{ id: number }>(c.env.abdl_space_db, 'SELECT id FROM users WHERE username = ?', [body.username.trim()])
    userId = u?.id ?? null
  }
  if (!userId) return c.json({ error: '用户不存在' }, 404)

  const result = await run(c.env.abdl_space_db,
    'DELETE FROM user_badges WHERE user_id = ? AND badge_key = ?', [userId, badgeKey])
  if ((result.meta?.changes ?? 0) === 0) return c.json({ error: '该用户未持有此徽章' }, 404)
  return c.json({ success: true })
})

export default adminBadges
