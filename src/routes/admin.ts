import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { query, queryOne, run } from '../lib/db.ts'
import { adminMiddleware } from '../middleware/auth.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const admin = new Hono<AppType>()

/**
 * GET /api/admin/stats — 站点统计
 */
admin.get('/stats', adminMiddleware, async (c) => {
  const [users, posts, comments, diapers, ratings] = await Promise.all([
    queryOne<{ count: number }>(c.env.abdl_space_db, 'SELECT COUNT(*) as count FROM users'),
    queryOne<{ count: number }>(c.env.abdl_space_db, 'SELECT COUNT(*) as count FROM posts'),
    queryOne<{ count: number }>(c.env.abdl_space_db, 'SELECT COUNT(*) as count FROM post_comments'),
    queryOne<{ count: number }>(c.env.abdl_space_db, 'SELECT COUNT(*) as count FROM diapers'),
    queryOne<{ count: number }>(c.env.abdl_space_db, 'SELECT COUNT(*) as count FROM ratings'),
  ])

  return c.json({
    users: users?.count ?? 0,
    posts: posts?.count ?? 0,
    comments: comments?.count ?? 0,
    diapers: diapers?.count ?? 0,
    ratings: ratings?.count ?? 0
  })
})

/**
 * GET /api/admin/users — 用户列表
 */
admin.get('/users', adminMiddleware, async (c) => {
  const rows = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    'SELECT id, email, username, role, avatar, email_verified, created_at FROM users ORDER BY id'
  )

  return c.json({
    users: rows.map(r => ({
      id: r.id,
      email: r.email,
      username: r.username,
      role: r.role,
      avatar: r.avatar ?? null,
      email_verified: r.email_verified,
      created_at: r.created_at
    }))
  })
})

/**
 * DELETE /api/admin/users/:id — 删除用户
 */
admin.delete('/users/:id', adminMiddleware, async (c) => {
  const id = parseInt(c.req.param('id') || '')

  const user = await queryOne<{ id: number }>(c.env.abdl_space_db, 'SELECT id FROM users WHERE id = ?', [id])
  if (!user) return c.json({ error: 'User not found' }, 404)

  await run(c.env.abdl_space_db, 'DELETE FROM users WHERE id = ?', [id])
  return c.json({ message: '已删除' })
})

/**
 * POST /api/admin/users/:id/ban — 封禁/解封（toggle，需 users 表有 banned 字段）
 */
admin.post('/users/:id/ban', adminMiddleware, async (c) => {
  return c.json({ error: 'Ban function not yet implemented' }, 501)
})

/**
 * POST /api/admin/posts/:id/pin — 置顶/取消置顶
 */
admin.post('/posts/:id/pin', adminMiddleware, async (c) => {
  const id = parseInt(c.req.param('id') || '')

  const post = await queryOne<{ id: number; pinned: number }>(
    c.env.abdl_space_db, 'SELECT id, pinned FROM posts WHERE id = ?', [id]
  )
  if (!post) return c.json({ error: 'Post not found' }, 404)

  const newPinned = post.pinned ? 0 : 1
  await run(c.env.abdl_space_db, 'UPDATE posts SET pinned = ? WHERE id = ?', [newPinned, id])

  return c.json({ pinned: !!newPinned })
})

/**
 * DELETE /api/admin/posts/:id — 删除帖子
 */
admin.delete('/posts/:id', adminMiddleware, async (c) => {
  const id = parseInt(c.req.param('id') || '')

  const post = await queryOne<{ id: number }>(c.env.abdl_space_db, 'SELECT id FROM posts WHERE id = ?', [id])
  if (!post) return c.json({ error: 'Post not found' }, 404)

  await run(c.env.abdl_space_db, 'DELETE FROM posts WHERE id = ?', [id])
  return c.json({ message: '已删除' })
})

/**
 * DELETE /api/admin/comments/:id — 删除评论
 */
admin.delete('/comments/:id', adminMiddleware, async (c) => {
  const id = parseInt(c.req.param('id') || '')

  const comment = await queryOne<{ id: number }>(c.env.abdl_space_db, 'SELECT id FROM post_comments WHERE id = ?', [id])
  if (!comment) return c.json({ error: 'Comment not found' }, 404)

  await run(c.env.abdl_space_db, 'DELETE FROM post_comments WHERE id = ?', [id])
  return c.json({ message: '已删除' })
})

/**
 * DELETE /api/admin/diapers/:id — 删除纸尿裤
 */
admin.delete('/diapers/:id', adminMiddleware, async (c) => {
  const id = parseInt(c.req.param('id') || '')

  const diaper = await queryOne<{ id: number }>(c.env.abdl_space_db, 'SELECT id FROM diapers WHERE id = ?', [id])
  if (!diaper) return c.json({ error: 'Diaper not found' }, 404)

  await run(c.env.abdl_space_db, 'DELETE FROM diapers WHERE id = ?', [id])
  return c.json({ message: '已删除' })
})

export default admin
