import { Hono } from 'hono'
import type { Env, JWTPayload, Diaper, DiaperSize } from '../types/index.ts'
import { query, queryOne } from '../lib/db.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const diapers = new Hono<AppType>()

const VALID_SORT = ['id', 'avg_score', 'rating_count', 'thickness']

/**
 * GET /api/diapers — 纸尿裤列表，支持搜索/筛选/排序/分页
 */
diapers.get('/', async (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') || '1'))
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20')))
  const search = c.req.query('search') || ''
  const brand = c.req.query('brand') || ''
  const size = c.req.query('size') || ''
  const sort = c.req.query('sort') || 'id'
  const order = (c.req.query('order') || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC'

  if (!VALID_SORT.includes(sort)) {
    return c.json({ error: `Invalid sort field: ${sort}. Valid: ${VALID_SORT.join(', ')}` }, 400)
  }

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
  if (size) {
    conditions.push('EXISTS (SELECT 1 FROM diaper_sizes ds2 WHERE ds2.diaper_id = d.id AND ds2.label = ?)')
    params.push(size)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const countResult = await query<{ total: number }>(
    c.env.abdl_space_db,
    `SELECT COUNT(*) as total FROM diapers d ${whereClause}`,
    params
  )
  const total = countResult[0].total
  const offset = (page - 1) * limit

  const dbQuery = `
    SELECT d.*,
      COALESCE(avg_scores.avg_score, 0) as avg_score,
      COALESCE(avg_scores.rating_count, 0) as rating_count,
      COALESCE(feel_cnt.feeling_count, 0) as feeling_count
    FROM diapers d
    LEFT JOIN (
      SELECT r.diaper_id,
        ROUND(AVG(
          (r.absorption_score + r.fit_score + r.comfort_score + r.thickness_score + r.appearance_score + r.value_score) / 6.0
        ), 1) as avg_score,
        COUNT(*) as rating_count
      FROM ratings r
      GROUP BY r.diaper_id
    ) avg_scores ON avg_scores.diaper_id = d.id
    LEFT JOIN (
      SELECT diaper_id, COUNT(*) as feeling_count
      FROM feelings
      GROUP BY diaper_id
    ) feel_cnt ON feel_cnt.diaper_id = d.id
    ${whereClause}
    ORDER BY ${sort === 'avg_score' ? 'avg_score' : `d.${sort}`} ${order}
    LIMIT ? OFFSET ?
  `

  const diaperRows = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    dbQuery,
    [...params, limit, offset]
  )

  const diaperIds = diaperRows.map(r => r.id)
  const sizesMap = new Map<number, DiaperSize[]>()
  if (diaperIds.length > 0) {
    const placeholders = diaperIds.map(() => '?').join(',')
    const sizes = await query<DiaperSize & { diaper_id: number }>(
      c.env.abdl_space_db,
      `SELECT * FROM diaper_sizes WHERE diaper_id IN (${placeholders})`,
      diaperIds
    )
    for (const s of sizes) {
      if (!sizesMap.has(s.diaper_id)) sizesMap.set(s.diaper_id, [])
      sizesMap.get(s.diaper_id)!.push(s)
    }
  }

  const diapersList = diaperRows.map(r => ({
    id: r.id,
    brand: r.brand,
    model: r.model,
    product_type: r.product_type,
    thickness: r.thickness,
    absorbency_mfr: r.absorbency_mfr,
    absorbency_adult: r.absorbency_adult,
    is_baby_diaper: r.is_baby_diaper,
    comfort: r.comfort,
    popularity: r.popularity,
    material: r.material,
    features: r.features,
    avg_price: r.avg_price,
    sizes: (sizesMap.get(r.id as number) || []).map(s => ({
      label: s.label,
      waist_min: s.waist_min,
      waist_max: s.waist_max,
      hip_min: s.hip_min,
      hip_max: s.hip_max
    })),
    avg_score: r.avg_score,
    rating_count: r.rating_count,
    feeling_count: r.feeling_count
  }))

  return c.json({
    diapers: diapersList,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    }
  })
})

/**
 * GET /api/diapers/brands — 品牌列表（去重）
 */
diapers.get('/brands', async (c) => {
  const rows = await query<{ brand: string }>(
    c.env.abdl_space_db,
    'SELECT DISTINCT brand FROM diapers ORDER BY brand'
  )
  return c.json({ brands: rows.map(r => r.brand) })
})

/**
 * GET /api/diapers/sizes — 尺码列表（去重）
 */
diapers.get('/sizes', async (c) => {
  const rows = await query<{ label: string }>(
    c.env.abdl_space_db,
    'SELECT DISTINCT label FROM diaper_sizes ORDER BY label'
  )
  return c.json({ sizes: rows.map(r => r.label) })
})

/**
 * GET /api/diapers/compare — 纸尿裤对比，最多 5 款
 */
diapers.get('/compare', async (c) => {
  const idsParam = c.req.query('ids')
  if (!idsParam) {
    return c.json({ error: 'ids parameter is required' }, 400)
  }

  const ids = idsParam.split(',').map(s => parseInt(s.trim())).filter(id => !isNaN(id) && id > 0).slice(0, 5)

  if (ids.length === 0) {
    return c.json({ error: 'No valid ids provided' }, 400)
  }

  const placeholders = ids.map(() => '?').join(',')
  const diapersQuery = `
    SELECT d.*,
      COALESCE(avg_scores.avg_score, 0) as avg_score,
      COALESCE(avg_scores.rating_count, 0) as rating_count
    FROM diapers d
    LEFT JOIN (
      SELECT r.diaper_id,
        ROUND(AVG(
          (r.absorption_score + r.fit_score + r.comfort_score + r.thickness_score + r.appearance_score + r.value_score) / 6.0
        ), 1) as avg_score,
        COUNT(*) as rating_count
      FROM ratings r
      GROUP BY r.diaper_id
    ) avg_scores ON avg_scores.diaper_id = d.id
    WHERE d.id IN (${placeholders})
  `

  const diaperRows = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    diapersQuery,
    ids
  )

  const diaperIds = diaperRows.map(r => r.id as number)
  const sizesMap = new Map<number, DiaperSize[]>()
  if (diaperIds.length > 0) {
    const sizePlaceholders = diaperIds.map(() => '?').join(',')
    const sizes = await query<DiaperSize & { diaper_id: number }>(
      c.env.abdl_space_db,
      `SELECT * FROM diaper_sizes WHERE diaper_id IN (${sizePlaceholders})`,
      diaperIds
    )
    for (const s of sizes) {
      if (!sizesMap.has(s.diaper_id)) sizesMap.set(s.diaper_id, [])
      sizesMap.get(s.diaper_id)!.push(s)
    }
  }

  const dimensionsMap = new Map<number, Record<string, { avg: number }>>()
  if (diaperIds.length > 0) {
    const dimPlaceholders = diaperIds.map(() => '?').join(',')
    const dimensions = await query<{ diaper_id: number; absorption_score: number; fit_score: number; comfort_score: number; thickness_score: number; appearance_score: number; value_score: number }>(
      c.env.abdl_space_db,
      `SELECT diaper_id,
        AVG(absorption_score) as absorption_score,
        AVG(fit_score) as fit_score,
        AVG(comfort_score) as comfort_score,
        AVG(thickness_score) as thickness_score,
        AVG(appearance_score) as appearance_score,
        AVG(value_score) as value_score
      FROM ratings
      WHERE diaper_id IN (${dimPlaceholders})
      GROUP BY diaper_id`,
      diaperIds
    )
    for (const d of dimensions) {
      dimensionsMap.set(d.diaper_id, {
        absorption_score: { avg: Math.round(d.absorption_score * 10) / 10 },
        fit_score: { avg: Math.round(d.fit_score * 10) / 10 },
        comfort_score: { avg: Math.round(d.comfort_score * 10) / 10 },
        thickness_score: { avg: Math.round(d.thickness_score * 10) / 10 },
        appearance_score: { avg: Math.round(d.appearance_score * 10) / 10 },
        value_score: { avg: Math.round(d.value_score * 10) / 10 }
      })
    }
  }

  const compareData = diaperRows.map(r => ({
    id: r.id,
    brand: r.brand,
    model: r.model,
    thickness: r.thickness,
    absorbency_adult: r.absorbency_adult,
    avg_price: r.avg_price,
    sizes: (sizesMap.get(r.id as number) || []).map(s => ({
      label: s.label,
      waist_min: s.waist_min,
      waist_max: s.waist_max,
      hip_min: s.hip_min,
      hip_max: s.hip_max
    })),
    dimensions: dimensionsMap.get(r.id as number) || {
      absorption_score: { avg: 0 },
      fit_score: { avg: 0 },
      comfort_score: { avg: 0 },
      thickness_score: { avg: 0 },
      appearance_score: { avg: 0 },
      value_score: { avg: 0 }
    },
    avg_score: r.avg_score,
    rating_count: r.rating_count
  }))

  return c.json({ diapers: compareData })
})

/**
 * GET /api/diapers/:id — 纸尿裤详情，含尺码 + 评分 + Wiki
 */
diapers.get('/:id', async (c) => {
  const id = parseInt(c.req.param('id'))
  if (isNaN(id) || id < 1) return c.json({ error: 'Invalid id' }, 400)

  const diaper = await queryOne<Diaper>(
    c.env.abdl_space_db,
    'SELECT * FROM diapers WHERE id = ?',
    [id]
  )
  if (!diaper) return c.json({ error: 'Diaper not found' }, 404)

  const sizes = await query<DiaperSize>(
    c.env.abdl_space_db,
    'SELECT * FROM diaper_sizes WHERE diaper_id = ?',
    [id]
  )

  const reviews = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT r.*, u.username, u.role, u.avatar
     FROM ratings r JOIN users u ON r.user_id = u.id
     WHERE r.diaper_id = ?
     ORDER BY r.created_at DESC`,
    [id]
  )

  const avgScore = await queryOne<{ avg_score: number; rating_count: number }>(
    c.env.abdl_space_db,
    `SELECT
       ROUND(AVG(
         (absorption_score + fit_score + comfort_score + thickness_score + appearance_score + value_score) / 6.0
       ), 1) as avg_score,
       COUNT(*) as rating_count
     FROM ratings WHERE diaper_id = ?`,
    [id]
  )

  const feelingCount = await queryOne<{ count: number }>(
    c.env.abdl_space_db,
    'SELECT COUNT(*) as count FROM feelings WHERE diaper_id = ?',
    [id]
  )

  const wiki = await queryOne<Record<string, unknown>>(
    c.env.abdl_space_db,
    'SELECT id, title, content, diaper_id, updated_at FROM wiki_pages WHERE diaper_id = ?',
    [id]
  )

  return c.json({
    diaper: {
      id: diaper.id,
      brand: diaper.brand,
      model: diaper.model,
      product_type: diaper.product_type,
      thickness: diaper.thickness,
      absorbency_mfr: diaper.absorbency_mfr,
      absorbency_adult: diaper.absorbency_adult,
      is_baby_diaper: diaper.is_baby_diaper,
      comfort: diaper.comfort,
      popularity: diaper.popularity,
      material: diaper.material,
      features: diaper.features,
      avg_price: diaper.avg_price,
      sizes: sizes.map(s => ({
        label: s.label,
        waist_min: s.waist_min,
        waist_max: s.waist_max,
        hip_min: s.hip_min,
        hip_max: s.hip_max
      })),
      avg_score: avgScore?.avg_score ?? null,
      rating_count: avgScore?.rating_count ?? 0,
      feeling_count: feelingCount?.count ?? 0
    },
    reviews: reviews.map(r => ({
      id: r.id,
      user: { id: r.user_id, username: r.username, avatar: r.avatar || null, role: r.role },
      diaper_id: r.diaper_id,
      absorption_score: r.absorption_score,
      fit_score: r.fit_score,
      comfort_score: r.comfort_score,
      thickness_score: r.thickness_score,
      appearance_score: r.appearance_score,
      value_score: r.value_score,
      review: r.review || null,
      review_status: r.review_status,
      created_at: r.created_at
    })),
    wiki: wiki ? {
      diaper_id: wiki.diaper_id,
      category: `${diaper.product_type}/${diaper.brand}`,
      title: wiki.title,
      content: wiki.content,
      updated_at: wiki.updated_at
    } : null
  })
})

export default diapers