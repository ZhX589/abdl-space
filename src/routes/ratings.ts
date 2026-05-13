import { Hono } from 'hono'
import type { Env, JWTPayload, CreateRatingRequest } from '../types/index.ts'
import { queryOne, run } from '../lib/db.ts'
import { authMiddleware } from '../middleware/auth.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const ratings = new Hono<AppType>()

/**
 * POST /api/ratings — 创建评分
 */
ratings.post('/', authMiddleware, async (c) => {
  const user = c.get('user')
  const body = await c.req.json<CreateRatingRequest>()
  const { diaper_id, absorption_score, fit_score, comfort_score, thickness_score, appearance_score, value_score, review } = body

  if (!diaper_id || absorption_score === undefined || fit_score === undefined || comfort_score === undefined || thickness_score === undefined || appearance_score === undefined || value_score === undefined) {
    return c.json({ error: 'All score fields are required' }, 400)
  }

  const scores = [absorption_score, fit_score, comfort_score, thickness_score, appearance_score, value_score]
  if (scores.some(s => s < 1 || s > 10)) {
    return c.json({ error: 'Scores must be 1-10' }, 400)
  }
  if (review && review.length > 500) {
    return c.json({ error: 'Review must be 500 characters or less' }, 400)
  }

  const diaper = await queryOne<{ id: number }>(
    c.env.abdl_space_db, 'SELECT id FROM diapers WHERE id = ?', [diaper_id]
  )
  if (!diaper) return c.json({ error: 'Diaper not found' }, 404)

  const existing = await queryOne<{ id: number }>(
    c.env.abdl_space_db,
    'SELECT id FROM ratings WHERE user_id = ? AND diaper_id = ?',
    [user.sub, diaper_id]
  )
  if (existing) return c.json({ error: 'Already rated this diaper' }, 409)

  const result = await run(
    c.env.abdl_space_db,
    `INSERT INTO ratings (user_id, diaper_id, absorption_score, fit_score, comfort_score, thickness_score, appearance_score, value_score, review)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [user.sub, diaper_id, absorption_score, fit_score, comfort_score, thickness_score, appearance_score, value_score, review ?? null]
  )

  return c.json({
    message: '评分成功',
    review_status: 'approved',
    id: result.meta.last_row_id
  })
})

/**
 * GET /api/ratings/me/:diaperId — 当前用户对某纸尿裤的评分
 */
ratings.get('/me/:diaperId', authMiddleware, async (c) => {
  const user = c.get('user')
  const diaperId = parseInt(c.req.param('diaperId') || '')

  const row = await queryOne<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT r.*, u.username, u.role, u.avatar
     FROM ratings r JOIN users u ON r.user_id = u.id
     WHERE r.user_id = ? AND r.diaper_id = ?`,
    [user.sub, diaperId]
  )

  if (!row) return c.json({ rating: null })

  return c.json({
    rating: {
      id: row.id,
      user: { id: row.user_id, username: row.username, avatar: row.avatar ?? null, role: row.role },
      diaper_id: row.diaper_id,
      absorption_score: row.absorption_score,
      fit_score: row.fit_score,
      comfort_score: row.comfort_score,
      thickness_score: row.thickness_score,
      appearance_score: row.appearance_score,
      value_score: row.value_score,
      review: row.review ?? null,
      review_status: row.review_status,
      created_at: row.created_at
    }
  })
})

/**
 * DELETE /api/ratings/:id — 删除评分
 */
ratings.delete('/:id', authMiddleware, async (c) => {
  const user = c.get('user')
  const id = parseInt(c.req.param('id') || '')

  const rating = await queryOne<{ id: number; user_id: number }>(
    c.env.abdl_space_db, 'SELECT id, user_id FROM ratings WHERE id = ?', [id]
  )
  if (!rating) return c.json({ error: 'Rating not found' }, 404)
  if (user.role !== 'admin' && rating.user_id !== user.sub) {
    return c.json({ error: 'Not authorized' }, 403)
  }

  await run(c.env.abdl_space_db, 'DELETE FROM ratings WHERE id = ?', [id])
  return c.json({ message: '删除成功' })
})

export default ratings
