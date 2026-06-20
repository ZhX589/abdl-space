import { Hono } from 'hono'
const DEFAULT_AVATAR = 'https://img.abdl-space.top/file/system/1781439303787_play_store_512.png'
import type { Env, JWTPayload, CreatePostRequest } from '../types/index.ts'
import { query, queryOne, run } from '../lib/db.ts'
import { authMiddleware } from '../middleware/auth.ts'
import { rateLimit } from '../lib/rate-limit.ts'

const IMGBED_URL = 'https://img.abdl-space.top'

/** 从图床删除图片 */
async function deleteImageFromImgbed(env: Env, imageUrl: string) {
  const deleteKey = env.IMGBED_DELETE_KEY
  if (!deleteKey) return
  let src = imageUrl
  try {
    const parsed = new URL(imageUrl)
    src = parsed.pathname // 保留 /file/ 前缀
  } catch {
    // 如果不是完整 URL，确保有 /file/ 前缀
    if (!imageUrl.startsWith('/file/')) src = `/file/${imageUrl}`
  }
  try {
    await fetch(`${IMGBED_URL}/api/manage/delete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${deleteKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ src }),
    })
  } catch {}
}


// 安全查询帖子图片（post_images 表可能不存在）
async function safeGetCommentImages(db: D1Database, commentId: number): Promise<{image_url: string; is_nsfw: number}[]> {
  try {
    const result = await db.prepare(
      'SELECT image_url, is_nsfw FROM comment_images WHERE comment_id = ? ORDER BY sort_order'
    ).bind(commentId).all();
    return result.results as { image_url: string; is_nsfw: number }[];
  } catch {
    return [];
  }
}

async function safeGetImages(db: D1Database, postId: number): Promise<{image_url: string; is_nsfw: number}[]> {
  try {
    const result = await db.prepare('SELECT image_url, is_nsfw FROM post_images WHERE post_id = ? ORDER BY sort_order').bind(postId).all();
    return (result.results || []) as {image_url: string; is_nsfw: number}[];
  } catch {
    return [];
  }
}

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const posts = new Hono<AppType>()

// 公共 API 限速：每 IP 每分钟 60 次
posts.use('*', rateLimit('posts', 60_000, 60))

/**
 * GET /api/posts — 帖子列表
 */
posts.get('/', async (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') || '1'))
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20')))
  const search = c.req.query('search') || ''
  const filter = c.req.query('filter') || '' // 'following' | 'announcements' | ''

  let userId: number | null = null
  // 支持 Bearer token（OAuth/外部 API 调用）
  const authHeader = c.req.header('Authorization')
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const { verifyJWT } = await import('../lib/auth.ts')
      const payload = await verifyJWT(authHeader.slice(7), c.env.JWT_SECRET)
      if (payload) userId = payload.sub
    } catch { /* invalid token, continue */ }
  }
  // 支持 Cookie（前端 SPA 使用 credentials: 'include'）
  if (!userId) {
    const cookieHeader = c.req.header('Cookie')
    if (cookieHeader) {
      const m = cookieHeader.match(/(?:^|;\s*)token=([^;]+)/)
      if (m) {
        try {
          const { verifyJWT } = await import('../lib/auth.ts')
          const payload = await verifyJWT(m[1], c.env.JWT_SECRET)
          if (payload) userId = payload.sub
        } catch { /* invalid token, continue */ }
      }
    }
  }

  const conditions: string[] = []
  const params: unknown[] = []

  // filter=following: 只看关注的人的帖子
  if (filter === 'following') {
    if (!userId) return c.json({ error: '请先登录' }, 401)
    conditions.push('p.user_id IN (SELECT following_id FROM follows WHERE follower_id = ?)')
    params.push(userId)
  }

  // filter=announcements: 只看公告
  if (filter === 'announcements') {
    conditions.push('p.is_announcement = 1')
  }

  if (search) {
    conditions.push("p.content LIKE ? ESCAPE '\\'")
    const escapedSearch = search.replace(/%/g, '\%').replace(/_/g, '\_')
    params.push(`%${escapedSearch}%`)
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
    `SELECT p.id, p.user_id, p.content, p.diaper_id, p.pinned, p.is_announcement, p.repost_id, p.created_at,
            u.username, u.avatar, u.role, u.is_beta_user,
            (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comment_count,
            (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count
     FROM posts p
     JOIN users u ON p.user_id = u.id
     ${whereClause}
     ORDER BY p.is_announcement DESC, p.pinned DESC, p.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  )

  // Batch query: likes, images, reposts (avoids N+1)
  const postIds = rows.map(r => r.id as number)
  const repostIds = rows.map(r => r.repost_id).filter(Boolean) as number[]

  // Batch: user's likes for all posts
  let likedSet = new Set<number>()
  if (userId && postIds.length > 0) {
    const placeholders = postIds.map(() => '?').join(',')
    const likedRows = await query<{ target_id: number }>(
      c.env.abdl_space_db,
      `SELECT target_id FROM likes WHERE user_id = ? AND target_type = 'post' AND target_id IN (${placeholders})`,
      [userId, ...postIds]
    )
    likedSet = new Set(likedRows.map(r => r.target_id))
  }

  // Batch: all images for posts
  const allImages = postIds.length > 0
    ? await query<{ post_id: number; image_url: string; is_nsfw: number }>(
        c.env.abdl_space_db,
        `SELECT post_id, image_url, is_nsfw FROM post_images WHERE post_id IN (${postIds.map(() => '?').join(',')}) ORDER BY sort_order`,
        postIds
      )
    : []
  const imagesMap = new Map<number, { image_url: string; is_nsfw: number }[]>()
  for (const img of allImages) {
    if (!imagesMap.has(img.post_id)) imagesMap.set(img.post_id, [])
    imagesMap.get(img.post_id)!.push({ image_url: img.image_url, is_nsfw: img.is_nsfw })
  }

  // Batch: repost data + repost images
  const repostMap = new Map<number, Record<string, unknown>>()
  if (repostIds.length > 0) {
    const repostRows = await query<Record<string, unknown>>(
      c.env.abdl_space_db,
      `SELECT p.id, p.user_id, p.content, p.created_at, u.username, u.avatar, u.role
       FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id IN (${repostIds.map(() => '?').join(',')})`,
      repostIds
    )
    const repostImages = await query<{ post_id: number; image_url: string; is_nsfw: number }>(
      c.env.abdl_space_db,
      `SELECT post_id, image_url, is_nsfw FROM post_images WHERE post_id IN (${repostIds.map(() => '?').join(',')}) ORDER BY sort_order`,
      repostIds
    )
    const repostImagesMap = new Map<number, { image_url: string; is_nsfw: number }[]>()
    for (const img of repostImages) {
      if (!repostImagesMap.has(img.post_id)) repostImagesMap.set(img.post_id, [])
      repostImagesMap.get(img.post_id)!.push({ image_url: img.image_url, is_nsfw: img.is_nsfw })
    }
    for (const orig of repostRows) {
      repostMap.set(orig.id as number, {
        id: orig.id,
        user: { id: orig.user_id, username: orig.username, avatar: orig.avatar ?? DEFAULT_AVATAR, role: orig.role, is_beta_user: !!orig.is_beta_user },
        content: orig.content,
        images: (repostImagesMap.get(orig.id as number) || []).map(img => ({ image_url: img.image_url, is_nsfw: !!img.is_nsfw })),
        created_at: orig.created_at
      })
    }
  }

  const postsList = rows.map(r => ({
    id: r.id,
    user: { id: r.user_id, username: r.username, avatar: r.avatar ?? DEFAULT_AVATAR, role: r.role, is_beta_user: !!r.is_beta_user },
    content: r.content,
    diaper_id: r.diaper_id ?? null,
    pinned: !!r.pinned,
    is_announcement: !!r.is_announcement,
    repost_id: r.repost_id ?? null,
    repost: r.repost_id ? repostMap.get(r.repost_id as number) ?? null : null,
    like_count: r.like_count,
    has_liked: likedSet.has(r.id as number),
    comment_count: r.comment_count,
    images: (imagesMap.get(r.id as number) || []).map(img => ({ image_url: img.image_url, is_nsfw: !!img.is_nsfw })),
    created_at: r.created_at
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
 * GET /api/posts/announcements/latest — 最新公告
 */
posts.get('/announcements/latest', async (c) => {
  const post = await queryOne<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT p.id, p.user_id, p.content, p.created_at,
            u.username, u.avatar, u.role
     FROM posts p
     JOIN users u ON p.user_id = u.id
     WHERE p.is_announcement = 1
     ORDER BY p.created_at DESC
     LIMIT 1`
  )
  if (!post) return c.json({ announcement: null })

  const images = await safeGetImages(c.env, post.id as number)
  return c.json({
    announcement: {
      id: post.id,
      user: { id: post.user_id, username: post.username, avatar: post.avatar ?? DEFAULT_AVATAR, role: post.role },
      content: post.content,
      images: images.map(img => ({ image_url: img.image_url, is_nsfw: !!img.is_nsfw })),
      created_at: post.created_at
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
    try {
      const { verifyJWT } = await import('../lib/auth.ts')
      const payload = await verifyJWT(authHeader.slice(7), c.env.JWT_SECRET)
      if (payload) userId = payload.sub
    } catch { /* invalid token, continue */ }
  }
  if (!userId) {
    const cookieHeader = c.req.header('Cookie')
    if (cookieHeader) {
      const m = cookieHeader.match(/(?:^|;\s*)token=([^;]+)/)
      if (m) {
        try {
          const { verifyJWT } = await import('../lib/auth.ts')
          const payload = await verifyJWT(m[1], c.env.JWT_SECRET)
          if (payload) userId = payload.sub
        } catch { /* invalid token, continue */ }
      }
    }
  }

  const post = await queryOne<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT p.*, u.username, u.avatar, u.role, u.is_beta_user,
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
    `SELECT pc.*, u.username, u.avatar, u.role, u.is_beta_user
     FROM post_comments pc JOIN users u ON pc.user_id = u.id
     WHERE pc.post_id = ?
     ORDER BY pc.created_at ASC`,
    [postId]
  )

  // Batch query comment likes and images (BUG-006 fix: avoid N+1)
  const commentIds = comments.map(cmt => cmt.id as number)

  let cmtLikedSet = new Set<number>()
  if (userId && commentIds.length > 0) {
    const likedRows = await query<{ target_id: number }>(
      c.env.abdl_space_db,
      `SELECT target_id FROM likes WHERE user_id = ? AND target_type = 'comment' AND target_id IN (${commentIds.map(() => '?').join(',')})`,
      [userId, ...commentIds]
    )
    cmtLikedSet = new Set(likedRows.map(r => r.target_id))
  }

  const cmtLikeCounts = commentIds.length > 0
    ? await query<{ target_id: number; cnt: number }>(
        c.env.abdl_space_db,
        `SELECT target_id, COUNT(*) as cnt FROM likes WHERE target_type = 'comment' AND target_id IN (${commentIds.map(() => '?').join(',')}) GROUP BY target_id`,
        commentIds
      )
    : []
  const cmtLikeMap = new Map(cmtLikeCounts.map(r => [r.target_id, r.cnt]))

  const allCmtImages = commentIds.length > 0
    ? await query<{ comment_id: number; image_url: string; is_nsfw: number }>(
        c.env.abdl_space_db,
        `SELECT comment_id, image_url, is_nsfw FROM comment_images WHERE comment_id IN (${commentIds.map(() => '?').join(',')}) ORDER BY sort_order`,
        commentIds
      )
    : []
  const cmtImagesMap = new Map<number, { image_url: string; is_nsfw: number }[]>()
  for (const img of allCmtImages) {
    if (!cmtImagesMap.has(img.comment_id)) cmtImagesMap.set(img.comment_id, [])
    cmtImagesMap.get(img.comment_id)!.push({ image_url: img.image_url, is_nsfw: img.is_nsfw })
  }

  const commentsWithLikes = comments.map(cmt => ({
    id: cmt.id,
    post_id: cmt.post_id,
    user: { id: cmt.user_id, username: cmt.username, avatar: cmt.avatar ?? DEFAULT_AVATAR, role: cmt.role, is_beta_user: !!cmt.is_beta_user },
    parent_id: cmt.parent_id ?? null,
    content: cmt.content,
    images: (cmtImagesMap.get(cmt.id as number) || []).map(img => ({ image_url: img.image_url, is_nsfw: !!img.is_nsfw })),
    like_count: cmtLikeMap.get(cmt.id as number) ?? 0,
    has_liked: cmtLikedSet.has(cmt.id as number),
    created_at: cmt.created_at
  }))

  // 获取帖子图片
  const postImages = await safeGetImages(c.env.abdl_space_db, postId)

  // 获取转发的原帖数据
  let repost: Record<string, unknown> | null = null
  if (post.repost_id) {
    const origPost = await queryOne<Record<string, unknown>>(
      c.env.abdl_space_db,
      `SELECT p.id, p.user_id, p.content, p.created_at, u.username, u.avatar, u.role, u.is_beta_user
       FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?`,
      [post.repost_id]
    )
    if (origPost) {
      const origImages = await safeGetImages(c.env.abdl_space_db, post.repost_id)
      repost = {
        id: origPost.id,
        user: { id: origPost.user_id, username: origPost.username, avatar: origPost.avatar ?? DEFAULT_AVATAR, role: origPost.role, is_beta_user: !!origPost.is_beta_user },
        content: origPost.content,
        images: origImages.map(img => ({ image_url: img.image_url, is_nsfw: !!img.is_nsfw })),
        created_at: origPost.created_at
      }
    } else {
      // 原帖已删除，清除 repost_id
      await run(c.env.abdl_space_db, 'UPDATE posts SET repost_id = NULL WHERE id = ?', [postId])
      post.repost_id = null
    }
  }

  return c.json({
    post: {
      id: post.id,
      user: { id: post.user_id, username: post.username, avatar: post.avatar ?? DEFAULT_AVATAR, role: post.role, is_beta_user: !!post.is_beta_user },
      content: post.content,
      diaper_id: post.diaper_id ?? null,
      pinned: !!post.pinned,
      is_announcement: !!post.is_announcement,
      repost_id: post.repost_id ?? null,
      repost,
      like_count: post.like_count,
      has_liked: hasLiked,
      comment_count: post.comment_count,
      images: postImages.map(img => ({ image_url: img.image_url, is_nsfw: !!img.is_nsfw })),
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
  const { content, diaper_id, images, repost_id, is_announcement } = body

  if (!content || !content.trim() || content.length > 5000) {
    return c.json({ error: 'Content must be 1-5000 characters' }, 400)
  }

  // 公告仅管理员可发
  const announceFlag = is_announcement && user.role === 'admin' ? 1 : 0

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
    'INSERT INTO posts (user_id, content, diaper_id, repost_id, is_announcement) VALUES (?, ?, ?, ?, ?)',
    [user.sub, content.trim(), diaper_id ?? null, repost_id ?? null, announceFlag]
  )

  const postId = result.meta.last_row_id

  // 保存图片
  let postHasNsfw = false
  if (images && images.length > 0) {
    for (let i = 0; i < images.length; i++) {
      const img = typeof images[i] === 'string' ? { url: images[i], is_nsfw: false } : images[i]
      if (!img.url) continue
      // BUG-548: Validate image URL format
      try {
        const parsed = new URL(img.url)
        if (!['https:', 'http:'].includes(parsed.protocol)) {
          return c.json({ error: '图片 URL 必须以 http(s) 开头' }, 400)
        }
      } catch {
        return c.json({ error: `无效的图片 URL: ${img.url}` }, 400)
      }
      if (img.is_nsfw) postHasNsfw = true
      await run(
        c.env.abdl_space_db,
        'INSERT INTO post_images (post_id, image_url, is_nsfw, sort_order) VALUES (?, ?, ?, ?)',
        [postId, img.url, img.is_nsfw ? 1 : 0, i]
      )
    }
  }

  // 更新帖子的 has_nsfw 标记
  if (postHasNsfw) {
    await run(c.env.abdl_space_db, 'UPDATE posts SET has_nsfw = 1 WHERE id = ?', [postId])
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
        'INSERT INTO notifications (user_id, type, message, related_id, actor_id) VALUES (?, ?, ?, ?, ?)',
        [origPost.user_id, 'repost', `${user.username} 转发了你的帖子`, repost_id, user.sub]
      )
    }
  }

  // 发帖奖励：经验 +10，积分 +3
  const POST_EXP = 10
  const POST_POINTS = 3

  await c.env.abdl_space_db.batch([
    c.env.abdl_space_db.prepare(
      'UPDATE experience SET current_exp = current_exp + ?, total_exp = total_exp + ? WHERE user_id = ?'
    ).bind(POST_EXP, POST_EXP, user.sub),
    c.env.abdl_space_db.prepare(
      'INSERT INTO exp_logs (user_id, amount, type, source_type, source_id, description) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(user.sub, POST_EXP, 'post', 'post', postId, '发帖'),
    c.env.abdl_space_db.prepare(
      'UPDATE points SET balance = balance + ?, total_earned = total_earned + ? WHERE user_id = ?'
    ).bind(POST_POINTS, POST_POINTS, user.sub),
    c.env.abdl_space_db.prepare(
      'INSERT INTO point_logs (user_id, amount, type, source_type, source_id, description) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(user.sub, POST_POINTS, 'post', 'post', postId, '发帖'),
  ])

  return c.json({ id: postId, message: '发布成功', rewards: { total_exp: POST_EXP, total_points: POST_POINTS } }, 201)
})

/**
 * DELETE /api/posts/:id — 删除帖子（含扣回）
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

  // 查询该帖子获得的经验/积分（含收到的点赞奖励）
  const expLogs = await query<{ amount: number }>(
    c.env.abdl_space_db,
    "SELECT amount FROM exp_logs WHERE user_id = ? AND source_type = 'post' AND source_id = ?",
    [post.user_id, id]
  )
  const pointLogs = await query<{ amount: number }>(
    c.env.abdl_space_db,
    "SELECT amount FROM point_logs WHERE user_id = ? AND source_type = 'post' AND source_id = ?",
    [post.user_id, id]
  )

  const totalExpDeduct = expLogs.reduce((sum, log) => sum + Math.abs(log.amount), 0)
  const totalPointDeduct = pointLogs.reduce((sum, log) => sum + Math.abs(log.amount), 0)

  // 删除帖子图片
  const postImages = await query<{ image_url: string }>(
    c.env.abdl_space_db, 'SELECT image_url FROM post_images WHERE post_id = ?', [id]
  )
  for (const img of postImages) {
    await deleteImageFromImgbed(c.env, img.image_url)
  }

  // 删除评论图片（评论本身由 DB CASCADE 触发删除）
  const commentRows = await query<{ id: number }>(
    c.env.abdl_space_db, 'SELECT id FROM post_comments WHERE post_id = ?', [id]
  )
  for (const cmt of commentRows) {
    const cmtImages = await query<{ image_url: string }>(
      c.env.abdl_space_db, 'SELECT image_url FROM comment_images WHERE comment_id = ?', [cmt.id]
    )
    for (const img of cmtImages) {
      await deleteImageFromImgbed(c.env, img.image_url)
    }
  }

  // 清除转发引用，避免 FK 约束失败
  await run(c.env.abdl_space_db, 'UPDATE posts SET repost_id = NULL WHERE repost_id = ?', [id])

  // 扣回经验/积分
  const batchOps = [
    c.env.abdl_space_db.prepare('DELETE FROM posts WHERE id = ?', [id]),
  ]

  if (totalExpDeduct > 0) {
    batchOps.push(
      c.env.abdl_space_db.prepare(
        'UPDATE experience SET current_exp = MAX(0, current_exp - ?), total_exp = MAX(0, total_exp - ?) WHERE user_id = ?'
      ).bind(totalExpDeduct, totalExpDeduct, post.user_id),
      c.env.abdl_space_db.prepare(
        "INSERT INTO exp_logs (user_id, amount, type, source_type, source_id, description) VALUES (?, ?, 'post_delete', 'post', ?, '删帖扣回')"
      ).bind(post.user_id, -totalExpDeduct, id)
    )
  }
  if (totalPointDeduct > 0) {
    batchOps.push(
      c.env.abdl_space_db.prepare(
        'UPDATE points SET balance = MAX(0, balance - ?), total_spent = total_spent + ? WHERE user_id = ?'
      ).bind(totalPointDeduct, totalPointDeduct, post.user_id),
      c.env.abdl_space_db.prepare(
        "INSERT INTO point_logs (user_id, amount, type, source_type, source_id, description) VALUES (?, ?, 'post_delete', 'post', ?, '删帖扣回')"
      ).bind(post.user_id, -totalPointDeduct, id)
    )
  }

  await c.env.abdl_space_db.batch(batchOps)
  return c.json({ message: '已删除' })
})

/**
 * DELETE /api/posts/:postId/comments/:commentId — 删除评论（含扣回）
 */
posts.delete('/:postId/comments/:commentId', authMiddleware, async (c) => {
  const user = c.get('user')
  const postId = parseInt(c.req.param('postId') || '')
  const commentId = parseInt(c.req.param('commentId') || '')

  const comment = await queryOne<{ id: number; user_id: number }>(
    c.env.abdl_space_db, 'SELECT id, user_id FROM post_comments WHERE id = ? AND post_id = ?', [commentId, postId]
  )
  if (!comment) return c.json({ error: 'Comment not found' }, 404)
  if (user.role !== 'admin' && comment.user_id !== user.sub) {
    return c.json({ error: 'Not authorized' }, 403)
  }

  // 查询该评论获得的经验/积分
  const expLogs = await query<{ amount: number }>(
    c.env.abdl_space_db,
    "SELECT amount FROM exp_logs WHERE user_id = ? AND source_type = 'comment' AND source_id = ?",
    [comment.user_id, commentId]
  )
  const pointLogs = await query<{ amount: number }>(
    c.env.abdl_space_db,
    "SELECT amount FROM point_logs WHERE user_id = ? AND source_type = 'comment' AND source_id = ?",
    [comment.user_id, commentId]
  )

  const totalExpDeduct = expLogs.reduce((sum, log) => sum + Math.abs(log.amount), 0)
  const totalPointDeduct = pointLogs.reduce((sum, log) => sum + Math.abs(log.amount), 0)

  // 删除评论图片
  const cmtImages = await query<{ image_url: string }>(
    c.env.abdl_space_db, 'SELECT image_url FROM comment_images WHERE comment_id = ?', [commentId]
  )
  for (const img of cmtImages) {
    await deleteImageFromImgbed(c.env, img.image_url)
  }

  // 扣回经验/积分
  const batchOps = [
    c.env.abdl_space_db.prepare('DELETE FROM post_comments WHERE id = ?', [commentId]),
  ]

  if (totalExpDeduct > 0) {
    batchOps.push(
      c.env.abdl_space_db.prepare(
        'UPDATE experience SET current_exp = MAX(0, current_exp - ?), total_exp = MAX(0, total_exp - ?) WHERE user_id = ?'
      ).bind(totalExpDeduct, totalExpDeduct, comment.user_id),
      c.env.abdl_space_db.prepare(
        "INSERT INTO exp_logs (user_id, amount, type, source_type, source_id, description) VALUES (?, ?, 'comment_delete', 'comment', ?, '删评论扣回')"
      ).bind(comment.user_id, -totalExpDeduct, commentId)
    )
  }
  if (totalPointDeduct > 0) {
    batchOps.push(
      c.env.abdl_space_db.prepare(
        'UPDATE points SET balance = MAX(0, balance - ?), total_spent = total_spent + ? WHERE user_id = ?'
      ).bind(totalPointDeduct, totalPointDeduct, comment.user_id),
      c.env.abdl_space_db.prepare(
        "INSERT INTO point_logs (user_id, amount, type, source_type, source_id, description) VALUES (?, ?, 'comment_delete', 'comment', ?, '删评论扣回')"
      ).bind(comment.user_id, -totalPointDeduct, commentId)
    )
  }

  await c.env.abdl_space_db.batch(batchOps)
  return c.json({ message: '评论已删除' })
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
      const img = typeof images[i] === 'string' ? { url: images[i], is_nsfw: false } : images[i]
      if (!img.url) continue
      // Validate image URL format
      try {
        const parsed = new URL(img.url)
        if (!['https:', 'http:'].includes(parsed.protocol)) {
          return c.json({ error: '图片 URL 必须以 http(s) 开头' }, 400)
        }
      } catch {
        return c.json({ error: `无效的图片 URL: ${img.url}` }, 400)
      }
      await run(
        c.env.abdl_space_db,
        'INSERT INTO comment_images (comment_id, image_url, is_nsfw, sort_order) VALUES (?, ?, ?, ?)',
        [commentId, img.url, img.is_nsfw ? 1 : 0, i]
      )
    }
  }

  // 给帖子作者发通知（不给自己发）
  if (post.user_id !== user.sub) {
    await run(
      c.env.abdl_space_db,
      'INSERT INTO notifications (user_id, type, message, related_id, actor_id) VALUES (?, ?, ?, ?, ?)',
      [post.user_id, 'comment', `${user.username} 评论了你的帖子`, postId, user.sub]
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
        'INSERT INTO notifications (user_id, type, message, related_id, actor_id) VALUES (?, ?, ?, ?, ?)',
        [parentComment.user_id, 'reply', `${user.username} 回复了你的评论`, postId, user.sub]
      )
    }
  }

  // 评论奖励：经验 +5，积分 +2
  const COMMENT_EXP = 5
  const COMMENT_POINTS = 2

  await c.env.abdl_space_db.batch([
    c.env.abdl_space_db.prepare(
      'UPDATE experience SET current_exp = current_exp + ?, total_exp = total_exp + ? WHERE user_id = ?'
    ).bind(COMMENT_EXP, COMMENT_EXP, user.sub),
    c.env.abdl_space_db.prepare(
      'INSERT INTO exp_logs (user_id, amount, type, source_type, source_id, description) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(user.sub, COMMENT_EXP, 'comment', 'comment', commentId, '评论'),
    c.env.abdl_space_db.prepare(
      'UPDATE points SET balance = balance + ?, total_earned = total_earned + ? WHERE user_id = ?'
    ).bind(COMMENT_POINTS, COMMENT_POINTS, user.sub),
    c.env.abdl_space_db.prepare(
      'INSERT INTO point_logs (user_id, amount, type, source_type, source_id, description) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(user.sub, COMMENT_POINTS, 'comment', 'comment', commentId, '评论'),
  ])

  return c.json({ message: '评论成功', id: commentId, rewards: { total_exp: COMMENT_EXP, total_points: COMMENT_POINTS } }, 201)
})

export default posts
