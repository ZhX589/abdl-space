import { Hono } from 'hono'
import type { Env, JWTPayload, CreatePostRequest } from '../types/index.ts'
import { query, queryOne, run } from '../lib/db.ts'
import { authMiddleware } from '../middleware/auth.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const posts = new Hono<AppType>()

/**
 * GET /api/posts — 帖子列表
 */
posts.get('/', async (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') || '1'))
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20')))
  const search = c.req.query('search') || ''

  let userId: number | null = null
  const authHeader = c.req.header('Authorization')
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const { verifyJWT } = await import('../lib/auth.ts')
    const payload = await verifyJWT(authHeader.slice(7), c.env.JWT_SECRET)
    if (payload) userId = payload.sub
  }

  const conditions: string[] = []
  const params: unknown[] = []

  if (search) {
    conditions.push('p.content LIKE ?')
    params.push(`%${search}%`)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const countResult = await query<{ total: number }>(
    c.env.abdl_space_db,
    `SELECT COUNT(*) as total FROM posts p ${whereClause}`,
    params
  )

  const offset = (page - 1) * limit
  const rows = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT p.id, p.user_id, p.content, p.diaper_id, p.pinned, p.created_at,
            u.username, u.avatar, u.role,
            (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comment_count,
            (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count
     FROM posts p
     JOIN users u ON p.user_id = u.id
     ${whereClause}
     ORDER BY p.pinned DESC, p.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  )

  const postsList = await Promise.all(rows.map(async (r) => {
    let hasLiked = false
    if (userId) {
      const liked = await queryOne<{ count: number }>(
        c.env.abdl_space_db,
        "SELECT COUNT(*) as count FROM likes WHERE user_id = ? AND target_type = 'post' AND target_id = ?",
        [userId, r.id]
      )
      hasLiked = (liked?.count ?? 0) > 0
    }

    return {
      id: r.id,
      user: { id: r.user_id, username: r.username, avatar: r.avatar ?? null, role: r.role },
      content: r.content,
      diaper_id: r.diaper_id ?? null,
      pinned: !!r.pinned,
      like_count: r.like_count,
      has_liked: hasLiked,
      comment_count: r.comment_count,
      created_at: r.created_at
    }
  }))

  return c.json({
    posts: postsList,
    pagination: {
      page, limit,
      total: countResult[0].total,
      totalPages: Math.ceil(countResult[0].total / limit)
    }
  })
})

/**
 * GET /api/posts/:id — 帖子详情 + 评论
 */
posts.get('/:id', async (c) => {
  const postId = parseInt(c.req.param('id'))

  let userId: number | null = null
  const authHeader = c.req.header('Authorization')
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const { verifyJWT } = await import('../lib/auth.ts')
    const payload = await verifyJWT(authHeader.slice(7), c.env.JWT_SECRET)
    if (payload) userId = payload.sub
  }

  const post = await queryOne<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT p.*, u.username, u.avatar, u.role,
            (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comment_count,
            (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count
     FROM posts p JOIN users u ON p.user_id = u.id
     WHERE p.id = ?`,
    [postId]
  )
  if (!post) return c.json({ error: 'Post not found' }, 404)

  let hasLiked = false
  if (userId) {
    const liked = await queryOne<{ count: number }>(
      c.env.abdl_space_db,
      "SELECT COUNT(*) as count FROM likes WHERE user_id = ? AND target_type = 'post' AND target_id = ?",
      [userId, postId]
    )
    hasLiked = (liked?.count ?? 0) > 0
  }

  const comments = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT pc.*, u.username, u.avatar, u.role
     FROM post_comments pc JOIN users u ON pc.user_id = u.id
     WHERE pc.post_id = ?
     ORDER BY pc.created_at ASC`,
    [postId]
  )

  const commentsWithLikes = await Promise.all(comments.map(async (cmt) => {
    let cmtHasLiked = false
    if (userId) {
      const liked = await queryOne<{ count: number }>(
        c.env.abdl_space_db,
        "SELECT COUNT(*) as count FROM likes WHERE user_id = ? AND target_type = 'comment' AND target_id = ?",
        [userId, cmt.id]
      )
      cmtHasLiked = (liked?.count ?? 0) > 0
    }

    const likeCount = await queryOne<{ count: number }>(
      c.env.abdl_space_db,
      "SELECT COUNT(*) as count FROM likes WHERE target_type = 'comment' AND target_id = ?",
      [cmt.id]
    )

    return {
      id: cmt.id,
      post_id: cmt.post_id,
      user: { id: cmt.user_id, username: cmt.username, avatar: cmt.avatar ?? null, role: cmt.role },
      parent_id: cmt.parent_id ?? null,
      content: cmt.content,
      like_count: likeCount?.count ?? 0,
      has_liked: cmtHasLiked,
      created_at: cmt.created_at
    }
  }))

  return c.json({
    post: {
      id: post.id,
      user: { id: post.user_id, username: post.username, avatar: post.avatar ?? null, role: post.role },
      content: post.content,
      diaper_id: post.diaper_id ?? null,
      pinned: !!post.pinned,
      like_count: post.like_count,
      has_liked: hasLiked,
      comment_count: post.comment_count,
      created_at: post.created_at
    },
    comments: commentsWithLikes
  })
})

/**
 * POST /api/posts — 创建帖子
 */
posts.post('/', authMiddleware, async (c) => {
  const user = c.get('user')
  const body = await c.req.json<CreatePostRequest>()
  const { content, diaper_id } = body

  if (!content || !content.trim() || content.length > 5000) {
    return c.json({ error: 'Content must be 1-5000 characters' }, 400)
  }

  const result = await run(
    c.env.abdl_space_db,
    'INSERT INTO posts (user_id, content, diaper_id) VALUES (?, ?, ?)',
    [user.sub, content.trim(), diaper_id ?? null]
  )

  return c.json({ id: result.meta.last_row_id, message: '发布成功' }, 201)
})

/**
 * DELETE /api/posts/:id — 删除帖子
 */
posts.delete('/:id', authMiddleware, async (c) => {
  const user = c.get('user')
  const id = parseInt(c.req.param('id'))

  const post = await queryOne<{ id: number; user_id: number }>(
    c.env.abdl_space_db, 'SELECT id, user_id FROM posts WHERE id = ?', [id]
  )
  if (!post) return c.json({ error: 'Post not found' }, 404)
  if (user.role !== 'admin' && post.user_id !== user.sub) {
    return c.json({ error: 'Not authorized' }, 403)
  }

  await run(c.env.abdl_space_db, 'DELETE FROM posts WHERE id = ?', [id])
  return c.json({ message: '已删除' })
})

/**
 * POST /api/posts/:id/comments — 发表评论
 */
posts.post('/:id/comments', authMiddleware, async (c) => {
  const user = c.get('user')
  const postId = parseInt(c.req.param('id'))

  const post = await queryOne<{ id: number }>(
    c.env.abdl_space_db, 'SELECT id FROM posts WHERE id = ?', [postId]
  )
  if (!post) return c.json({ error: 'Post not found' }, 404)

  const body = await c.req.json<{ content: string; parent_id?: number }>()
  const { content, parent_id } = body

  if (!content || !content.trim() || content.length > 2000) {
    return c.json({ error: 'Content must be 1-2000 characters' }, 400)
  }

  if (parent_id) {
    const parent = await queryOne<{ id: number }>(
      c.env.abdl_space_db, 'SELECT id FROM post_comments WHERE id = ? AND post_id = ?', [parent_id, postId]
    )
    if (!parent) return c.json({ error: 'Parent comment not found' }, 400)
  }

  const result = await run(
    c.env.abdl_space_db,
    'INSERT INTO post_comments (post_id, user_id, parent_id, content) VALUES (?, ?, ?, ?)',
    [postId, user.sub, parent_id ?? null, content.trim()]
  )

  return c.json({ message: '评论成功', id: result.meta.last_row_id }, 201)
})

export default posts
