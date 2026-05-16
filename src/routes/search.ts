import { Hono } from 'hono'
import type { Env } from '../types/index.ts'
import { query } from '../lib/db.ts'

type AppType = { Bindings: Env }

const search = new Hono<AppType>()

function computeAvgScore(ratingAvg: number, _ratingCount: number, feelingAvg: number | null, feelingCount: number): number {
  if (feelingCount > 0 && feelingAvg !== null) {
    return Math.round((ratingAvg * 0.9 + (feelingAvg + 5) * 0.1) * 10) / 10
  }
  return Math.round(ratingAvg * 10) / 10
}

/**
 * GET /api/search — 全文搜索（跨表聚合：纸尿裤 + Wiki + 术语）
 */
search.get('/', async (c) => {
  const q = c.req.query('q') || ''
  const type = c.req.query('type') || 'all' // 'all' | 'diapers' | 'wiki' | 'terms'
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '20')))

  if (!q || q.length < 2) {
    return c.json({ error: 'Query must be at least 2 characters' }, 400)
  }

  const likePattern = `%${q}%`
  const results: {
    diapers: { id: number; brand: string; model: string; avg_score: number; rating_count: number }[]
    wiki: { id: number; slug: string; title: string; content_preview: string }[]
    terms: { id: number; term: string; abbreviation: string | null; category: string | null }[]
  } = { diapers: [], wiki: [], terms: [] }

  if (type === 'all' || type === 'diapers') {
    const diaperRows = await query<Record<string, unknown>>(
      c.env.abdl_space_db,
      `SELECT d.id, d.brand, d.model,
        ROUND(AVG((r.absorption_score + r.fit_score + r.comfort_score + r.thickness_score + r.appearance_score + r.value_score) / 6.0), 1) as rating_avg,
        COUNT(r.id) as rating_count,
        COALESCE(ROUND(AVG((f.looseness + 5 + f.softness + 5 + f.dryness + 5 + f.odor_control + 5 + f.quietness + 5) / 5.0), 0) as feeling_avg,
        COUNT(DISTINCT f.id) as feeling_count
       FROM diapers d
       LEFT JOIN ratings r ON r.diaper_id = d.id
       LEFT JOIN feelings f ON f.diaper_id = d.id
       WHERE d.brand LIKE ? OR d.model LIKE ?
       GROUP BY d.id
       ORDER BY rating_avg DESC
       LIMIT ?`,
      [likePattern, likePattern, limit]
    )
    results.diapers = diaperRows.map(r => {
      const ratingAvg = Number(r.rating_avg) || 0
      const ratingCount = Number(r.rating_count) || 0
      const feelingAvg = Number(r.feeling_avg) || null
      const feelingCount = Number(r.feeling_count) || 0
      const avgScore = computeAvgScore(ratingAvg, ratingCount, feelingAvg, feelingCount)
      return {
        id: r.id as number,
        brand: r.brand as string,
        model: r.model as string,
        avg_score: avgScore,
        rating_count: ratingCount
      }
    })
  }

  if (type === 'all' || type === 'wiki') {
    const wikiRows = await query<Record<string, unknown>>(
      c.env.abdl_space_db,
      `SELECT id, slug, title,
        SUBSTR(content, 1, 100) as content_preview
       FROM wiki_pages
       WHERE title LIKE ? OR content LIKE ?
       ORDER BY updated_at DESC
       LIMIT ?`,
      [likePattern, likePattern, limit]
    )
    results.wiki = wikiRows.map(r => ({
      id: r.id as number,
      slug: r.slug as string,
      title: r.title as string,
      content_preview: (r.content_preview as string) || ''
    }))
  }

  if (type === 'all' || type === 'terms') {
    const termRows = await query<Record<string, unknown>>(
      c.env.abdl_space_db,
      `SELECT id, term, abbreviation, category
       FROM terms
       WHERE term LIKE ? OR definition LIKE ?
       ORDER BY term ASC
       LIMIT ?`,
      [likePattern, likePattern, limit]
    )
    results.terms = termRows.map(r => ({
      id: r.id as number,
      term: r.term as string,
      abbreviation: (r.abbreviation as string) ?? null,
      category: (r.category as string) ?? null
    }))
  }

  return c.json({
    query: q,
    type,
    total: results.diapers.length + results.wiki.length + results.terms.length,
    results
  })
})

export default search