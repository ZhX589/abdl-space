import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { query, queryOne, run } from '../lib/db.ts'
import { authMiddleware } from '../middleware/auth.ts'

const DEFAULT_AVATAR = 'https://img.abdl-space.top/file/system/1781439303787_play_store_512.png'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const follows = new Hono<AppType>()

/**
 * POST /api/follows/:userId — 关注用户
 */
follows.post('/:userId', authMiddleware, async (c) => {
  const user = c.get('user')
  const targetId = parseInt(c.req.param('userId'))

  if (targetId === Number(user.sub)) {
    return c.json({ error: '不能关注自己' }, 400)
  }

  const target = await queryOne<{ id: number }>(
    c.env.abdl_space_db,
    'SELECT id FROM users WHERE id = ?',
    [targetId]
  )
  if (!target) return c.json({ error: '用户不存在' }, 404)

  // 检查是否已关注
  const existing = await queryOne<{ id: number }>(
    c.env.abdl_space_db,
    'SELECT id FROM follows WHERE follower_id = ? AND following_id = ?',
    [user.sub, targetId]
  )
  if (existing) return c.json({ error: '已关注' }, 409)

  await run(
    c.env.abdl_space_db,
    'INSERT INTO follows (follower_id, following_id) VALUES (?, ?)',
    [user.sub, targetId]
  )

  // 创建通知
  const sender = await queryOne<{ username: string }>(
    c.env.abdl_space_db,
    'SELECT username FROM users WHERE id = ?',
    [user.sub]
  )
  await run(
    c.env.abdl_space_db,
    'INSERT INTO notifications (user_id, type, message, related_id) VALUES (?, ?, ?, ?)',
    [targetId, 'follow', `${sender?.username || '用户'} 关注了你`, user.sub]
  )

  // 检查是否互相关注（成为好友）
  const mutual = await queryOne<{ id: number }>(
    c.env.abdl_space_db,
    'SELECT id FROM follows WHERE follower_id = ? AND following_id = ?',
    [targetId, user.sub]
  )

  return c.json({ message: '已关注', mutual: !!mutual })
})

/**
 * DELETE /api/follows/:userId — 取消关注
 */
follows.delete('/:userId', authMiddleware, async (c) => {
  const user = c.get('user')
  const targetId = parseInt(c.req.param('userId'))

  await run(
    c.env.abdl_space_db,
    'DELETE FROM follows WHERE follower_id = ? AND following_id = ?',
    [user.sub, targetId]
  )

  return c.json({ message: '已取消关注' })
})

/**
 * GET /api/follows/:userId/status — 关注状态
 */
follows.get('/:userId/status', authMiddleware, async (c) => {
  const user = c.get('user')
  const targetId = parseInt(c.req.param('userId'))

  const following = await queryOne<{ id: number }>(
    c.env.abdl_space_db,
    'SELECT id FROM follows WHERE follower_id = ? AND following_id = ?',
    [user.sub, targetId]
  )

  const follower = await queryOne<{ id: number }>(
    c.env.abdl_space_db,
    'SELECT id FROM follows WHERE follower_id = ? AND following_id = ?',
    [targetId, user.sub]
  )

  return c.json({
    following: !!following,
    follower: !!follower,
    mutual: !!following && !!follower,
  })
})

/**
 * GET /api/follows/:userId/followers — 粉丝列表
 */
follows.get('/:userId/followers', async (c) => {
  const targetId = parseInt(c.req.param('userId'))
  const page = Math.max(1, parseInt(c.req.query('page') || '1'))
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20')))
  const offset = (page - 1) * limit

  const rows = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT u.id, u.username, u.avatar, u.role
     FROM follows f
     JOIN users u ON f.follower_id = u.id
     WHERE f.following_id = ?
     ORDER BY f.created_at DESC
     LIMIT ? OFFSET ?`,
    [targetId, limit, offset]
  )

  const count = await queryOne<{ count: number }>(
    c.env.abdl_space_db,
    'SELECT COUNT(*) as count FROM follows WHERE following_id = ?',
    [targetId]
  )

  return c.json({ users: rows.map(r => ({ ...r, avatar: r.avatar ?? DEFAULT_AVATAR })), total: count?.count ?? 0 })
})

/**
 * GET /api/follows/:userId/following — 关注列表
 */
follows.get('/:userId/following', async (c) => {
  const targetId = parseInt(c.req.param('userId'))
  const page = Math.max(1, parseInt(c.req.query('page') || '1'))
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20')))
  const offset = (page - 1) * limit

  const rows = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT u.id, u.username, u.avatar, u.role
     FROM follows f
     JOIN users u ON f.following_id = u.id
     WHERE f.follower_id = ?
     ORDER BY f.created_at DESC
     LIMIT ? OFFSET ?`,
    [targetId, limit, offset]
  )

  const count = await queryOne<{ count: number }>(
    c.env.abdl_space_db,
    'SELECT COUNT(*) as count FROM follows WHERE follower_id = ?',
    [targetId]
  )

  return c.json({ users: rows.map(r => ({ ...r, avatar: r.avatar ?? DEFAULT_AVATAR })), total: count?.count ?? 0 })
})

export default follows
