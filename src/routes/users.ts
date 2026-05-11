import { Hono } from 'hono'
import type { Env, JWTPayload, UpdateUserRequest } from '../types/index.ts'
import { query, queryOne, run } from '../lib/db.ts'
import { authMiddleware } from '../middleware/auth.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const users = new Hono<AppType>()

const LEVEL_TABLE = [
  { level: 1, exp: 0, badge_name: '婴儿奶瓶', badge_icon: '🍼' },
  { level: 2, exp: 100, badge_name: '安抚奶嘴', badge_icon: '👶' },
  { level: 3, exp: 300, badge_name: '婴儿围兜', badge_icon: '🧣' },
  { level: 4, exp: 600, badge_name: '毛绒玩偶', badge_icon: '🧸' },
  { level: 5, exp: 1000, badge_name: '学步车', badge_icon: '🦽' },
  { level: 6, exp: 1500, badge_name: '小童床', badge_icon: '🛏️' },
  { level: 7, exp: 2100, badge_name: '儿童王座', badge_icon: '👑' },
]

function calcLevel(exp: number) {
  let current = LEVEL_TABLE[0]
  let next = LEVEL_TABLE[1] ?? LEVEL_TABLE[LEVEL_TABLE.length - 1]
  for (let i = LEVEL_TABLE.length - 1; i >= 0; i--) {
    if (exp >= LEVEL_TABLE[i].exp) {
      current = LEVEL_TABLE[i]
      next = LEVEL_TABLE[i + 1] ?? LEVEL_TABLE[i]
      break
    }
  }
  const progress = next.exp > current.exp ? Math.round((exp / next.exp) * 100) : 100
  return { ...current, next_level: next.level, next_exp_required: next.exp, progress }
}

/**
 * GET /api/users/:id — 用户公开信息
 */
users.get('/:id', async (c) => {
  const id = parseInt(c.req.param('id'))

  const user = await queryOne<Record<string, unknown>>(
    c.env.abdl_space_db,
    'SELECT id, username, role, avatar, age, region, style_preference, bio, created_at FROM users WHERE id = ?',
    [id]
  )
  if (!user) return c.json({ error: 'User not found' }, 404)

  return c.json({
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      avatar: user.avatar ?? null,
      age: user.age ?? null,
      region: user.region ?? null,
      style_preference: user.style_preference ?? null,
      bio: user.bio ?? null,
      created_at: user.created_at
    }
  })
})

/**
 * PATCH /api/users/me — 修改当前用户资料
 */
users.patch('/me', authMiddleware, async (c) => {
  const user = c.get('user')
  const body = await c.req.json<UpdateUserRequest>()

  const updates: string[] = []
  const params: unknown[] = []

  const fields: (keyof UpdateUserRequest)[] = ['avatar', 'age', 'region', 'weight', 'waist', 'hip', 'style_preference', 'bio']
  for (const field of fields) {
    if (body[field] !== undefined) {
      updates.push(`${field} = ?`)
      params.push(body[field])
    }
  }

  if (updates.length === 0) {
    const current = await queryOne<Record<string, unknown>>(
      c.env.abdl_space_db,
      'SELECT * FROM users WHERE id = ?',
      [user.sub]
    )
    if (!current) return c.json({ error: 'User not found' }, 404)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { password_hash, email_verified, ...safe } = current
    return c.json({ user: safe })
  }

  await run(
    c.env.abdl_space_db,
    `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
    [...params, user.sub]
  )

  const updated = await queryOne<Record<string, unknown>>(
    c.env.abdl_space_db,
    'SELECT * FROM users WHERE id = ?',
    [user.sub]
  )
  if (!updated) return c.json({ error: 'User not found' }, 404)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { password_hash, email_verified, ...safe } = updated
  return c.json({ user: safe })
})

/**
 * GET /api/users/:id/level — 用户等级/经验值
 */
users.get('/:id/level', async (c) => {
  const id = parseInt(c.req.param('id'))

  const exp = await queryOne<{ current_exp: number; total_exp: number; current_level: number }>(
    c.env.abdl_space_db,
    'SELECT current_exp, total_exp, current_level FROM experience WHERE user_id = ?',
    [id]
  )

  if (!exp) {
    const levelInfo = calcLevel(0)
    return c.json({ level: { ...levelInfo, exp: 0, total_exp: 0 } })
  }

  const levelInfo = calcLevel(exp.total_exp)
  return c.json({
    level: { ...levelInfo, exp: exp.current_exp, total_exp: exp.total_exp }
  })
})

/**
 * GET /api/users/:id/posts — 用户发的帖子
 */
users.get('/:id/posts', async (c) => {
  const id = parseInt(c.req.param('id'))
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20')))

  const posts = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT p.*, u.username, u.avatar, u.role
     FROM posts p JOIN users u ON p.user_id = u.id
     WHERE p.user_id = ?
     ORDER BY p.created_at DESC
     LIMIT ?`,
    [id, limit]
  )

  const postsList = await Promise.all(posts.map(async (r) => ({
    id: r.id,
    user: { id: r.user_id, username: r.username, avatar: r.avatar ?? null, role: r.role },
    content: r.content,
    diaper_id: r.diaper_id ?? null,
    pinned: !!r.pinned,
    like_count: 0,
    has_liked: false,
    comment_count: 0,
    created_at: r.created_at
  })))

  return c.json({ posts: postsList, pagination: { page: 1, limit, total: postsList.length, totalPages: 1 } })
})

/**
 * GET /api/users/:id/ratings — 用户的评分记录
 */
users.get('/:id/ratings', async (c) => {
  const id = parseInt(c.req.param('id'))

  const reviews = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT r.*, u.username, u.avatar, u.role
     FROM ratings r JOIN users u ON r.user_id = u.id
     WHERE r.user_id = ?
     ORDER BY r.created_at DESC`,
    [id]
  )

  return c.json({
    reviews: reviews.map(r => ({
      id: r.id,
      user: { id: r.user_id, username: r.username, avatar: r.avatar ?? null, role: r.role },
      diaper_id: r.diaper_id,
      absorption_score: r.absorption_score,
      fit_score: r.fit_score,
      comfort_score: r.comfort_score,
      thickness_score: r.thickness_score,
      appearance_score: r.appearance_score,
      value_score: r.value_score,
      review: r.review ?? null,
      review_status: r.review_status,
      created_at: r.created_at
    }))
  })
})

/**
 * GET /api/users/:id/feelings — 用户的感受记录
 */
users.get('/:id/feelings', async (c) => {
  const id = parseInt(c.req.param('id'))

  const feelings = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT f.*, u.username, u.avatar
     FROM feelings f JOIN users u ON f.user_id = u.id
     WHERE f.user_id = ?
     ORDER BY f.created_at DESC`,
    [id]
  )

  return c.json({
    feelings: feelings.map(f => ({
      id: f.id,
      user: { id: f.user_id, username: f.username, avatar: f.avatar ?? null },
      diaper_id: f.diaper_id,
      size: f.size,
      looseness: f.looseness,
      softness: f.softness,
      dryness: f.dryness,
      odor_control: f.odor_control,
      quietness: f.quietness,
      created_at: f.created_at
    }))
  })
})

export default users
