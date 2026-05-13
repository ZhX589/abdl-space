import { Hono } from 'hono'
import type { Env, JWTPayload, CreateFeelingRequest } from '../types/index.ts'
import { queryOne, run } from '../lib/db.ts'
import { authMiddleware } from '../middleware/auth.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const feelings = new Hono<AppType>()

/**
 * POST /api/feelings — 创建使用感受
 */
feelings.post('/', authMiddleware, async (c) => {
  const user = c.get('user')
  const body = await c.req.json<CreateFeelingRequest>()
  const { diaper_id, size, looseness, softness, dryness, odor_control, quietness } = body

  if (!diaper_id || !size || looseness === undefined || softness === undefined || dryness === undefined || odor_control === undefined || quietness === undefined) {
    return c.json({ error: 'All fields are required' }, 400)
  }

  const scores = [looseness, softness, dryness, odor_control, quietness]
  if (scores.some(s => s < -5 || s > 5)) {
    return c.json({ error: 'Scores must be -5 to 5' }, 400)
  }
  if (size.length > 10) {
    return c.json({ error: 'Size label too long' }, 400)
  }

  const diaper = await queryOne<{ id: number }>(
    c.env.abdl_space_db, 'SELECT id FROM diapers WHERE id = ?', [diaper_id]
  )
  if (!diaper) return c.json({ error: 'Diaper not found' }, 404)

  const existing = await queryOne<{ id: number }>(
    c.env.abdl_space_db,
    'SELECT id FROM feelings WHERE user_id = ? AND diaper_id = ? AND size = ?',
    [user.sub, diaper_id, size]
  )
  if (existing) return c.json({ error: 'Already submitted feeling for this diaper and size' }, 409)

  const result = await run(
    c.env.abdl_space_db,
    `INSERT INTO feelings (user_id, diaper_id, size, looseness, softness, dryness, odor_control, quietness)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [user.sub, diaper_id, size, looseness, softness, dryness, odor_control, quietness]
  )

  return c.json({ message: '提交成功', id: result.meta.last_row_id })
})

/**
 * GET /api/feelings/me/:diaperId/:size — 当前用户对某纸尿裤+尺码的感受
 */
feelings.get('/me/:diaperId/:size', authMiddleware, async (c) => {
  const user = c.get('user')
  const diaperId = parseInt(c.req.param('diaperId') || '')
  const size = c.req.param('size')

  const row = await queryOne<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT f.*, u.username, u.avatar
     FROM feelings f JOIN users u ON f.user_id = u.id
     WHERE f.user_id = ? AND f.diaper_id = ? AND f.size = ?`,
    [user.sub, diaperId, size]
  )

  if (!row) return c.json({ feeling: null })

  return c.json({
    feeling: {
      id: row.id,
      user: { id: row.user_id, username: row.username, avatar: row.avatar ?? null },
      diaper_id: row.diaper_id,
      size: row.size,
      looseness: row.looseness,
      softness: row.softness,
      dryness: row.dryness,
      odor_control: row.odor_control,
      quietness: row.quietness,
      created_at: row.created_at
    }
  })
})

/**
 * DELETE /api/feelings/:id — 删除感受
 */
feelings.delete('/:id', authMiddleware, async (c) => {
  const user = c.get('user')
  const id = parseInt(c.req.param('id') || '')

  const feeling = await queryOne<{ id: number; user_id: number }>(
    c.env.abdl_space_db, 'SELECT id, user_id FROM feelings WHERE id = ?', [id]
  )
  if (!feeling) return c.json({ error: 'Feeling not found' }, 404)
  if (user.role !== 'admin' && feeling.user_id !== user.sub) {
    return c.json({ error: 'Not authorized' }, 403)
  }

  await run(c.env.abdl_space_db, 'DELETE FROM feelings WHERE id = ?', [id])
  return c.json({ message: '删除成功' })
})

export default feelings
