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

  const tableMap: Record<string, string> = { post: 'posts', comment: 'post_comments' }
  const table = tableMap[target_type]
  if (!table) return c.json({ error: 'Invalid target_type' }, 400)

  const targetId = parseInt(String(target_id))
  if (!targetId || targetId < 1) return c.json({ error: 'Invalid target_id' }, 400)

  const target = await queryOne<{ id: number }>(
    c.env.abdl_space_db,
    `SELECT id FROM ${table} WHERE id = ?`,
    [targetId]
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

  // 创建通知（不给自己发）
  if (target_type === 'post') {
    const post = await queryOne<{ user_id: number }>(
      c.env.abdl_space_db,
      'SELECT user_id FROM posts WHERE id = ?',
      [target_id]
    )
    if (post && post.user_id !== user.sub) {
      await run(
        c.env.abdl_space_db,
        'INSERT INTO notifications (user_id, type, message, related_id) VALUES (?, ?, ?, ?)',
        [post.user_id, 'like', `${user.username} 赞了你的帖子`, target_id]
      )
    }
  } else {
    const comment = await queryOne<{ user_id: number; post_id: number }>(
      c.env.abdl_space_db,
      'SELECT user_id, post_id FROM post_comments WHERE id = ?',
      [target_id]
    )
    if (comment && comment.user_id !== user.sub) {
      await run(
        c.env.abdl_space_db,
        'INSERT INTO notifications (user_id, type, message, related_id) VALUES (?, ?, ?, ?)',
        [comment.user_id, 'like', `${user.username} 赞了你的评论`, comment.post_id]
      )
    }
  }

  return c.json({ liked: true })
})

export default likes
