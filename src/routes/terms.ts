import { Hono } from 'hono'
import type { Env, JWTPayload, CreateTermRequest } from '../types/index.ts'
import { query, queryOne, run } from '../lib/db.ts'
import { adminMiddleware } from '../middleware/auth.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const terms = new Hono<AppType>()

/**
 * GET /api/terms — 术语列表
 */
terms.get('/', async (c) => {
  const search = c.req.query('search') || ''
  const category = c.req.query('category') || ''

  const conditions: string[] = []
  const params: unknown[] = []

  if (search) {
    conditions.push('(term LIKE ? OR definition LIKE ?)')
    params.push(`%${search}%`, `%${search}%`)
  }
  if (category) {
    conditions.push('category = ?')
    params.push(category)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const rows = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT * FROM terms ${whereClause} ORDER BY term ASC`,
    params
  )

  return c.json({
    terms: rows.map(r => ({
      id: r.id,
      term: r.term,
      abbreviation: r.abbreviation ?? null,
      definition: r.definition,
      category: r.category ?? null,
      created_by: r.created_by ?? null,
      created_at: r.created_at
    }))
  })
})

/**
 * GET /api/terms/categories — 分类列表
 */
terms.get('/categories', async (c) => {
  const rows = await query<{ category: string }>(
    c.env.abdl_space_db,
    'SELECT DISTINCT category FROM terms WHERE category IS NOT NULL ORDER BY category'
  )
  return c.json({ categories: rows.map(r => r.category) })
})

/**
 * GET /api/terms/:id — 获取单个术语
 */
terms.get('/:id', async (c) => {
  const id = parseInt(c.req.param('id') || '')
  if (!id) return c.json({ error: 'Invalid ID' }, 400)

  const row = await queryOne<Record<string, unknown>>(
    c.env.abdl_space_db, 'SELECT * FROM terms WHERE id = ?', [id]
  )
  if (!row) return c.json({ error: 'Term not found' }, 404)

  return c.json({
    id: row.id,
    term: row.term,
    abbreviation: row.abbreviation ?? null,
    definition: row.definition,
    category: row.category ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at
  })
})

/**
 * POST /api/terms — 创建术语（需管理员）
 */
terms.post('/', adminMiddleware, async (c) => {
  const body = await c.req.json<CreateTermRequest>()
  const { term, abbreviation, definition, category } = body

  if (!term || term.length > 50) {
    return c.json({ error: 'Term must be 1-50 characters' }, 400)
  }
  if (!definition || definition.length < 10 || definition.length > 2000) {
    return c.json({ error: 'Definition must be 10-2000 characters' }, 400)
  }

  const result = await run(
    c.env.abdl_space_db,
    'INSERT INTO terms (term, abbreviation, definition, category, created_by) VALUES (?, ?, ?, ?, ?)',
    [term, abbreviation ?? null, definition, category ?? null, c.get('user').sub]
  )

  return c.json({ id: result.meta.last_row_id, message: '创建成功' }, 201)
})

/**
 * PATCH /api/terms/:id — 编辑术语（需管理员）
 */
terms.patch('/:id', adminMiddleware, async (c) => {
  const id = parseInt(c.req.param('id') || '')
  const body = await c.req.json<Partial<CreateTermRequest>>()

  const existing = await queryOne<{ id: number }>(
    c.env.abdl_space_db, 'SELECT id FROM terms WHERE id = ?', [id]
  )
  if (!existing) return c.json({ error: 'Term not found' }, 404)

  const updates: string[] = []
  const params: unknown[] = []

  const fields: (keyof CreateTermRequest)[] = ['term', 'abbreviation', 'definition', 'category']
  for (const field of fields) {
    if (body[field] !== undefined) {
      updates.push(`${field} = ?`)
      params.push(body[field])
    }
  }

  if (updates.length === 0) return c.json({ error: 'No fields to update' }, 400)

  await run(
    c.env.abdl_space_db,
    `UPDATE terms SET ${updates.join(', ')} WHERE id = ?`,
    [...params, id]
  )

  return c.json({ message: '更新成功' })
})

/**
 * DELETE /api/terms/:id — 删除术语（需管理员）
 */
terms.delete('/:id', adminMiddleware, async (c) => {
  const id = parseInt(c.req.param('id') || '')

  const existing = await queryOne<{ id: number }>(
    c.env.abdl_space_db, 'SELECT id FROM terms WHERE id = ?', [id]
  )
  if (!existing) return c.json({ error: 'Term not found' }, 404)

  await run(c.env.abdl_space_db, 'DELETE FROM terms WHERE id = ?', [id])
  return c.json({ message: '已删除' })
})

export default terms
