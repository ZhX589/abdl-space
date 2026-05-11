import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { query } from '../lib/db.ts'
import { authMiddleware } from '../middleware/auth.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const recommend = new Hono<AppType>()

/**
 * POST /api/recommend — AI 推荐（当前返回人气最高 + 简单规则）
 */
recommend.post('/', authMiddleware, async (c) => {
  await c.req.json<{ selected: Record<string, boolean> }>()
  // selected 参数供未来 AI 对接使用，当前版本用简单规则

  const rows = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT d.id, d.brand, d.model, d.thickness,
      ROUND(AVG((r.absorption_score + r.fit_score + r.comfort_score + r.thickness_score + r.appearance_score + r.value_score) / 6.0), 1) as avg_score,
      COUNT(*) as rating_count
     FROM diapers d
     LEFT JOIN ratings r ON r.diaper_id = d.id
     GROUP BY d.id
     ORDER BY avg_score DESC
     LIMIT 5`
  )

  const recommendations = rows.map((r, i) => ({
    diaper_id: r.id,
    brand: r.brand,
    model: r.model,
    reason: (r.avg_score as number) >= 8 ? '综合评分超高，社区力荐' :
            (r.thickness as number) <= 2 ? '超薄设计，适合日常穿着' :
            '热门之选',
    matchScore: 100 - i * 12
  }))

  return c.json({
    recommendations,
    summary: `根据您的数据，推荐以上 ${recommendations.length} 款`
  })
})

/**
 * GET /api/recommend/guess — 猜你喜欢
 */
recommend.get('/guess', async (c) => {
  const rows = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT d.id, d.brand, d.model, d.thickness,
      ROUND(AVG((r.absorption_score + r.fit_score + r.comfort_score + r.thickness_score + r.appearance_score + r.value_score) / 6.0), 1) as avg_score,
      COUNT(*) as rating_count
     FROM diapers d
     LEFT JOIN ratings r ON r.diaper_id = d.id
     GROUP BY d.id
     ORDER BY avg_score DESC
     LIMIT 5`
  )

  return c.json({
    recommendations: rows.map(r => ({
      id: r.id,
      brand: r.brand,
      model: r.model,
      avg_score: r.avg_score ?? 0,
      rating_count: r.rating_count ?? 0,
      thickness: r.thickness,
      reason: (r.avg_score as number) >= 8 ? '综合评分超高，社区力荐' :
              (r.thickness as number) <= 2 ? '超薄设计，适合日常穿着' :
              '热门之选'
    }))
  })
})

export default recommend
