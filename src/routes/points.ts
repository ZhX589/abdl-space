import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { query, queryOne } from '../lib/db.ts'
import { authMiddleware } from '../middleware/auth.ts'
import { calcLevel, calcLevelProgress, getCheckinMultiplier, getPointsMultiplier } from '../lib/level.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const points = new Hono<AppType>()

/**
 * GET /api/users/:id/points — 积分余额
 */
points.get('/:id/points', authMiddleware, async (c) => {
  const targetId = Number(c.req.param('id'))
  if (isNaN(targetId)) return c.json({ error: 'Invalid user ID' }, 400)

  const row = await queryOne<{ balance: number; total_earned: number; total_spent: number }>(
    c.env.abdl_space_db,
    'SELECT balance, total_earned, total_spent FROM points WHERE user_id = ?',
    [targetId]
  )

  if (!row) {
    // 用户可能还没有积分记录，返回默认值
    return c.json({
      user_id: targetId,
      balance: 0,
      total_earned: 0,
      total_spent: 0,
    })
  }

  return c.json({
    user_id: targetId,
    ...row,
  })
})

/**
 * GET /api/users/:id/points/logs — 积分流水
 */
points.get('/:id/points/logs', authMiddleware, async (c) => {
  const targetId = Number(c.req.param('id'))
  if (isNaN(targetId)) return c.json({ error: 'Invalid user ID' }, 400)

  const page = Math.max(1, Number(c.req.query('page')) || 1)
  const limit = Math.min(50, Math.max(1, Number(c.req.query('limit')) || 20))
  const offset = (page - 1) * limit

  const [countRow, rows] = await Promise.all([
    queryOne<{ cnt: number }>(
      c.env.abdl_space_db,
      'SELECT COUNT(*) as cnt FROM point_logs WHERE user_id = ?',
      [targetId]
    ),
    query<{ id: number; amount: number; type: string; related_id: number | null; source_type: string | null; source_id: number | null; description: string | null; created_at: string }>(
      c.env.abdl_space_db,
      `SELECT id, amount, type, related_id, source_type, source_id, description, created_at
       FROM point_logs WHERE user_id = ?
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [targetId, limit, offset]
    ),
  ])

  const total = countRow?.cnt || 0
  return c.json({
    logs: rows,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  })
})

/**
 * GET /api/users/:id/exp/logs — 经验流水
 */
points.get('/:id/exp/logs', authMiddleware, async (c) => {
  const targetId = Number(c.req.param('id'))
  if (isNaN(targetId)) return c.json({ error: 'Invalid user ID' }, 400)

  const page = Math.max(1, Number(c.req.query('page')) || 1)
  const limit = Math.min(50, Math.max(1, Number(c.req.query('limit')) || 20))
  const offset = (page - 1) * limit

  const [countRow, rows] = await Promise.all([
    queryOne<{ cnt: number }>(
      c.env.abdl_space_db,
      'SELECT COUNT(*) as cnt FROM exp_logs WHERE user_id = ?',
      [targetId]
    ),
    query<{ id: number; amount: number; type: string; related_id: number | null; source_type: string | null; source_id: number | null; description: string | null; created_at: string }>(
      c.env.abdl_space_db,
      `SELECT id, amount, type, related_id, source_type, source_id, description, created_at
       FROM exp_logs WHERE user_id = ?
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [targetId, limit, offset]
    ),
  ])

  const total = countRow?.cnt || 0
  return c.json({
    logs: rows,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  })
})

/**
 * GET /api/users/:id/level — 等级详情
 */
points.get('/:id/level', authMiddleware, async (c) => {
  const targetId = Number(c.req.param('id'))
  if (isNaN(targetId)) return c.json({ error: 'Invalid user ID' }, 400)

  const exp = await queryOne<{ current_exp: number; total_exp: number; current_level: number; current_streak: number }>(
    c.env.abdl_space_db,
    'SELECT current_exp, total_exp, current_level, current_streak FROM experience WHERE user_id = ?',
    [targetId]
  )

  if (!exp) {
    return c.json({
      user_id: targetId,
      level: 1,
      total_exp: 0,
      current_exp: 0,
      current_streak: 0,
      progress: { current: 0, needed: 100, progress: 0 },
      multipliers: { checkin: 1.0, points: 1.0 },
    })
  }

  const level = calcLevel(exp.total_exp)
  const progress = calcLevelProgress(exp.total_exp)

  return c.json({
    user_id: targetId,
    level,
    total_exp: exp.total_exp,
    current_exp: exp.current_exp,
    current_streak: exp.current_streak,
    progress,
    multipliers: {
      checkin: getCheckinMultiplier(level),
      points: getPointsMultiplier(level),
    },
  })
})

export default points
