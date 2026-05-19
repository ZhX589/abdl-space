import { Hono } from 'hono'
import type { Env, JWTPayload, CreatePostRequest } from '../types/index.ts'
import { query, queryOne, run } from '../lib/db.ts'
import { authMiddleware } from '../middleware/auth.ts'

const IMGBED_URL = 'https://img.abdl-space.top'

/** 从图床删除图片 */
async function deleteImageFromImgbed(env: Env, imageUrl: string) {
  const deleteKey = env.IMGBED_DELETE_KEY
  if (!deleteKey) return
  let fileName = imageUrl
  try {
    const parsed = new URL(imageUrl)
    fileName = parsed.pathname.replace(/^\/file\//, '')
  } catch {
    fileName = imageUrl.replace(/^\/file\//, '')
  }
  try {
    await fetch(`${IMGBED_URL}/api/manage/delete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${deleteKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ list: [fileName] }),
    })
  } catch {}
}


// 安全查询帖子图片（post_images 表可能不存在）
async function safeGetImages(db: D1Database, postId: number): Promise<{image_url: string}[]> {
  try {
    const result = await db.prepare('SELECT image_url FROM post_images WHERE post_id = ? ORDER BY sort_order').bind(postId).all();
    return (result.results || []) as {image_url: string}[];
  } catch {
    return [];
  }
}

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
    `SELECT p.id, p.user_id, p.content, p.diaper_id, p.pinned, p.repost_id, p.created_at,
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

    // 获取帖子图片
    const images = await safeGetImages(c.env.abdl_space_db, r.id)

    // 获取转发的原帖数据
    let repost: Record<string, unknown> | null = null
    if (r.repost_id) {
      const origPost = await queryOne<Record<string, unknown>>(
        c.env.abdl_space_db,
        `SELECT p.id, p.user_id, p.content, p.created_at, u.username, u.avatar, u.role
         FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?`,
        [r.repost_id]
      )
      if (origPost) {
        const origImages = await safeGetImages(c.env.abdl_space_db, r.repost_id)
        repost = {
          id: origPost.id,
          user: { id: origPost.user_id, username: origPost.username, avatar: origPost.avatar ?? null, role: origPost.role },
          content: origPost.content,
          images: origImages.map(img => ({ image_url: img.image_url })),
          created_at: origPost.created_at
        }
      }
    }

    return {
      id: r.id,
      user: { id: r.user_id, username: r.username, avatar: r.avatar ?? null, role: r.role },
      content: r.content,
      diaper_id: r.diaper_id ?? null,
      pinned: !!r.pinned,
      repost_id: r.repost_id ?? null,
      repost,
      like_count: r.like_count,
      has_liked: hasLiked,
      comment_count: r.comment_count,
      images: images.map(img => ({ image_url: img.image_url })),
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

  // 获取帖子图片
  const postImages = await safeGetImages(c.env.abdl_space_db, postId)

  // 获取转发的原帖数据
  let repost: Record<string, unknown> | null = null
  if (post.repost_id) {
    const origPost = await queryOne<Record<string, unknown>>(
      c.env.abdl_space_db,
      `SELECT p.id, p.user_id, p.content, p.created_at, u.username, u.avatar, u.role
       FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?`,
      [post.repost_id]
    )
    if (origPost) {
      const origImages = await safeGetImages(c.env.abdl_space_db, post.repost_id)
      repost = {
        id: origPost.id,
        user: { id: origPost.user_id, username: origPost.username, avatar: origPost.avatar ?? null, role: origPost.role },
        content: origPost.content,
        images: origImages.map(img => ({ image_url: img.image_url })),
        created_at: origPost.created_at
      }
    }
  }

  return c.json({
    post: {
      id: post.id,
      user: { id: post.user_id, username: post.username, avatar: post.avatar ?? null, role: post.role },
      content: post.content,
      diaper_id: post.diaper_id ?? null,
      pinned: !!post.pinned,
      repost_id: post.repost_id ?? null,
      repost,
      like_count: post.like_count,
      has_liked: hasLiked,
      comment_count: post.comment_count,
      images: postImages.map(img => ({ image_url: img.image_url })),
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
  const { content, diaper_id, images, repost_id } = body

  if (!content || !content.trim() || content.length > 5000) {
    return c.json({ error: 'Content must be 1-5000 characters' }, 400)
  }

  // 验证 repost_id 存在
  if (repost_id) {
    const origPost = await queryOne<{ id: number }>(
      c.env.abdl_space_db,
      'SELECT id FROM posts WHERE id = ?',
      [repost_id]
    )
    if (!origPost) return c.json({ error: 'Repost target not found' }, 404)
  }

  const result = await run(
    c.env.abdl_space_db,
    'INSERT INTO posts (user_id, content, diaper_id, repost_id) VALUES (?, ?, ?, ?)',
    [user.sub, content.trim(), diaper_id ?? null, repost_id ?? null]
  )

  const postId = result.meta.last_row_id

  // 保存图片
  if (images && images.length > 0) {
    for (let i = 0; i < images.length; i++) {
      await run(
        c.env.abdl_space_db,
        'INSERT INTO post_images (post_id, image_url, sort_order) VALUES (?, ?, ?)',
        [postId, images[i], i]
      )
    }
  }

  // 如果是转发，给原帖作者发通知
  if (repost_id) {
    const origPost = await queryOne<{ user_id: number }>(
      c.env.abdl_space_db,
      'SELECT user_id FROM posts WHERE id = ?',
      [repost_id]
    )
    if (origPost && origPost.user_id !== user.sub) {
      await run(
        c.env.abdl_space_db,
        'INSERT INTO notifications (user_id, type, message, related_id) VALUES (?, ?, ?, ?)',
        [origPost.user_id, 'repost', `${user.username} 转发了你的帖子`, repost_id]
      )
    }
  }

  return c.json({ id: postId, message: '发布成功' }, 201)
})

/**
 * DELETE /api/posts/:id — 删除帖子
 */
posts.delete('/:id', authMiddleware, async (c) => {
  const user = c.get('user')
  const id = parseInt(c.req.param('id') || '')

  const post = await queryOne<{ id: number; user_id: number }>(
    c.env.abdl_space_db, 'SELECT id, user_id FROM posts WHERE id = ?', [id]
  )
  if (!post) return c.json({ error: 'Post not found' }, 404)
  if (user.role !== 'admin' && post.user_id !== user.sub) {
    return c.json({ error: 'Not authorized' }, 403)
  }

  // 删除图床图片
  const postImages = await query<{ image_url: string }>(
    c.env.abdl_space_db, 'SELECT image_url FROM post_images WHERE post_id = ?', [id]
  )
  for (const img of postImages) {
    await deleteImageFromImgbed(c.env, img.image_url)
  }

  await run(c.env.abdl_space_db, 'DELETE FROM posts WHERE id = ?', [id])
  return c.json({ message: '已删除' })
})

/**
 * PATCH /api/posts/:id — 编辑帖子
 */
posts.patch('/:id', authMiddleware, async (c) => {
  const user = c.get('user')
  const id = parseInt(c.req.param('id') || '')
  const body = await c.req.json<{ content: string }>()

  const post = await queryOne<{ id: number; user_id: number }>(
    c.env.abdl_space_db, 'SELECT id, user_id FROM posts WHERE id = ?', [id]
  )
  if (!post) return c.json({ error: 'Post not found' }, 404)
  if (user.role !== 'admin' && post.user_id !== user.sub) {
    return c.json({ error: 'Not authorized' }, 403)
  }

  if (!body.content || !body.content.trim() || body.content.length > 5000) {
    return c.json({ error: 'Content must be 1-5000 characters' }, 400)
  }

  await run(
    c.env.abdl_space_db,
    'UPDATE posts SET content = ? WHERE id = ?',
    [body.content.trim(), id]
  )

  return c.json({ message: '已修改' })
})

/**
 * POST /api/posts/:id/comments — 发表评论
 */
posts.post('/:id/comments', authMiddleware, async (c) => {
  const user = c.get('user')
  const postId = parseInt(c.req.param('id') || '')

  const post = await queryOne<{ id: number; user_id: number }>(
    c.env.abdl_space_db, 'SELECT id, user_id FROM posts WHERE id = ?', [postId]
  )
  if (!post) return c.json({ error: 'Post not found' }, 404)

  const body = await c.req.json<{ content: string; parent_id?: number; images?: string[] }>()
  const { content, parent_id, images } = body

  if (!content || !content.trim() || content.length > 2000) {
    return c.json({ error: 'Content must be 1-2000 characters' }, 400)
  }

  if (parent_id) {
    const parent = await queryOne<{ id: number; user_id: number }>(
      c.env.abdl_space_db, 'SELECT id, user_id FROM post_comments WHERE id = ? AND post_id = ?', [parent_id, postId]
    )
    if (!parent) return c.json({ error: 'Parent comment not found' }, 400)
  }

  const result = await run(
    c.env.abdl_space_db,
    'INSERT INTO post_comments (post_id, user_id, parent_id, content) VALUES (?, ?, ?, ?)',
    [postId, user.sub, parent_id ?? null, content.trim()]
  )

  const commentId = result.meta.last_row_id

  // 保存评论图片
  if (images && images.length > 0) {
    for (let i = 0; i < images.length; i++) {
      await run(
        c.env.abdl_space_db,
        'INSERT INTO post_images (post_id, image_url, sort_order) VALUES (?, ?, ?)',
        [commentId, images[i], i]
      )
    }
  }

  // 给帖子作者发通知（不给自己发）
  if (post.user_id !== user.sub) {
    await run(
      c.env.abdl_space_db,
      'INSERT INTO notifications (user_id, type, message, related_id) VALUES (?, ?, ?, ?)',
      [post.user_id, 'comment', `${user.username} 评论了你的帖子`, postId]
    )
  }

  // 如果是回复评论，给被回复者发通知
  if (parent_id) {
    const parentComment = await queryOne<{ user_id: number }>(
      c.env.abdl_space_db,
      'SELECT user_id FROM post_comments WHERE id = ?',
      [parent_id]
    )
    if (parentComment && parentComment.user_id !== user.sub && parentComment.user_id !== post.user_id) {
      await run(
        c.env.abdl_space_db,
        'INSERT INTO notifications (user_id, type, message, related_id) VALUES (?, ?, ?, ?)',
        [parentComment.user_id, 'reply', `${user.username} 回复了你的评论`, postId]
      )
    }
  }

  return c.json({ message: '评论成功', id: commentId }, 201)
})

export default posts
