import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { query, run } from '../lib/db.ts'
import { authMiddleware } from '../middleware/auth.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const notifications = new Hono<AppType>()

/**
 * GET /api/notifications — 当前用户通知列表
 */
notifications.get('/', authMiddleware, async (c) => {
  const user = c.get('user')

  const rows = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT id, type, message, related_id, read, created_at
     FROM notifications
     WHERE user_id = ?
     ORDER BY created_at DESC`,
    [user.sub]
  )

  const unread = await query<{ count: number }>(
    c.env.abdl_space_db,
    `SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read = 0`,
    [user.sub]
  )

  return c.json({
    notifications: rows.map(r => ({
      id: r.id,
      type: r.type,
      message: r.message,
      related_id: r.related_id ?? null,
      read: !!r.read,
      created_at: r.created_at
    })),
    unread_count: unread[0].count
  })
})

/**
 * POST /api/notifications/read-all — 全部标记已读
 */
notifications.post('/read-all', authMiddleware, async (c) => {
  const user = c.get('user')

  await run(
    c.env.abdl_space_db,
    'UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0',
    [user.sub]
  )

  return c.json({ message: '已全部标为已读' })
})

export default notifications
