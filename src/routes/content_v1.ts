import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Env } from '../types/index.ts'
import { query, queryOne, computeAvgScore } from '../lib/db.ts'
import { validateContentApiKey, recordContentKeyUsage } from './content_keys.ts'
import { rateLimit } from '../lib/rate-limit.ts'

type AppType = { Bindings: Env }

const contentV1 = new Hono<AppType>()

// 外部 API 允许任意来源（API Key 鉴权）
contentV1.use('*', cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'OPTIONS'],
}))

// 限速：每 API Key 每分钟 120 次
contentV1.use('*', rateLimit('v1-content', 60_000, 120))

/* ============================================================
 * 工具函数
 * ============================================================ */

function extractApiKey(c: { req: { header: (name: string) => string | undefined } }): string | null {
  const auth = c.req.header('Authorization')
  if (!auth) return null
  const match = auth.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : null
}

/** 验证 API Key 并检查权限 + per-key 限速 */
const keyRateLimiters = new Map<string, { count: number; resetAt: number }>()

async function requireKey(c: { env: Env; req: { header: (name: string) => string | undefined } }, perm: string) {
  const rawKey = extractApiKey(c)
  if (!rawKey) return { error: 'Missing Authorization header', status: 401 as const }
  const keyInfo = await validateContentApiKey(c.env.abdl_space_db, rawKey)
  if (!keyInfo.valid) return { error: 'Invalid or disabled API key', status: 401 as const }
  if (!keyInfo.permissions!.includes(perm)) return { error: `Key does not have "${perm}" permission`, status: 403 as const }

  // Per-key 限速
  const keyId = String(keyInfo.keyId!)
  const limit = keyInfo.rateLimit || 200
  const now = Date.now()
  const entry = keyRateLimiters.get(keyId)
  if (!entry || now > entry.resetAt) {
    keyRateLimiters.set(keyId, { count: 1, resetAt: now + 60_000 })
  } else if (entry.count >= limit) {
    return { error: 'Rate limit exceeded for this API key', status: 429 as const }
  } else {
    entry.count++
  }

  return { keyId: keyInfo.keyId!, ownerId: keyInfo.ownerId! }
}

/* ============================================================
 * GET /api/v1/content/posts — 帖子列表
 * ============================================================ */
contentV1.get('/posts', async (c) => {
  const auth = await requireKey(c, 'read_posts')
  if ('error' in auth) return c.json({ error: auth.error }, auth.status)
  c.executionCtx.waitUntil(recordContentKeyUsage(c.env.abdl_space_db, auth.keyId))

  const page = Math.max(1, parseInt(c.req.query('page') || '1'))
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20')))
  const search = c.req.query('search') || ''
  const userId = c.req.query('user_id') ? parseInt(c.req.query('user_id')!) : null

  const conditions: string[] = []
  const params: unknown[] = []

  if (search) {
    conditions.push('p.content LIKE ?')
    params.push(`%${search}%`)
  }
  if (userId) {
    conditions.push('p.user_id = ?')
    params.push(userId)
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

  const posts = rows.map(r => ({
    id: r.id,
    user: { id: r.user_id, username: r.username, avatar: r.avatar ?? null, role: r.role },
    content: r.content,
    diaper_id: r.diaper_id ?? null,
    pinned: !!r.pinned,
    like_count: r.like_count,
    comment_count: r.comment_count,
    created_at: r.created_at,
  }))

  return c.json({
    posts,
    pagination: {
      page, limit,
      total: countResult[0].total,
      totalPages: Math.ceil(countResult[0].total / limit),
    }
  })
})

/* ============================================================
 * GET /api/v1/content/posts/:id — 帖子详情 + 评论
 * ============================================================ */
contentV1.get('/posts/:id', async (c) => {
  const auth = await requireKey(c, 'read_posts')
  if ('error' in auth) return c.json({ error: auth.error }, auth.status)
  c.executionCtx.waitUntil(recordContentKeyUsage(c.env.abdl_space_db, auth.keyId))

  const postId = parseInt(c.req.param('id'))
  if (!postId) return c.json({ error: 'Invalid post id' }, 400)

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

  const comments = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT pc.id, pc.post_id, pc.user_id, pc.parent_id, pc.content, pc.created_at,
            u.username, u.avatar, u.role,
            (SELECT COUNT(*) FROM likes WHERE target_type = 'comment' AND target_id = pc.id) as like_count
     FROM post_comments pc JOIN users u ON pc.user_id = u.id
     WHERE pc.post_id = ?
     ORDER BY pc.created_at ASC`,
    [postId]
  )

  return c.json({
    post: {
      id: post.id,
      user: { id: post.user_id, username: post.username, avatar: post.avatar ?? null, role: post.role },
      content: post.content,
      diaper_id: post.diaper_id ?? null,
      pinned: !!post.pinned,
      like_count: post.like_count,
      comment_count: post.comment_count,
      created_at: post.created_at,
    },
    comments: comments.map(cmt => ({
      id: cmt.id,
      post_id: cmt.post_id,
      user: { id: cmt.user_id, username: cmt.username, avatar: cmt.avatar ?? null, role: cmt.role },
      parent_id: cmt.parent_id ?? null,
      content: cmt.content,
      like_count: cmt.like_count,
      created_at: cmt.created_at,
    })),
  })
})

/* ============================================================
 * GET /api/v1/content/rankings — 纸尿裤排行榜
 * ============================================================ */
contentV1.get('/rankings', async (c) => {
  const auth = await requireKey(c, 'read_rankings')
  if ('error' in auth) return c.json({ error: auth.error }, auth.status)
  c.executionCtx.waitUntil(recordContentKeyUsage(c.env.abdl_space_db, auth.keyId))

  const type = c.req.query('type') || 'hot'
  const dimension = c.req.query('dimension')
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '20')))

  const VALID_TYPES = ['hot', 'absorbency', 'popular', 'dimension'] as const
  const VALID_DIMENSIONS = ['absorption_score', 'comfort_score', 'thickness_score', 'appearance_score', 'value_score'] as const

  if (!VALID_TYPES.includes(type as typeof VALID_TYPES[number])) {
    return c.json({ error: `Invalid type. Valid: ${VALID_TYPES.join(', ')}` }, 400)
  }
  if (type === 'dimension' && (!dimension || !VALID_DIMENSIONS.includes(dimension as typeof VALID_DIMENSIONS[number]))) {
    return c.json({ error: `dimension required. Valid: ${VALID_DIMENSIONS.join(', ')}` }, 400)
  }

  let orderBy = 'avg_score DESC'
  let joinRating = false

  switch (type) {
    case 'hot':
      joinRating = true
      orderBy = 'rating_avg DESC'
      break
    case 'absorbency':
      orderBy = "CAST(REPLACE(REPLACE(d.absorbency_adult, 'ml', ''), ',', '') AS REAL) DESC"
      break
    case 'popular':
      joinRating = true
      orderBy = 'rating_count DESC'
      break
    case 'dimension':
      orderBy = 'dim_avg DESC'
      break
  }

  let sql: string
  const params: unknown[] = []

  if (type === 'dimension') {
    sql = `
      SELECT d.id, d.brand, d.model, d.thickness, d.absorbency_adult,
        AVG(r.${dimension}) as dim_avg,
        ROUND(AVG(r.absorption_score * 0.30 + r.comfort_score * 0.35 + r.thickness_score * 0.10 + r.appearance_score * 0.20 + r.value_score * 0.05), 1) as rating_avg,
        COUNT(*) as rating_count,
        COALESCE(ROUND(AVG((f.looseness + 5 + f.softness + 5 + f.dryness + 5 + f.odor_control + 5 + f.quietness + 5) / 5.0), 1), 0) as feeling_avg,
        COUNT(DISTINCT f.id) as feeling_count
      FROM diapers d
      JOIN ratings r ON r.diaper_id = d.id
      LEFT JOIN feelings f ON f.diaper_id = d.id
      GROUP BY d.id
      HAVING dim_avg IS NOT NULL
      ORDER BY ${orderBy}
      LIMIT ?
    `
    params.push(limit)
  } else if (joinRating) {
    sql = `
      SELECT d.id, d.brand, d.model, d.thickness, d.absorbency_adult,
        ROUND(AVG(r.absorption_score * 0.30 + r.comfort_score * 0.35 + r.thickness_score * 0.10 + r.appearance_score * 0.20 + r.value_score * 0.05), 1) as rating_avg,
        COUNT(r.id) as rating_count,
        COALESCE(ROUND(AVG((f.looseness + 5 + f.softness + 5 + f.dryness + 5 + f.odor_control + 5 + f.quietness + 5) / 5.0), 1), 0) as feeling_avg,
        COUNT(DISTINCT f.id) as feeling_count
      FROM diapers d
      LEFT JOIN ratings r ON r.diaper_id = d.id
      LEFT JOIN feelings f ON f.diaper_id = d.id
      GROUP BY d.id
      ORDER BY ${orderBy}
      LIMIT ?
    `
    params.push(limit)
  } else {
    sql = `
      SELECT d.id, d.brand, d.model, d.thickness, d.absorbency_adult,
        0 as rating_avg, 0 as rating_count, 0 as feeling_avg, 0 as feeling_count
      FROM diapers d
      ORDER BY ${orderBy}
      LIMIT ?
    `
    params.push(limit)
  }

  const rows = await query<Record<string, unknown>>(c.env.abdl_space_db, sql, params)

  return c.json({
    rankings: rows.map(r => {
      const ratingAvg = Number(r.rating_avg) || 0
      const ratingCount = Number(r.rating_count) || 0
      const feelingAvg = Number(r.feeling_avg) || null
      const feelingCount = Number(r.feeling_count) || 0
      const avgScore = computeAvgScore(ratingAvg, ratingCount, feelingAvg, feelingCount)
      return {
        id: r.id,
        brand: r.brand,
        model: r.model,
        avg_score: avgScore,
        rating_count: ratingCount,
        thickness: r.thickness,
        absorbency_adult: r.absorbency_adult,
      }
    }),
    type,
  })
})

/* ============================================================
 * GET /api/v1/content/diapers — 纸尿裤列表
 * ============================================================ */
contentV1.get('/diapers', async (c) => {
  const auth = await requireKey(c, 'read_diapers')
  if ('error' in auth) return c.json({ error: auth.error }, auth.status)
  c.executionCtx.waitUntil(recordContentKeyUsage(c.env.abdl_space_db, auth.keyId))

  const page = Math.max(1, parseInt(c.req.query('page') || '1'))
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20')))
  const search = c.req.query('search') || ''
  const brand = c.req.query('brand') || ''

  const conditions: string[] = []
  const params: unknown[] = []

  if (search) {
    conditions.push('(d.brand LIKE ? OR d.model LIKE ?)')
    params.push(`%${search}%`, `%${search}%`)
  }
  if (brand) {
    conditions.push('d.brand = ?')
    params.push(brand)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const countResult = await query<{ total: number }>(
    c.env.abdl_space_db,
    `SELECT COUNT(*) as total FROM diapers d ${whereClause}`,
    params
  )

  const offset = (page - 1) * limit
  const rows = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT d.id, d.brand, d.model, d.thickness, d.absorbency_adult, d.image_url
     FROM diapers d
     ${whereClause}
     ORDER BY d.brand, d.model
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  )

  return c.json({
    diapers: rows.map(r => ({
      id: r.id,
      brand: r.brand,
      model: r.model,
      thickness: r.thickness,
      absorbency_adult: r.absorbency_adult,
      image_url: r.image_url ?? null,
    })),
    pagination: {
      page, limit,
      total: countResult[0].total,
      totalPages: Math.ceil(countResult[0].total / limit),
    }
  })
})

export default contentV1
