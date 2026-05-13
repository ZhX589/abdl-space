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

  if (body.avatar !== undefined) {
    if (typeof body.avatar === 'string' && body.avatar.length > 2048) {
      return c.json({ error: 'Avatar URL must be 2048 characters or less' }, 400)
    }
    updates.push('avatar = ?')
    params.push(body.avatar)
  }
  if (body.age !== undefined) {
    if (body.age !== null && (typeof body.age !== 'number' || body.age < 1 || body.age > 150)) {
      return c.json({ error: 'Age must be 1-150 or null' }, 400)
    }
    updates.push('age = ?')
    params.push(body.age)
  }
  if (body.region !== undefined) {
    if (typeof body.region === 'string' && body.region.length > 50) {
      return c.json({ error: 'Region must be 50 characters or less' }, 400)
    }
    updates.push('region = ?')
    params.push(body.region)
  }
  if (body.weight !== undefined) {
    if (body.weight !== null && (typeof body.weight !== 'number' || body.weight <= 0 || body.weight > 500)) {
      return c.json({ error: 'Weight must be >0 and <=500, or null' }, 400)
    }
    updates.push('weight = ?')
    params.push(body.weight)
  }
  if (body.waist !== undefined) {
    if (body.waist !== null && (typeof body.waist !== 'number' || body.waist <= 0 || body.waist > 300)) {
      return c.json({ error: 'Waist must be >0 and <=300, or null' }, 400)
    }
    updates.push('waist = ?')
    params.push(body.waist)
  }
  if (body.hip !== undefined) {
    if (body.hip !== null && (typeof body.hip !== 'number' || body.hip <= 0 || body.hip > 300)) {
      return c.json({ error: 'Hip must be >0 and <=300, or null' }, 400)
    }
    updates.push('hip = ?')
    params.push(body.hip)
  }
  if (body.style_preference !== undefined) {
    if (typeof body.style_preference === 'string' && body.style_preference.length > 100) {
      return c.json({ error: 'Style preference must be 100 characters or less' }, 400)
    }
    updates.push('style_preference = ?')
    params.push(body.style_preference)
  }
  if (body.bio !== undefined) {
    if (typeof body.bio === 'string' && body.bio.length > 500) {
      return c.json({ error: 'Bio must be 500 characters or less' }, 400)
    }
    updates.push('bio = ?')
    params.push(body.bio)
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

  const postsList = await Promise.all(posts.map(async (r) => {
    const likeCount = await queryOne<{ count: number }>(
      c.env.abdl_space_db,
      "SELECT COUNT(*) as count FROM likes WHERE target_type = 'post' AND target_id = ?",
      [r.id]
    )
    const commentCount = await queryOne<{ count: number }>(
      c.env.abdl_space_db,
      'SELECT COUNT(*) as count FROM post_comments WHERE post_id = ?',
      [r.id]
    )
    return {
      id: r.id,
      user: { id: r.user_id, username: r.username, avatar: r.avatar ?? null, role: r.role },
      content: r.content,
      diaper_id: r.diaper_id ?? null,
      pinned: !!r.pinned,
      like_count: likeCount?.count ?? 0,
      has_liked: false,
      comment_count: commentCount?.count ?? 0,
      created_at: r.created_at
    }
  }))

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
