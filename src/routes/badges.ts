import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { query, queryOne } from '../lib/db.ts'
import { authMiddleware } from '../middleware/auth.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const badges = new Hono<AppType>()

const MAX_DISPLAYED_BADGES = 3

/**
 * GET /api/users/:id/badges — 用户徽章列表
 */
badges.get('/:id/badges', authMiddleware, async (c) => {
  const targetId = Number(c.req.param('id'))
  if (isNaN(targetId)) return c.json({ error: 'Invalid user ID' }, 400)

  const rows = await query<{
    badge_key: string; unlocked_at: string; displayed: number;
    name: string; icon: string; description: string;
  }>(
    c.env.abdl_space_db,
    `SELECT ub.badge_key, ub.unlocked_at, ub.displayed,
            b.name, b.icon, b.description
     FROM user_badges ub
     JOIN badges b ON ub.badge_key = b.key
     WHERE ub.user_id = ?
     ORDER BY ub.displayed DESC, ub.unlocked_at DESC`,
    [targetId]
  )

  return c.json({
    user_id: targetId,
    badges: rows.map(r => ({
      key: r.badge_key,
      name: r.name,
      icon: r.icon,
      description: r.description,
      unlocked_at: r.unlocked_at,
      displayed: r.displayed === 1,
    })),
  })
})

/**
 * POST /api/users/:id/badges/display — 设置展示（≤3）
 */
badges.post('/:id/badges/display', authMiddleware, async (c) => {
  const user = c.get('user')
  const targetId = Number(c.req.param('id'))

  // 只能改自己的展示
  if (user.sub !== targetId) {
    return c.json({ error: '只能修改自己的徽章展示' }, 403)
  }

  const body = await c.req.json<{ badge_keys: string[] }>()
  const { badge_keys } = body

  if (!Array.isArray(badge_keys)) {
    return c.json({ error: 'badge_keys must be an array' }, 400)
  }

  if (badge_keys.length > MAX_DISPLAYED_BADGES) {
    return c.json({ error: `最多展示 ${MAX_DISPLAYED_BADGES} 个徽章` }, 400)
  }

  // 验证所有徽章都属于该用户
  for (const key of badge_keys) {
    const owned = await queryOne<{ id: number }>(
      c.env.abdl_space_db,
      'SELECT id FROM user_badges WHERE user_id = ? AND badge_key = ?',
      [targetId, key]
    )
    if (!owned) {
      return c.json({ error: `徽章 ${key} 未解锁` }, 400)
    }
  }

  // 事务：先全部取消展示，再设置展示
  const batchOps = [
    c.env.abdl_space_db.prepare(
      'UPDATE user_badges SET displayed = 0 WHERE user_id = ?'
    ).bind(targetId),
  ]

  for (const key of badge_keys) {
    batchOps.push(
      c.env.abdl_space_db.prepare(
        'UPDATE user_badges SET displayed = 1 WHERE user_id = ? AND badge_key = ?'
      ).bind(targetId, key)
    )
  }

  await c.env.abdl_space_db.batch(batchOps)

  return c.json({
    success: true,
    displayed: badge_keys,
  })
})

export default badges
