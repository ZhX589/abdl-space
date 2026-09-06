import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { query, queryOne, run } from '../lib/db.ts'
import { authMiddleware } from '../middleware/auth.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const badges = new Hono<AppType>()

/**
 * POST /badge/acknowledge — 确认新徽章通知（App 启动弹窗后调用）
 * 注意：必须注册在 /:id 路由之前，避免被参数路由吞掉
 */
badges.post('/badge/acknowledge', authMiddleware, async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ badge_keys?: string[]; badge_key?: string }>().catch(() => null)
  const keys = body?.badge_keys ?? (body?.badge_key ? [body.badge_key] : [])
  if (!Array.isArray(keys) || keys.length === 0 || keys.some(k => typeof k !== 'string' || !k)) {
    return c.json({ error: 'badge_keys must be a non-empty string array' }, 400)
  }
  const ph = keys.map(() => '?').join(',')
  await run(c.env.abdl_space_db,
    `UPDATE user_badges SET acknowledged_at = CURRENT_TIMESTAMP WHERE user_id = ? AND badge_key IN (${ph}) AND acknowledged_at IS NULL`,
    [user.sub, ...keys])
  return c.json({ success: true, acknowledged: keys })
})

/**
 * GET /api/users/:id/badges — 用户徽章列表（含颜色与确认状态）
 */
badges.get('/:id/badges', async (c) => {
  const targetId = Number(c.req.param('id'))
  if (isNaN(targetId)) return c.json({ error: 'Invalid user ID' }, 400)

  const rows = await query<{
    badge_key: string; unlocked_at: string; displayed: number; acknowledged_at: string | null;
    name: string; description: string; color: string;
  }>(
    c.env.abdl_space_db,
    `SELECT ub.badge_key, ub.unlocked_at, ub.displayed, ub.acknowledged_at,
            b.name, b.description, b.color
     FROM user_badges ub
     JOIN badges b ON ub.badge_key = b.key
     WHERE ub.user_id = ?
     ORDER BY ub.unlocked_at DESC`,
    [targetId]
  )

  return c.json({
    user_id: targetId,
    badges: rows.map(r => ({
      key: r.badge_key,
      name: r.name,
      description: r.description,
      color: r.color,
      unlocked_at: r.unlocked_at,
      displayed: r.displayed === 1,
      acknowledged: r.acknowledged_at != null,
    })),
  })
})

/**
 * POST /api/users/:id/badges/display — 设置展示徽章（至多一枚，null/空=不展示）
 */
badges.post('/:id/badges/display', authMiddleware, async (c) => {
  const user = c.get('user')
  const targetId = Number(c.req.param('id'))

  // 只能改自己的展示
  if (user.sub !== targetId) {
    return c.json({ error: '只能修改自己的徽章展示' }, 403)
  }

  const body = await c.req.json<{ badge_key?: string | null }>()
  const badgeKey = body?.badge_key ?? null

  if (badgeKey != null) {
    if (typeof badgeKey !== 'string' || !badgeKey) {
      return c.json({ error: 'badge_key must be a string or null' }, 400)
    }
    const owned = await queryOne<{ id: number }>(
      c.env.abdl_space_db,
      'SELECT id FROM user_badges WHERE user_id = ? AND badge_key = ?',
      [targetId, badgeKey]
    )
    if (!owned) {
      return c.json({ error: `徽章 ${badgeKey} 未解锁` }, 400)
    }
  }

  // 事务：先全部取消展示，再设置展示的那一枚
  const batchOps = [
    c.env.abdl_space_db.prepare(
      'UPDATE user_badges SET displayed = 0 WHERE user_id = ?'
    ).bind(targetId),
  ]

  if (badgeKey != null) {
    batchOps.push(
      c.env.abdl_space_db.prepare(
        'UPDATE user_badges SET displayed = 1 WHERE user_id = ? AND badge_key = ?'
      ).bind(targetId, badgeKey)
    )
  }

  await c.env.abdl_space_db.batch(batchOps)

  return c.json({
    success: true,
    displayed: badgeKey,
  })
})

export default badges
