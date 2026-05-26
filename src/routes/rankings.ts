import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { query, dimensionWeightedScore } from '../lib/db.ts'
import { rateLimit } from '../lib/rate-limit.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const rankings = new Hono<AppType>()

// 公共 API 限速：每 IP 每分钟 60 次
rankings.use('*', rateLimit('rankings', 60_000, 60))

const VALID_TYPES = ['hot', 'absorbency', 'popular', 'dimension'] as const
const VALID_DIMENSIONS = ['absorption_score', 'comfort_score', 'thickness_score', 'appearance_score', 'value_score'] as const

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
      orderBy = `dim_avg DESC`
      break
  }

  const dimAvgExpr = (alias: string) =>
    `ROUND(AVG(r.${alias}), 1) as ${alias}`

  let sql: string
  const params: unknown[] = []

  if (type === 'dimension') {
    sql = `
      SELECT d.id, d.brand, d.model, d.thickness, d.absorbency_adult, d.is_baby_diaper,
        AVG(r.${dimension}) as dim_avg,
        COUNT(*) as rating_count,
        ${dimAvgExpr('absorption_score')},
        ${dimAvgExpr('comfort_score')},
        ${dimAvgExpr('thickness_score')},
        ${dimAvgExpr('appearance_score')},
        ${dimAvgExpr('value_score')}
      FROM diapers d
      JOIN ratings r ON r.diaper_id = d.id
      GROUP BY d.id
      HAVING dim_avg IS NOT NULL
    `
  } else if (joinRating) {
    sql = `
      SELECT d.id, d.brand, d.model, d.thickness, d.absorbency_adult, d.is_baby_diaper,
        COUNT(r.id) as rating_count,
        ${dimAvgExpr('absorption_score')},
        ${dimAvgExpr('comfort_score')},
        ${dimAvgExpr('thickness_score')},
        ${dimAvgExpr('appearance_score')},
        ${dimAvgExpr('value_score')}
      FROM diapers d
      LEFT JOIN ratings r ON r.diaper_id = d.id
      GROUP BY d.id
    `
  } else {
    sql = `
      SELECT d.id, d.brand, d.model, d.thickness, d.absorbency_adult, d.is_baby_diaper,
        0 as rating_count, 0 as absorption_score, 0 as comfort_score,
        0 as thickness_score, 0 as appearance_score, 0 as value_score
      FROM diapers d
      ORDER BY ${orderBy}
      LIMIT ?
    `
    params.push(limit)
  }

  const rows = await query<Record<string, unknown>>(c.env.abdl_space_db, sql, params)

  // 全局每维度统计用于贝叶斯修正
  const gStatsRows = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT
       COALESCE(AVG(cnt), 5) as avg_count,
       COALESCE(AVG(absorption_score), 5) as g_absorption,
       COALESCE(AVG(comfort_score), 5) as g_comfort,
       COALESCE(AVG(thickness_score), 5) as g_thickness,
       COALESCE(AVG(appearance_score), 5) as g_appearance,
       COALESCE(AVG(value_score), 5) as g_value
     FROM (
       SELECT diaper_id, COUNT(*) as cnt,
         AVG(absorption_score) as absorption_score,
         AVG(comfort_score) as comfort_score,
         AVG(thickness_score) as thickness_score,
         AVG(appearance_score) as appearance_score,
         AVG(value_score) as value_score
       FROM ratings GROUP BY diaper_id
     )`
  )
  const gM = Number(gStatsRows[0]?.avg_count) || 5
  const globalStats: Record<string, number> = {
    absorption_score: Number(gStatsRows[0]?.g_absorption) || 5,
    comfort_score: Number(gStatsRows[0]?.g_comfort) || 5,
    thickness_score: Number(gStatsRows[0]?.g_thickness) || 5,
    appearance_score: Number(gStatsRows[0]?.g_appearance) || 5,
    value_score: Number(gStatsRows[0]?.g_value) || 5,
  }

  const needsResort = type === 'hot' || type === 'dimension'

  let ranked = rows.map(r => {
    const ratingCount = Number(r.rating_count) || 0
    const dimAvgs: Record<string, number> = {
      absorption_score: Number(r.absorption_score) || 0,
      comfort_score: Number(r.comfort_score) || 0,
      thickness_score: Number(r.thickness_score) || 0,
      appearance_score: Number(r.appearance_score) || 0,
      value_score: Number(r.value_score) || 0,
    }
    const avgScore = dimensionWeightedScore(dimAvgs, ratingCount, globalStats, gM, !!r.is_baby_diaper)
    const baseScore = dimensionWeightedScore({}, 0, globalStats, gM, !!r.is_baby_diaper)
    return {
      id: r.id,
      brand: r.brand,
      model: r.model,
      avg_score: avgScore,
      base_score: baseScore,
      rating_count: ratingCount,
      thickness: r.thickness,
      absorbency_adult: r.absorbency_adult,
      ...(type === 'dimension' ? { dim_avg: Math.round(Number(r.dim_avg) * 10) / 10 } : {}),
    }
  })

  if (needsResort) {
    ranked.sort((a, b) => b.avg_score - a.avg_score)
    ranked = ranked.slice(0, limit)
  }

  return c.json({
    rankings: ranked,
    type
  })
})

export default rankings
