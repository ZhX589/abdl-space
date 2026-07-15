/**
 * ABDL Space custom endpoints under Mastodon-compatible path
 * Mounted at /api/v1/abdl/*
 *
 * These expose ABDL-specific features (diapers, ratings, feelings, rankings, etc.)
 * as custom Mastodon-style endpoints. They read from the same D1 database.
 * Original ABDL API endpoints are NOT affected.
 */

import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { query, queryOne } from '../lib/db.ts'
import { mastodonAuth } from './shared.ts'
import { nbwS2SRequest } from '../lib/nbw.ts'
import { toStatusFromNBW } from './converter.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const abdl = new Hono<AppType>()

const DEFAULT_AVATAR = 'https://img.abdl-space.top/file/system/1781439303787_play_store_512.png'

// Helper: build Mastodon account from user row
function miniAccount(user: { id: number; username: string; avatar: string | null; role: string }) {
  return {
    id: String(user.id),
    username: user.username,
    avatar: user.avatar || DEFAULT_AVATAR,
    role: user.role,
  }
}

// ============================================================
// GET /api/v1/abdl/diapers — Paper diaper list
// ============================================================
abdl.get('/diapers', async (c) => {
  const search = c.req.query('search') || ''
  const brand = c.req.query('brand') || ''
  const sort = c.req.query('sort') || 'id'
  const order = c.req.query('order') === 'DESC' ? 'DESC' : 'ASC'
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20')))
  const page = Math.max(1, parseInt(c.req.query('page') || '1'))
  const offset = (page - 1) * limit

  const allowedSorts: Record<string, string> = { id: 'd.id', avg_score: 'avg_score', rating_count: 'rating_count', thickness: 'd.thickness' }
  const sortCol = allowedSorts[sort] || 'd.id'

  let where = 'WHERE 1=1'
  const params: unknown[] = []
  if (search) { where += ' AND (d.brand LIKE ? OR d.model LIKE ?)'; params.push(`%${search}%`, `%${search}%`) }
  if (brand) { where += ' AND d.brand = ?'; params.push(brand) }

  const countRow = await queryOne<{ cnt: number }>(c.env.abdl_space_db, `SELECT COUNT(*) as cnt FROM diapers d ${where}`, params)

  const rows = await query<Record<string, unknown>>(c.env.abdl_space_db,
    `SELECT d.*,
     (SELECT AVG((r.absorption_score + r.comfort_score + r.thickness_score + r.appearance_score + r.value_score) / 5.0) FROM ratings r WHERE r.diaper_id = d.id) as avg_score,
     (SELECT COUNT(*) FROM ratings r WHERE r.diaper_id = d.id) as rating_count,
     (SELECT AVG((f.looseness + 5 + f.softness + 5 + f.dryness + 5 + f.odor_control + 5 + f.quietness + 5) / 5.0) FROM feelings f WHERE f.diaper_id = d.id) as feeling_avg
     FROM diapers d ${where} ORDER BY ${sortCol} ${order} LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  )

  // Get images for each diaper
  const diapers = []
  for (const r of rows) {
    const images = await query<{ url: string }>(c.env.abdl_space_db, 'SELECT url FROM diaper_images WHERE diaper_id = ?', [r.id])
    const sizes = await query<Record<string, unknown>>(c.env.abdl_space_db, 'SELECT * FROM diaper_sizes WHERE diaper_id = ?', [r.id])
    diapers.push({
      id: r.id, brand: r.brand, model: r.model, product_type: r.product_type,
      thickness: r.thickness, absorbency_mfr: r.absorbency_mfr, absorbency_adult: r.absorbency_adult,
      is_baby_diaper: r.is_baby_diaper, comfort: r.comfort, popularity: r.popularity,
      material: r.material, features: r.features, avg_price: r.avg_price,
      avg_score: r.avg_score ? Number(r.avg_score).toFixed(1) : null,
      base_score: r.avg_score ? Number(r.avg_score).toFixed(1) : null,
      rating_count: r.rating_count, feeling_count: r.feeling_avg ? 1 : 0,
      images: images.map(i => i.url),
      sizes,
    })
  }

  return c.json({
    diapers,
    pagination: { page, limit, total: countRow?.cnt ?? 0, totalPages: Math.ceil((countRow?.cnt ?? 0) / limit) },
  })
})

// ============================================================
// GET /api/v1/abdl/diapers/:id — Paper diaper detail
// ============================================================
abdl.get('/diapers/:id', async (c) => {
  const id = parseInt(c.req.param('id'))
  const diaper = await queryOne<Record<string, unknown>>(c.env.abdl_space_db, 'SELECT * FROM diapers WHERE id = ?', [id])
  if (!diaper) return c.json({ error: 'Record not found' }, 404)

  const [sizes, images, ratingCount, avgScore, feelingCount] = await Promise.all([
    query<Record<string, unknown>>(c.env.abdl_space_db, 'SELECT * FROM diaper_sizes WHERE diaper_id = ?', [id]),
    query<{ url: string }>(c.env.abdl_space_db, 'SELECT url FROM diaper_images WHERE diaper_id = ?', [id]),
    queryOne<{ cnt: number }>(c.env.abdl_space_db, 'SELECT COUNT(*) as cnt FROM ratings WHERE diaper_id = ?', [id]),
    queryOne<{ avg: number }>(c.env.abdl_space_db, 'SELECT AVG((absorption_score + comfort_score + thickness_score + appearance_score + value_score) / 5.0) as avg FROM ratings WHERE diaper_id = ?', [id]),
    queryOne<{ cnt: number }>(c.env.abdl_space_db, 'SELECT COUNT(*) as cnt FROM feelings WHERE diaper_id = ?', [id]),
  ])

  return c.json({
    diaper: {
      ...diaper,
      avg_score: avgScore?.avg ? Number(avgScore.avg).toFixed(1) : null,
      base_score: avgScore?.avg ? Number(avgScore.avg).toFixed(1) : null,
      rating_count: ratingCount?.cnt ?? 0,
      feeling_count: feelingCount?.cnt ?? 0,
      images: images.map(i => i.url),
      sizes,
    },
  })
})

// ============================================================
// GET /api/v1/abdl/diapers/:id/ratings — Ratings for a diaper
// ============================================================
abdl.get('/diapers/:id/ratings', async (c) => {
  const id = parseInt(c.req.param('id'))
  const reviews = await query<Record<string, unknown>>(c.env.abdl_space_db,
    `SELECT r.*, u.username, u.avatar, u.role FROM ratings r JOIN users u ON r.user_id = u.id WHERE r.diaper_id = ? ORDER BY r.created_at DESC LIMIT 50`, [id])

  const [absAvg, comAvg, thiAvg, appAvg, valAvg, count] = await Promise.all([
    queryOne<{ avg: number }>(c.env.abdl_space_db, 'SELECT AVG(absorption_score) as avg FROM ratings WHERE diaper_id = ?', [id]),
    queryOne<{ avg: number }>(c.env.abdl_space_db, 'SELECT AVG(comfort_score) as avg FROM ratings WHERE diaper_id = ?', [id]),
    queryOne<{ avg: number }>(c.env.abdl_space_db, 'SELECT AVG(thickness_score) as avg FROM ratings WHERE diaper_id = ?', [id]),
    queryOne<{ avg: number }>(c.env.abdl_space_db, 'SELECT AVG(appearance_score) as avg FROM ratings WHERE diaper_id = ?', [id]),
    queryOne<{ avg: number }>(c.env.abdl_space_db, 'SELECT AVG(value_score) as avg FROM ratings WHERE diaper_id = ?', [id]),
    queryOne<{ cnt: number }>(c.env.abdl_space_db, 'SELECT COUNT(*) as cnt FROM ratings WHERE diaper_id = ?', [id]),
  ])

  const overallAvg = count?.cnt ? ((absAvg?.avg ?? 0) + (comAvg?.avg ?? 0) + (thiAvg?.avg ?? 0) + (appAvg?.avg ?? 0) + (valAvg?.avg ?? 0)) / 5 : 0

  return c.json({
    reviews: reviews.map(r => ({
      id: r.id,
      user: miniAccount({ id: r.user_id as number, username: r.username as string, avatar: r.avatar as string | null, role: r.role as string }),
      diaper_id: r.diaper_id,
      absorption_score: r.absorption_score, comfort_score: r.comfort_score,
      thickness_score: r.thickness_score, appearance_score: r.appearance_score, value_score: r.value_score,
      review: r.review, review_status: r.review_status, created_at: r.created_at,
    })),
    stats: {
      composite: Number(overallAvg.toFixed(1)),
      count: count?.cnt ?? 0,
      dimensions: {
        absorption_score: { avg: Number((absAvg?.avg ?? 0).toFixed(1)), count: count?.cnt ?? 0 },
        comfort_score: { avg: Number((comAvg?.avg ?? 0).toFixed(1)), count: count?.cnt ?? 0 },
        thickness_score: { avg: Number((thiAvg?.avg ?? 0).toFixed(1)), count: count?.cnt ?? 0 },
        appearance_score: { avg: Number((appAvg?.avg ?? 0).toFixed(1)), count: count?.cnt ?? 0 },
        value_score: { avg: Number((valAvg?.avg ?? 0).toFixed(1)), count: count?.cnt ?? 0 },
      },
    },
  })
})

// ============================================================
// GET /api/v1/abdl/diapers/:id/feelings — Feelings for a diaper
// ============================================================
abdl.get('/diapers/:id/feelings', async (c) => {
  const id = parseInt(c.req.param('id'))
  const feelings = await query<Record<string, unknown>>(c.env.abdl_space_db,
    `SELECT f.*, u.username, u.avatar, u.role FROM feelings f JOIN users u ON f.user_id = u.id WHERE f.diaper_id = ? ORDER BY f.created_at DESC LIMIT 50`, [id])

  const stats = await queryOne<Record<string, unknown>>(c.env.abdl_space_db,
    `SELECT AVG(looseness) as looseness, AVG(softness) as softness, AVG(dryness) as dryness, AVG(odor_control) as odor_control, AVG(quietness) as quietness FROM feelings WHERE diaper_id = ?`, [id])

  return c.json({
    feelings: feelings.map(f => ({
      id: f.id,
      user: miniAccount({ id: f.user_id as number, username: f.username as string, avatar: f.avatar as string | null, role: f.role as string }),
      diaper_id: f.diaper_id, size: f.size,
      looseness: f.looseness, softness: f.softness, dryness: f.dryness,
      odor_control: f.odor_control, quietness: f.quietness, created_at: f.created_at,
    })),
    stats: stats ? {
      looseness: Number((stats.looseness as number ?? 0).toFixed(1)),
      softness: Number((stats.softness as number ?? 0).toFixed(1)),
      dryness: Number((stats.dryness as number ?? 0).toFixed(1)),
      odor_control: Number((stats.odor_control as number ?? 0).toFixed(1)),
      quietness: Number((stats.quietness as number ?? 0).toFixed(1)),
    } : null,
    count: feelings.length,
  })
})

// ============================================================
// GET /api/v1/abdl/diapers/brands — Brand list
// ============================================================
abdl.get('/diapers/brands', async (c) => {
  const rows = await query<{ brand: string }>(c.env.abdl_space_db, 'SELECT DISTINCT brand FROM diapers ORDER BY brand')
  return c.json({ brands: rows.map(r => r.brand) })
})

// ============================================================
// GET /api/v1/abdl/diapers/sizes — Size labels
// ============================================================
abdl.get('/diapers/sizes', async (c) => {
  const rows = await query<{ label: string }>(c.env.abdl_space_db, 'SELECT DISTINCT label FROM diaper_sizes ORDER BY label')
  return c.json({ sizes: rows.map(r => r.label) })
})

// ============================================================
// GET /api/v1/abdl/diapers/compare — Compare diapers
// ============================================================
abdl.get('/diapers/compare', async (c) => {
  const idsParam = c.req.query('ids') || ''
  const ids = idsParam.split(',').map(Number).filter(n => !isNaN(n) && n > 0).slice(0, 5)
  if (ids.length === 0) return c.json({ diapers: [] })

  const placeholders = ids.map(() => '?').join(',')
  const rows = await query<Record<string, unknown>>(c.env.abdl_space_db,
    `SELECT d.*,
     (SELECT AVG((r.absorption_score + r.comfort_score + r.thickness_score + r.appearance_score + r.value_score) / 5.0) FROM ratings r WHERE r.diaper_id = d.id) as avg_score,
     (SELECT COUNT(*) FROM ratings r WHERE r.diaper_id = d.id) as rating_count
     FROM diapers d WHERE d.id IN (${placeholders})`, ids)

  const diapers = []
  for (const r of rows) {
    const sizes = await query(c.env.abdl_space_db, 'SELECT * FROM diaper_sizes WHERE diaper_id = ?', [r.id])
    const dims = await Promise.all([
      queryOne<{ avg: number }>(c.env.abdl_space_db, 'SELECT AVG(absorption_score) as avg FROM ratings WHERE diaper_id = ?', [r.id]),
      queryOne<{ avg: number }>(c.env.abdl_space_db, 'SELECT AVG(comfort_score) as avg FROM ratings WHERE diaper_id = ?', [r.id]),
      queryOne<{ avg: number }>(c.env.abdl_space_db, 'SELECT AVG(thickness_score) as avg FROM ratings WHERE diaper_id = ?', [r.id]),
      queryOne<{ avg: number }>(c.env.abdl_space_db, 'SELECT AVG(appearance_score) as avg FROM ratings WHERE diaper_id = ?', [r.id]),
      queryOne<{ avg: number }>(c.env.abdl_space_db, 'SELECT AVG(value_score) as avg FROM ratings WHERE diaper_id = ?', [r.id]),
    ])

    diapers.push({
      id: r.id, brand: r.brand, model: r.model, thickness: r.thickness,
      absorbency_adult: r.absorbency_adult, avg_price: r.avg_price,
      sizes,
      dimensions: {
        absorption_score: { avg: Number((dims[0]?.avg ?? 0).toFixed(1)) },
        comfort_score: { avg: Number((dims[1]?.avg ?? 0).toFixed(1)) },
        thickness_score: { avg: Number((dims[2]?.avg ?? 0).toFixed(1)) },
        appearance_score: { avg: Number((dims[3]?.avg ?? 0).toFixed(1)) },
        value_score: { avg: Number((dims[4]?.avg ?? 0).toFixed(1)) },
      },
      avg_score: r.avg_score ? Number(r.avg_score).toFixed(1) : null,
      base_score: r.avg_score ? Number(r.avg_score).toFixed(1) : null,
      rating_count: r.rating_count,
    })
  }

  return c.json({ diapers })
})

// ============================================================
// GET /api/v1/abdl/rankings — Rankings
// ============================================================
abdl.get('/rankings', async (c) => {
  const type = c.req.query('type') || 'hot'
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20')))

  let orderBy: string
  switch (type) {
    case 'hot':
      orderBy = 'avg_score DESC NULLS LAST'
      break
    case 'popular':
      orderBy = 'rating_count DESC'
      break
    case 'absorbency':
      orderBy = "CAST(REPLACE(REPLACE(d.absorbency_adult, 'ml', ''), ',', '') AS INTEGER) DESC"
      break
    default:
      orderBy = 'd.id ASC'
  }

  const rows = await query<Record<string, unknown>>(c.env.abdl_space_db,
    `SELECT d.*,
     (SELECT AVG((r.absorption_score + r.comfort_score + r.thickness_score + r.appearance_score + r.value_score) / 5.0) FROM ratings r WHERE r.diaper_id = d.id) as avg_score,
     (SELECT COUNT(*) FROM ratings r WHERE r.diaper_id = d.id) as rating_count
     FROM diapers d ORDER BY ${orderBy} LIMIT ?`, [limit])

  return c.json({
    rankings: rows.map(r => ({
      id: r.id, brand: r.brand, model: r.model, is_baby_diaper: !!r.is_baby_diaper,
      avg_score: r.avg_score ? Number(r.avg_score).toFixed(1) : null,
      rating_count: r.rating_count, thickness: r.thickness, absorbency_adult: r.absorbency_adult,
    })),
    type,
    total: rows.length,
  })
})

// ============================================================
// GET /api/v1/abdl/terms — Terms encyclopedia
// ============================================================
abdl.get('/terms', async (c) => {
  const search = c.req.query('search') || ''
  const category = c.req.query('category') || ''

  let where = 'WHERE 1=1'
  const params: unknown[] = []
  if (search) { where += ' AND (term LIKE ? OR definition LIKE ?)'; params.push(`%${search}%`, `%${search}%`) }
  if (category) { where += ' AND category = ?'; params.push(category) }

  const terms = await query<Record<string, unknown>>(c.env.abdl_space_db, `SELECT * FROM terms ${where} ORDER BY term LIMIT 100`, params)

  return c.json({ terms })
})

// ============================================================
// GET /api/v1/abdl/terms/categories — Term categories
// ============================================================
abdl.get('/terms/categories', async (c) => {
  const rows = await query<{ category: string }>(c.env.abdl_space_db, 'SELECT DISTINCT category FROM terms WHERE category IS NOT NULL ORDER BY category')
  return c.json({ categories: rows.map(r => r.category) })
})

// ============================================================
// GET /api/v1/abdl/me — Current user ABDL profile
// ============================================================
abdl.get('/me', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)

  const dbUser = await queryOne<Record<string, unknown>>(c.env.abdl_space_db,
    'SELECT id, username, email, avatar, role, age, region, weight, waist, hip, style_preference, bio, email_verified, created_at FROM users WHERE id = ?', [user.sub])
  if (!dbUser) return c.json({ error: 'User not found' }, 404)

  const [exp, points, badges] = await Promise.all([
    queryOne(c.env.abdl_space_db, 'SELECT * FROM experience WHERE user_id = ?', [user.sub]),
    queryOne(c.env.abdl_space_db, 'SELECT * FROM points WHERE user_id = ?', [user.sub]),
    query(c.env.abdl_space_db, 'SELECT * FROM user_badges WHERE user_id = ?', [user.sub]),
  ])

  return c.json({
    user: { ...dbUser, password_hash: undefined },
    experience: exp || { level: 1, total_exp: 0, current_exp: 0, current_streak: 0 },
    points: points || { balance: 0, total_earned: 0, total_spent: 0 },
    badges,
  })
})

// ============================================================
// GET /api/v1/abdl/users/:id — User ABDL profile
// ============================================================
abdl.get('/users/:id', async (c) => {
  const id = parseInt(c.req.param('id'))
  const dbUser = await queryOne<Record<string, unknown>>(c.env.abdl_space_db,
    'SELECT id, username, avatar, role, age, region, style_preference, bio, created_at FROM users WHERE id = ?', [id])
  if (!dbUser) return c.json({ error: 'Record not found' }, 404)

  const [wornCount, exp] = await Promise.all([
    queryOne<{ cnt: number }>(c.env.abdl_space_db, 'SELECT COUNT(DISTINCT diaper_id) as cnt FROM ratings WHERE user_id = ?', [id]),
    queryOne(c.env.abdl_space_db, 'SELECT * FROM experience WHERE user_id = ?', [id]),
  ])

  return c.json({
    user: { ...dbUser, worn_count: wornCount?.cnt ?? 0 },
    experience: exp || { level: 1, total_exp: 0, current_exp: 0 },
  })
})

// ============================================================
// GET /api/v1/abdl/users/:id/worn — Worn diapers
// ============================================================
abdl.get('/users/:id/worn', async (c) => {
  const id = parseInt(c.req.param('id'))
  const rows = await query<Record<string, unknown>>(c.env.abdl_space_db,
    `SELECT r.diaper_id, d.brand, d.model,
      AVG((r.absorption_score + r.comfort_score + r.thickness_score + r.appearance_score + r.value_score) / 5.0) as avg_score,
      MAX(r.created_at) as rated_at
      FROM ratings r JOIN diapers d ON r.diaper_id = d.id
      WHERE r.user_id = ? GROUP BY r.diaper_id ORDER BY rated_at DESC`, [id])

  return c.json({
    worn: rows.map(r => ({
      diaper_id: r.diaper_id, diaper_name: `${r.brand} ${r.model}`,
      brand: r.brand, avg_score: r.avg_score ? Number(r.avg_score).toFixed(1) : null, rated_at: r.rated_at,
    })),
    total: rows.length,
  })
})

// ============================================================
// GET /api/v1/abdl/nbw/sync-threads — NBW 待同步外发帖子时间线
// 代理 get_sync_threads，转换为 Mastodon Status[]（同 /timelines/home 格式）
// ============================================================
abdl.get('/nbw/sync-threads', async (c) => {
  if (!c.env.NBW_API_KEY) {
    return c.json({ error: 'NBW API 未配置' }, 503)
  }

  const limit = Math.min(40, Math.max(1, parseInt(c.req.query('limit') || c.req.query('perpage') || '20') || 20))
  const fid = c.req.query('fid') || ''
  const orderby = c.req.query('orderby') === 'lastpost' ? 'lastpost' : 'dateline'
  // Mastodon 风格 max_id 兼容：客户端可把上一页 next cursor 塞进 max_id
  const cursor = c.req.query('cursor') || c.req.query('max_id') || ''

  const params: Record<string, string> = {
    perpage: String(limit),
    orderby,
  }
  if (fid && fid !== '0') params.fid = fid
  if (cursor) params.cursor = cursor

  try {
    const result = await nbwS2SRequest(c.env, 'get_sync_threads', params)
    if (result.code !== 200) {
      const status = result.code === 401 || result.code === 403 ? result.code as 401 | 403 : 502
      return c.json({ error: result.msg || 'NBW 请求失败', code: result.code }, status)
    }

    const data = (result.data || {}) as {
      has_more?: boolean
      next_cursor?: string
      list?: Array<{
        tid: number
        fid?: number
        forum_name?: string
        subject?: string
        abstract?: string
        author?: string
        authorid?: number
        avatar?: string
        dateline?: number
        lastpost?: number
        views?: number
        replies?: number
        has_image?: number
        image_list?: Array<string | { url: string; width?: number }>
      }>
    }

    const statuses = (data.list || []).map((t) => toStatusFromNBW(t))

    // Link header：与 /timelines/home 一致，用 next_cursor 作 max_id
    if (data.has_more && data.next_cursor) {
      const qs = new URLSearchParams()
      qs.set('limit', String(limit))
      qs.set('max_id', data.next_cursor)
      if (fid && fid !== '0') qs.set('fid', fid)
      if (orderby !== 'dateline') qs.set('orderby', orderby)
      c.header('Link', `</api/v1/abdl/nbw/sync-threads?${qs}>; rel="next"`)
    }

    return c.json(statuses)
  } catch (e) {
    console.error('NBW get_sync_threads failed:', e)
    return c.json({ error: 'NBW 服务请求失败' }, 502)
  }
})

export default abdl
