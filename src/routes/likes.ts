import { Hono } from 'hono'
import type { Env, JWTPayload, LikeRequest } from '../types/index.ts'
import { queryOne, run } from '../lib/db.ts'
import { authMiddleware } from '../middleware/auth.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const likes = new Hono<AppType>()

/**
 * POST /api/likes — 点赞/取消点赞（toggle）
 */
likes.post('/', authMiddleware, async (c) => {
  const user = c.get('user')
  const body = await c.req.json<LikeRequest>()
  const { target_type, target_id } = body

  if (!target_type || !target_id) {
    return c.json({ error: 'target_type and target_id are required' }, 400)
  }
  if (target_type !== 'post' && target_type !== 'comment') {
    return c.json({ error: 'target_type must be post or comment' }, 400)
  }

  const table = target_type === 'post' ? 'posts' : 'post_comments'
  const target = await queryOne<{ id: number }>(
    c.env.abdl_space_db,
    `SELECT id FROM ${table} WHERE id = ?`,
    [target_id]
  )
  if (!target) return c.json({ error: 'Target not found' }, 404)

  const existing = await queryOne<{ user_id: number }>(
    c.env.abdl_space_db,
    'SELECT user_id FROM likes WHERE user_id = ? AND target_type = ? AND target_id = ?',
    [user.sub, target_type, target_id]
  )

  if (existing) {
    await run(
      c.env.abdl_space_db,
      'DELETE FROM likes WHERE user_id = ? AND target_type = ? AND target_id = ?',
      [user.sub, target_type, target_id]
    )
    return c.json({ liked: false })
  }

  await run(
    c.env.abdl_space_db,
    'INSERT INTO likes (user_id, target_type, target_id) VALUES (?, ?, ?)',
    [user.sub, target_type, target_id]
  )
  return c.json({ liked: true })
})

export default likes
