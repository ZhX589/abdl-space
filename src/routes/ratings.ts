import { Hono } from 'hono'
import type { Env, JWTPayload, CreateRatingRequest } from '../types/index.ts'
import { queryOne, query, run } from '../lib/db.ts'
import { authMiddleware } from '../middleware/auth.ts'
import { calcLevel, getPointsMultiplier } from '../lib/level.ts'
import { getBeijingDate } from '../shared/time.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const ratings = new Hono<AppType>()

/**
 * POST /api/ratings — 创建评分
 */
ratings.post('/', authMiddleware, async (c) => {
  const user = c.get('user')
  const body = await c.req.json<CreateRatingRequest>()
  const { diaper_id, absorption_score, comfort_score, thickness_score, appearance_score, value_score, review } = body

  if (!diaper_id || absorption_score === undefined || comfort_score === undefined || thickness_score === undefined || appearance_score === undefined || value_score === undefined) {
    return c.json({ error: 'All score fields are required' }, 400)
  }

  const scores = [absorption_score, comfort_score, thickness_score, appearance_score, value_score]
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
    [user.sub, diaper_id, absorption_score, 0, comfort_score, thickness_score, appearance_score, value_score, review ?? null]
  )

  const ratingId = result.meta.last_row_id as number

  // 评价奖励：经验 +30，积分 +10
  const BASE_EXP = 30
  const BASE_POINTS = 10
  const today = getBeijingDate()

  // 检查每日评价奖励上限（最多 2 条）
  const todayRatingCount = await queryOne<{ cnt: number }>(
    c.env.abdl_space_db,
    "SELECT COUNT(*) as cnt FROM exp_logs WHERE user_id = ? AND type = 'rating' AND date(created_at) = date('now', 'localtime')",
    [user.sub]
  )

  const rewarded = (todayRatingCount?.cnt || 0) < 2 && review && review.length >= 10

  // 获取用户等级和积分倍率
  const exp = await queryOne<{ total_exp: number }>(
    c.env.abdl_space_db,
    'SELECT total_exp FROM experience WHERE user_id = ?',
    [user.sub]
  )
  const level = calcLevel(exp?.total_exp || 0)
  const pointsMultiplier = getPointsMultiplier(level)
  const actualPoints = Math.round(BASE_POINTS * pointsMultiplier)

  // 新手评价奖励（前 3 条）
  let newbieBonus = 0
  if (rewarded) {
    const newbieResult = await c.env.abdl_space_db.prepare(
      'UPDATE experience SET newbie_rating_bonus_count = newbie_rating_bonus_count + 1 WHERE user_id = ? AND newbie_rating_bonus_count < 3'
    ).bind(user.sub).run()
    if (newbieResult.meta.changes > 0) {
      newbieBonus = 5
    }
  }

  const totalExp = rewarded ? BASE_EXP + newbieBonus : 0
  let totalPoints = rewarded ? actualPoints : 0

  if (rewarded) {
    // 标记评价已奖励
    await run(c.env.abdl_space_db, 'UPDATE ratings SET rewarded = 1 WHERE id = ?', [ratingId])

    // 写经验流水和积分流水
    const batchOps = [
      c.env.abdl_space_db.prepare(
        'UPDATE experience SET current_exp = current_exp + ?, total_exp = total_exp + ? WHERE user_id = ?'
      ).bind(totalExp, totalExp, user.sub),
      c.env.abdl_space_db.prepare(
        'INSERT INTO exp_logs (user_id, amount, type, source_type, source_id, description) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(user.sub, BASE_EXP, 'rating', 'rating', ratingId, '评价纸尿裤'),
      c.env.abdl_space_db.prepare(
        'UPDATE points SET balance = balance + ?, total_earned = total_earned + ? WHERE user_id = ?'
      ).bind(totalPoints, totalPoints, user.sub),
      c.env.abdl_space_db.prepare(
        'INSERT INTO point_logs (user_id, amount, type, source_type, source_id, description) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(user.sub, totalPoints, 'rating', 'rating', ratingId, '评价纸尿裤'),
    ]

    if (newbieBonus > 0) {
      batchOps.push(
        c.env.abdl_space_db.prepare(
          'INSERT INTO exp_logs (user_id, amount, type, source_type, source_id, description) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(user.sub, newbieBonus, 'newbie_rating', 'rating', ratingId, '新手评价奖励')
      )
    }

    // 邀请首次评价 +50 积分（per-user 标志防刷）
    let inviteBonus = 0
    const inviteBonusResult = await c.env.abdl_space_db.prepare(
      'UPDATE users SET invite_first_rating_bonus_at = CURRENT_TIMESTAMP WHERE id = ? AND invite_first_rating_bonus_at IS NULL'
    ).bind(user.sub).run()
    if (inviteBonusResult.meta.changes > 0) {
      inviteBonus = 50
      batchOps.push(
        c.env.abdl_space_db.prepare(
          'UPDATE points SET balance = balance + ?, total_earned = total_earned + ? WHERE user_id = ?'
        ).bind(inviteBonus, inviteBonus, user.sub),
        c.env.abdl_space_db.prepare(
          "INSERT INTO point_logs (user_id, amount, type, source_type, source_id, description) VALUES (?, ?, 'invite_first_rating', 'rating', ?, '被邀请人首次评价奖励')"
        ).bind(user.sub, inviteBonus, ratingId)
      )
    }

    await c.env.abdl_space_db.batch(batchOps)

    // 更新 totalPoints 用于返回值
    totalPoints += inviteBonus
  }

  // 计算等级变化
  const newTotalExp = (exp?.total_exp || 0) + totalExp
  const newLevel = calcLevel(newTotalExp)
  const levelChange = newLevel > level ? { from: level, to: newLevel } : undefined

  return c.json({
    message: '评分成功',
    review_status: 'approved',
    id: ratingId,
    rewards: rewarded ? {
      total_exp: totalExp,
      total_points: totalPoints,
      level_change: levelChange,
      details: [
        { type: 'rating', amount: BASE_EXP, currency: 'exp' },
        { type: 'rating', amount: totalPoints, currency: 'points' },
        ...(newbieBonus > 0 ? [{ type: 'newbie_rating', amount: newbieBonus, currency: 'exp' }] : []),
        ...(inviteBonus > 0 ? [{ type: 'invite_first_rating', amount: inviteBonus, currency: 'points' }] : []),
      ],
    } : undefined,
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
 * DELETE /api/ratings/:id — 删除评分（含扣回）
 */
ratings.delete('/:id', authMiddleware, async (c) => {
  const user = c.get('user')
  const id = parseInt(c.req.param('id') || '')

  const rating = await queryOne<{ id: number; user_id: number; rewarded: number }>(
    c.env.abdl_space_db, 'SELECT id, user_id, rewarded FROM ratings WHERE id = ?', [id]
  )
  if (!rating) return c.json({ error: 'Rating not found' }, 404)
  if (user.role !== 'admin' && rating.user_id !== user.sub) {
    return c.json({ error: 'Not authorized' }, 403)
  }

  // 如果评价获得过奖励，扣回经验/积分
  if (rating.rewarded === 1) {
    // 查询该评价获得的经验/积分
    const expLogs = await query<{ amount: number }>(
      c.env.abdl_space_db,
      "SELECT amount FROM exp_logs WHERE user_id = ? AND source_type = 'rating' AND source_id = ?",
      [rating.user_id, id]
    )
    const pointLogs = await query<{ amount: number }>(
      c.env.abdl_space_db,
      "SELECT amount FROM point_logs WHERE user_id = ? AND source_type = 'rating' AND source_id = ?",
      [rating.user_id, id]
    )

    const totalExpDeduct = expLogs.reduce((sum, log) => sum + Math.abs(log.amount), 0)
    const totalPointDeduct = pointLogs.reduce((sum, log) => sum + Math.abs(log.amount), 0)

    const batchOps = [
      c.env.abdl_space_db.prepare('DELETE FROM ratings WHERE id = ?', [id]),
    ]

    if (totalExpDeduct > 0) {
      batchOps.push(
        c.env.abdl_space_db.prepare(
          'UPDATE experience SET current_exp = MAX(0, current_exp - ?), total_exp = MAX(0, total_exp - ?) WHERE user_id = ?'
        ).bind(totalExpDeduct, totalExpDeduct, rating.user_id),
        c.env.abdl_space_db.prepare(
          "INSERT INTO exp_logs (user_id, amount, type, source_type, source_id, description) VALUES (?, ?, 'rating_delete', 'rating', ?, '删评扣回')"
        ).bind(rating.user_id, -totalExpDeduct, id)
      )
    }
    if (totalPointDeduct > 0) {
      batchOps.push(
        c.env.abdl_space_db.prepare(
          'UPDATE points SET balance = MAX(0, balance - ?), total_spent = total_spent + ? WHERE user_id = ?'
        ).bind(totalPointDeduct, totalPointDeduct, rating.user_id),
        c.env.abdl_space_db.prepare(
          "INSERT INTO point_logs (user_id, amount, type, source_type, source_id, description) VALUES (?, ?, 'rating_delete', 'rating', ?, '删评扣回')"
        ).bind(rating.user_id, -totalPointDeduct, id)
      )
    }

    await c.env.abdl_space_db.batch(batchOps)
  } else {
    await run(c.env.abdl_space_db, 'DELETE FROM ratings WHERE id = ?', [id])
  }

  return c.json({ message: '删除成功' })
})

export default ratings
