import { Hono } from 'hono'
import type { Env } from '../types/index.ts'
import { query } from '../lib/db.ts'

type AppType = { Bindings: Env }

const search = new Hono<AppType>()

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
        COALESCE(ROUND(AVG((r.absorption_score + r.fit_score + r.comfort_score + r.thickness_score + r.appearance_score + r.value_score) / 6.0), 1), 0) as avg_score,
        COUNT(r.id) as rating_count
       FROM diapers d
       LEFT JOIN ratings r ON r.diaper_id = d.id
       WHERE d.brand LIKE ? OR d.model LIKE ?
       GROUP BY d.id
       ORDER BY avg_score DESC
       LIMIT ?`,
      [likePattern, likePattern, limit]
    )
    results.diapers = diaperRows.map(r => ({
      id: r.id as number,
      brand: r.brand as string,
      model: r.model as string,
      avg_score: Number(r.avg_score) || 0,
      rating_count: Number(r.rating_count) || 0
    }))
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