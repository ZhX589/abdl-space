import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { query } from '../lib/db.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const rankings = new Hono<AppType>()

const VALID_TYPES = ['hot', 'absorbency', 'popular', 'dimension'] as const
const VALID_DIMENSIONS = ['absorption_score', 'fit_score', 'comfort_score', 'thickness_score', 'appearance_score', 'value_score'] as const

function computeAvgScore(ratingAvg: number, _ratingCount: number, feelingAvg: number | null, feelingCount: number): number {
  if (feelingCount > 0 && feelingAvg !== null) {
    return Math.round((ratingAvg * 0.9 + (feelingAvg + 5) * 0.1) * 10) / 10
  }
  return Math.round(ratingAvg * 10) / 10
}

/**
 * GET /api/rankings — 综合排行榜
 */
rankings.get('/', async (c) => {
  const type = c.req.query('type') || 'hot'
  const dimension = c.req.query('dimension')
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '20')))

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
      orderBy = 'avg_score DESC'
      break
    case 'absorbency':
      orderBy = "CAST(REPLACE(REPLACE(d.absorbency_adult, 'ml', ''), ',', '') AS REAL) DESC"
      break
    case 'popular':
      joinRating = true
      orderBy = 'rating_count DESC'
      break
    case 'dimension':
      orderBy = `dim_avg DESC`
      break
  }

  let sql: string
  const params: unknown[] = []

  if (type === 'dimension') {
    sql = `
      SELECT d.id, d.brand, d.model, d.thickness, d.absorbency_adult,
        AVG(r.${dimension}) as dim_avg,
        ROUND(AVG((r.absorption_score + r.fit_score + r.comfort_score + r.thickness_score + r.appearance_score + r.value_score) / 6.0), 1) as rating_avg,
        COUNT(*) as rating_count,
        COALESCE(ROUND(AVG((f.looseness + 5 + f.softness + 5 + f.dryness + 5 + f.odor_control + 5 + f.quietness + 5) / 5.0), 0) as feeling_avg,
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
        ROUND(AVG((r.absorption_score + r.fit_score + r.comfort_score + r.thickness_score + r.appearance_score + r.value_score) / 6.0), 1) as rating_avg,
        COUNT(r.id) as rating_count,
        COALESCE(ROUND(AVG((f.looseness + 5 + f.softness + 5 + f.dryness + 5 + f.odor_control + 5 + f.quietness + 5) / 5.0), 0) as feeling_avg,
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
        absorbency_adult: r.absorbency_adult
      }
    }),
    type
  })
})

export default rankings
