import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { query, queryOne, run } from '../lib/db.ts'
import { authMiddleware } from '../middleware/auth.ts'
import { getBeijingDate } from '../shared/time.ts'
import { calcLevel, getCheckinMultiplier } from '../lib/level.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const checkin = new Hono<AppType>()

// 基础签到积分
const BASE_CHECKIN_POINTS = 10
// 基础签到经验
const BASE_CHECKIN_EXP = 10
// 连续签到奖励
const STREAK_7_BONUS = 20
const STREAK_30_BONUS = 100
// 补签卡积分消耗
const MAKEUP_COST = 50

/**
 * POST /api/checkin — 每日签到
 */
checkin.post('/', authMiddleware, async (c) => {
  const user = c.get('user')
  const userId = user.sub
  const today = getBeijingDate()

  // 检查今天是否已签到
  const existing = await queryOne<{ id: number }>(
    c.env.abdl_space_db,
    'SELECT id FROM daily_checkins WHERE user_id = ? AND checkin_date = ?',
    [userId, today]
  )
  if (existing) {
    return c.json({ error: '今天已经签到过了' }, 409)
  }

  // 获取用户经验和等级
  const exp = await queryOne<{ total_exp: number; current_exp: number; current_level: number; current_streak: number; last_checkin_date: string | null }>(
    c.env.abdl_space_db,
    'SELECT total_exp, current_exp, current_level, current_streak, last_checkin_date FROM experience WHERE user_id = ?',
    [userId]
  )

  if (!exp) {
    return c.json({ error: '用户经验数据不存在' }, 500)
  }

  const level = calcLevel(exp.total_exp)
  const multiplier = getCheckinMultiplier(level)
  const basePoints = Math.round(BASE_CHECKIN_POINTS * multiplier)

  // 动态计算 streak（只计算 normal 类型的签到，不含补签）
  const normalCheckins = await query<{ checkin_date: string }>(
    c.env.abdl_space_db,
    `SELECT checkin_date FROM daily_checkins
     WHERE user_id = ? AND type = 'normal'
     ORDER BY checkin_date DESC LIMIT 31`,
    [userId]
  )

  let realStreak = 0
  const checkinDates = new Set(normalCheckins.map(r => r.checkin_date))
  let checkDate = new Date()
  // 从昨天开始算（今天还没签到）
  checkDate = new Date(Date.now() - 86400000)
  for (let i = 0; i < 31; i++) {
    const dateStr = getBeijingDate(checkDate)
    if (checkinDates.has(dateStr)) {
      realStreak++
      checkDate = new Date(checkDate.getTime() - 86400000)
    } else {
      break
    }
  }

  const newStreak = realStreak + 1 // 加上今天的签到

  // 连续签到奖励（只基于 real streak，不含补签）
  let streakBonus = 0
  let streakBonusType = ''
  if (newStreak === 7) {
    streakBonus = STREAK_7_BONUS
    streakBonusType = 'checkin_streak_7'
  } else if (newStreak === 30) {
    streakBonus = STREAK_30_BONUS
    streakBonusType = 'checkin_streak_30'
  }

  const totalPoints = basePoints + streakBonus

  // 事务：写签到记录 + 更新积分 + 更新经验 + 更新 streak
  const batchOps = [
    // 插入签到记录
    c.env.abdl_space_db.prepare(
      'INSERT INTO daily_checkins (user_id, checkin_date, type) VALUES (?, ?, ?)'
    ).bind(userId, today, 'normal'),

    // 更新积分余额
    c.env.abdl_space_db.prepare(
      'UPDATE points SET balance = balance + ?, total_earned = total_earned + ? WHERE user_id = ?'
    ).bind(totalPoints, totalPoints, userId),

    // 写积分流水 - 基础签到
    c.env.abdl_space_db.prepare(
      'INSERT INTO point_logs (user_id, amount, type, description) VALUES (?, ?, ?, ?)'
    ).bind(userId, basePoints, 'checkin', `每日签到 ×${multiplier}`),

    // 更新经验
    c.env.abdl_space_db.prepare(
      'UPDATE experience SET current_exp = current_exp + ?, total_exp = total_exp + ?, current_streak = ?, last_checkin_date = ? WHERE user_id = ?'
    ).bind(BASE_CHECKIN_EXP, BASE_CHECKIN_EXP, newStreak, today, userId),

    // 写经验流水
    c.env.abdl_space_db.prepare(
      'INSERT INTO exp_logs (user_id, amount, type, description) VALUES (?, ?, ?, ?)'
    ).bind(userId, BASE_CHECKIN_EXP, 'checkin', '每日签到'),
  ]

  // 如果有连续签到奖励，额外写流水
  if (streakBonus > 0) {
    batchOps.push(
      c.env.abdl_space_db.prepare(
        'UPDATE points SET balance = balance + ?, total_earned = total_earned + ? WHERE user_id = ?'
      ).bind(streakBonus, streakBonus, userId),
      c.env.abdl_space_db.prepare(
        'INSERT INTO point_logs (user_id, amount, type, description) VALUES (?, ?, ?, ?)'
      ).bind(userId, streakBonus, streakBonusType, `连续签到 ${newStreak} 天奖励`),
    )
  }

  await c.env.abdl_space_db.batch(batchOps)

  // 计算等级变化
  const newTotalExp = exp.total_exp + BASE_CHECKIN_EXP
  const newLevel = calcLevel(newTotalExp)
  const levelChange = newLevel > level ? { from: level, to: newLevel } : undefined

  return c.json({
    success: true,
    data: {
      checkin_date: today,
      streak: newStreak,
      points_earned: totalPoints,
      exp_earned: BASE_CHECKIN_EXP,
      streak_bonus: streakBonus,
    },
    rewards: {
      total_exp: BASE_CHECKIN_EXP,
      total_points: totalPoints,
      level_change: levelChange,
      details: [
        { type: 'checkin', amount: basePoints, currency: 'points' },
        { type: 'checkin', amount: BASE_CHECKIN_EXP, currency: 'exp' },
        ...(streakBonus > 0 ? [{ type: streakBonusType, amount: streakBonus, currency: 'points' }] : []),
      ],
    },
  })
})

/**
 * GET /api/checkin/status — 签到状态（JS 动态算 streak）
 */
checkin.get('/status', authMiddleware, async (c) => {
  const user = c.get('user')
  const userId = user.sub
  const today = getBeijingDate()

  // 查今天是否已签到
  const todayRecord = await queryOne<{ id: number }>(
    c.env.abdl_space_db,
    'SELECT id FROM daily_checkins WHERE user_id = ? AND checkin_date = ?',
    [userId, today]
  )

  // 查经验表获取 streak 信息
  const exp = await queryOne<{ current_streak: number; last_checkin_date: string | null }>(
    c.env.abdl_space_db,
    'SELECT current_streak, last_checkin_date FROM experience WHERE user_id = ?',
    [userId]
  )

  // 动态计算 streak（查最近 31 天）
  const rows = await query<{ checkin_date: string; type: string }>(
    c.env.abdl_space_db,
    `SELECT checkin_date, type FROM daily_checkins
     WHERE user_id = ? AND checkin_date >= date(?, '-31 days')
     ORDER BY checkin_date DESC`,
    [userId, today]
  )

  // 计算连续签到天数
  let streak = 0
  const checkinDates = new Set(rows.map(r => r.checkin_date))
  let checkDate = new Date()
  // 如果今天没签到，从昨天开始算
  if (!checkinDates.has(today)) {
    checkDate = new Date(Date.now() - 86400000)
  }
  for (let i = 0; i < 31; i++) {
    const dateStr = getBeijingDate(checkDate)
    if (checkinDates.has(dateStr)) {
      streak++
      checkDate = new Date(checkDate.getTime() - 86400000)
    } else {
      break
    }
  }

  return c.json({
    checked_in_today: !!todayRecord,
    streak,
    last_checkin_date: exp?.last_checkin_date || null,
  })
})

/**
 * POST /api/checkin/makeup — 补签（消耗 50 积分，断签次日 23:59:59 前）
 */
checkin.post('/makeup', authMiddleware, async (c) => {
  const user = c.get('user')
  const userId = user.sub
  const today = getBeijingDate()

  const body = await c.req.json<{ target_date: string }>()
  const { target_date } = body

  if (!target_date) {
    return c.json({ error: 'target_date is required (YYYY-MM-DD)' }, 400)
  }

  // 验证日期格式
  if (!/^\d{4}-\d{2}-\d{2}$/.test(target_date)) {
    return c.json({ error: '日期格式无效' }, 400)
  }

  // 验证目标日期：只能补昨天（断签次日）
  const yesterday = getBeijingDate(new Date(Date.now() - 86400000))
  if (target_date !== yesterday) {
    return c.json({ error: '只能补签昨天的签到' }, 400)
  }

  // 检查是否已签到
  const existing = await queryOne<{ id: number }>(
    c.env.abdl_space_db,
    'SELECT id FROM daily_checkins WHERE user_id = ? AND checkin_date = ?',
    [userId, target_date]
  )
  if (existing) {
    return c.json({ error: '该日期已签到' }, 409)
  }

  // 检查积分余额
  const points = await queryOne<{ balance: number }>(
    c.env.abdl_space_db,
    'SELECT balance FROM points WHERE user_id = ?',
    [userId]
  )
  if (!points || points.balance < MAKEUP_COST) {
    return c.json({ error: '积分不足', required: MAKEUP_COST, current: points?.balance || 0 }, 400)
  }

  // 执行补签
  await c.env.abdl_space_db.batch([
    // 插入补签记录
    c.env.abdl_space_db.prepare(
      'INSERT INTO daily_checkins (user_id, checkin_date, type) VALUES (?, ?, ?)'
    ).bind(userId, target_date, 'makeup'),

    // 扣除积分
    c.env.abdl_space_db.prepare(
      'UPDATE points SET balance = balance - ?, total_spent = total_spent + ? WHERE user_id = ?'
    ).bind(MAKEUP_COST, MAKEUP_COST, userId),

    // 写积分流水
    c.env.abdl_space_db.prepare(
      'INSERT INTO point_logs (user_id, amount, type, description) VALUES (?, ?, ?, ?)'
    ).bind(userId, -MAKEUP_COST, 'makeup_checkin', `补签 ${target_date}`),
  ])

  // 重算 streak（查最近 60 天）
  const rows = await query<{ checkin_date: string }>(
    c.env.abdl_space_db,
    `SELECT checkin_date FROM daily_checkins
     WHERE user_id = ? AND checkin_date >= date(?, '-60 days')
     ORDER BY checkin_date DESC`,
    [userId, today]
  )

  let newStreak = 0
  const checkinDates = new Set(rows.map(r => r.checkin_date))
  let checkDate = new Date()
  if (!checkinDates.has(today)) {
    checkDate = new Date(Date.now() - 86400000)
  }
  for (let i = 0; i < 60; i++) {
    const dateStr = getBeijingDate(checkDate)
    if (checkinDates.has(dateStr)) {
      newStreak++
      checkDate = new Date(checkDate.getTime() - 86400000)
    } else {
      break
    }
  }

  // 更新 streak
  await run(
    c.env.abdl_space_db,
    'UPDATE experience SET current_streak = ? WHERE user_id = ?',
    [newStreak, userId]
  )

  // 检查是否触发连续签到奖励
  let streakBonus = 0
  if (newStreak === 7 || newStreak === 30) {
    streakBonus = newStreak === 7 ? STREAK_7_BONUS : STREAK_30_BONUS
    const bonusType = newStreak === 7 ? 'checkin_streak_7' : 'checkin_streak_30'
    await c.env.abdl_space_db.batch([
      c.env.abdl_space_db.prepare(
        'UPDATE points SET balance = balance + ?, total_earned = total_earned + ? WHERE user_id = ?'
      ).bind(streakBonus, streakBonus, userId),
      c.env.abdl_space_db.prepare(
        'INSERT INTO point_logs (user_id, amount, type, description) VALUES (?, ?, ?, ?)'
      ).bind(userId, streakBonus, bonusType, `补签后连续 ${newStreak} 天奖励`),
    ])
  }

  return c.json({
    success: true,
    data: {
      makeup_date: target_date,
      cost: MAKEUP_COST,
      streak: newStreak,
      streak_bonus: streakBonus,
    },
  })
})

export default checkin
