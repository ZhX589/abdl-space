import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { query, queryOne } from '../lib/db.ts'
import { authMiddleware } from '../middleware/auth.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const sync = new Hono<AppType>()

/**
 * GET /api/sync/bootstrap?since= — 移动端增量同步
 * 返回用户当前状态 + 增量变更
 */
sync.get('/bootstrap', authMiddleware, async (c) => {
  const user = c.get('user')
  const userId = user.sub
  const since = c.req.query('since') || '1970-01-01T00:00:00Z'

  // 并行查询用户数据
  const [userData, expData, pointsData, badgesData] = await Promise.all([
    queryOne<{
      id: number; username: string; email: string; avatar: string | null;
      role: string; created_at: string;
    }>(
      c.env.abdl_space_db,
      'SELECT id, username, email, avatar, role, created_at FROM users WHERE id = ?',
      [userId]
    ),
    queryOne<{
      current_exp: number; total_exp: number; current_level: number;
      newbie_rating_bonus_count: number; current_streak: number; last_checkin_date: string | null;
    }>(
      c.env.abdl_space_db,
      'SELECT current_exp, total_exp, current_level, newbie_rating_bonus_count, current_streak, last_checkin_date FROM experience WHERE user_id = ?',
      [userId]
    ),
    queryOne<{ balance: number; total_earned: number; total_spent: number }>(
      c.env.abdl_space_db,
      'SELECT balance, total_earned, total_spent FROM points WHERE user_id = ?',
      [userId]
    ),
    query<{ badge_key: string; unlocked_at: string; displayed: number }>(
      c.env.abdl_space_db,
      'SELECT badge_key, unlocked_at, displayed FROM user_badges WHERE user_id = ?',
      [userId]
    ),
  ])

  // 增量积分流水
  const pointLogs = await query<{
    id: number; amount: number; type: string; description: string | null; created_at: string;
  }>(
    c.env.abdl_space_db,
    `SELECT id, amount, type, description, created_at
     FROM point_logs WHERE user_id = ? AND created_at > ?
     ORDER BY created_at DESC LIMIT 100`,
    [userId, since]
  )

  // 增量经验流水
  const expLogs = await query<{
    id: number; amount: number; type: string; description: string | null; created_at: string;
  }>(
    c.env.abdl_space_db,
    `SELECT id, amount, type, description, created_at
     FROM exp_logs WHERE user_id = ? AND created_at > ?
     ORDER BY created_at DESC LIMIT 100`,
    [userId, since]
  )

  // 最近签到记录
  const recentCheckins = await query<{ checkin_date: string; type: string }>(
    c.env.abdl_space_db,
    `SELECT checkin_date, type FROM daily_checkins
     WHERE user_id = ? AND created_at > ?
     ORDER BY checkin_date DESC LIMIT 31`,
    [userId, since]
  )

  return c.json({
    user: userData,
    experience: expData || { current_exp: 0, total_exp: 0, current_level: 1, newbie_rating_bonus_count: 0, current_streak: 0, last_checkin_date: null },
    points: pointsData || { balance: 0, total_earned: 0, total_spent: 0 },
    badges: badgesData.map(b => ({ key: b.badge_key, unlocked_at: b.unlocked_at, displayed: b.displayed === 1 })),
    recent_checkins: recentCheckins,
    point_logs_delta: pointLogs,
    exp_logs_delta: expLogs,
    server_time: new Date().toISOString(),
  })
})

export default sync
