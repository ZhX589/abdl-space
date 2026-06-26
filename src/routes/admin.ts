import { Hono } from 'hono'
const DEFAULT_AVATAR = 'https://img.abdl-space.top/file/system/1781439303787_play_store_512.png'
import type { Env, JWTPayload } from '../types/index.ts'
import { query, queryOne, run } from '../lib/db.ts'
import { adminMiddleware } from '../middleware/auth.ts'

const IMGBED_URL = 'https://img.abdl-space.top'

async function deleteImageFromImgbed(env: Env, imageUrl: string) {
  const deleteKey = env.IMGBED_DELETE_KEY
  if (!deleteKey) return
  let src = imageUrl
  try {
    const parsed = new URL(imageUrl)
    src = parsed.pathname
  } catch {
    if (!imageUrl.startsWith('/file/')) src = `/file/${imageUrl}`
  }
  try {
    await fetch(`${IMGBED_URL}/api/manage/delete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${deleteKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ src }),
    })
  } catch {}
}

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const admin = new Hono<AppType>()

/**
 * GET /api/admin/stats — 站点统计
 */
admin.get('/stats', adminMiddleware, async (c) => {
  const [users, posts, comments, diapers, ratings, appUsers] = await Promise.all([
    queryOne<{ count: number }>(c.env.abdl_space_db, 'SELECT COUNT(*) as count FROM users'),
    queryOne<{ count: number }>(c.env.abdl_space_db, 'SELECT COUNT(*) as count FROM posts'),
    queryOne<{ count: number }>(c.env.abdl_space_db, 'SELECT COUNT(*) as count FROM post_comments'),
    queryOne<{ count: number }>(c.env.abdl_space_db, 'SELECT COUNT(*) as count FROM diapers'),
    queryOne<{ count: number }>(c.env.abdl_space_db, 'SELECT COUNT(*) as count FROM ratings'),
    queryOne<{ count: number }>(c.env.abdl_space_db, 'SELECT COUNT(*) as count FROM users WHERE has_app = 1'),
  ])

  return c.json({
    users: users?.count ?? 0,
    posts: posts?.count ?? 0,
    comments: comments?.count ?? 0,
    diapers: diapers?.count ?? 0,
    ratings: ratings?.count ?? 0,
    appUsers: appUsers?.count ?? 0
  })
})

/**
 * GET /api/admin/users — 用户列表
 */
admin.get('/users', adminMiddleware, async (c) => {
  const rows = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    'SELECT id, email, username, role, avatar, email_verified, created_at FROM users ORDER BY id'
  )

  return c.json({
    users: rows.map(r => ({
      id: r.id,
      email: r.email,
      username: r.username,
      role: r.role,
      avatar: r.avatar ?? DEFAULT_AVATAR,
      email_verified: r.email_verified,
      created_at: r.created_at
    }))
  })
})

/**
 * DELETE /api/admin/users/:id — 删除用户
 */
admin.delete('/users/:id', adminMiddleware, async (c) => {
  const id = parseInt(c.req.param('id') || '')
  const currentUser = c.get('user')

  // BUG-181: Prevent admin from deleting themselves
  if (id === currentUser.sub) {
    return c.json({ error: '不能删除自己的账户' }, 400)
  }

  const user = await queryOne<{ id: number }>(c.env.abdl_space_db, 'SELECT id FROM users WHERE id = ?', [id])
  if (!user) return c.json({ error: 'User not found' }, 404)

  const db = c.env.abdl_space_db

  // 级联删除所有关联数据
  await run(db, 'DELETE FROM post_comments WHERE user_id = ?', [id])
  await run(db, 'DELETE FROM likes WHERE user_id = ?', [id])
  await run(db, 'DELETE FROM ratings WHERE user_id = ?', [id])
  await run(db, 'DELETE FROM feelings WHERE user_id = ?', [id])
  await run(db, 'DELETE FROM notifications WHERE user_id = ?', [id])
  await run(db, 'DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?', [id, id])
  await run(db, 'DELETE FROM follows WHERE follower_id = ? OR following_id = ?', [id, id])
  await run(db, 'DELETE FROM user_settings WHERE user_id = ?', [id])
  await run(db, 'DELETE FROM experience WHERE user_id = ?', [id])
  await run(db, 'DELETE FROM reports WHERE user_id = ? OR reporter_id = ?', [id, id])
  // 删除 OAuth tokens 和 clients
  await run(db, 'DELETE FROM oauth_tokens WHERE user_id = ?', [id])
  await run(db, 'DELETE FROM oauth_clients WHERE owner_id = ?', [id])
  // 删除用户帖子的图片
  const userPosts = await query<{ id: number }>(db, 'SELECT id FROM posts WHERE user_id = ?', [id])
  for (const post of userPosts) {
    await run(db, 'DELETE FROM post_images WHERE post_id = ?', [post.id])
  }
  await run(db, 'DELETE FROM posts WHERE user_id = ?', [id])
  // 删除验证码记录
  await run(db, 'DELETE FROM email_verifications WHERE user_id = ?', [id])
  // 删除用户
  await run(db, 'DELETE FROM users WHERE id = ?', [id])
  return c.json({ message: '已删除' })
})

/**
 * POST /api/admin/users/:id/ban — 封禁/解封（toggle）
 */
admin.post('/users/:id/ban', adminMiddleware, async (c) => {
  const id = parseInt(c.req.param('id') || '')

  const user = await queryOne<{ id: number; email: string }>(
    c.env.abdl_space_db, 'SELECT id, email FROM users WHERE id = ?', [id]
  )
  if (!user) return c.json({ error: 'User not found' }, 404)

  const hasBannedColumn = await queryOne<{ cid: number }>(
    c.env.abdl_space_db,
    "SELECT cid FROM pragma_table_info('users') WHERE name = 'banned'"
  )
  if (!hasBannedColumn) {
    await run(c.env.abdl_space_db, 'ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0')
  }

  const current = await queryOne<{ banned: number }>(
    c.env.abdl_space_db, 'SELECT banned FROM users WHERE id = ?', [id]
  )
  const newBanned = current?.banned ? 0 : 1
  await run(c.env.abdl_space_db, 'UPDATE users SET banned = ? WHERE id = ?', [newBanned, id])

  return c.json({ banned: !!newBanned })
})

/**
 * GET /api/admin/posts — 管理员帖子列表
 */
admin.get('/posts', adminMiddleware, async (c) => {
  const rows = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT p.id, p.content, p.pinned, p.created_at, p.has_nsfw,
            u.username, u.avatar, u.role,
            (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
            (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comment_count
     FROM posts p JOIN users u ON p.user_id = u.id
     ORDER BY p.created_at DESC LIMIT 100`
  )
  return c.json({
    posts: rows.map(r => ({
      id: r.id, content: r.content, pinned: !!r.pinned, has_nsfw: !!r.has_nsfw,
      user: { username: r.username, avatar: r.avatar ?? DEFAULT_AVATAR, role: r.role },
      like_count: r.like_count, comment_count: r.comment_count, created_at: r.created_at
    }))
  })
})

/**
 * POST /api/admin/posts/:id/pin — 置顶/取消置顶
 */
admin.post('/posts/:id/pin', adminMiddleware, async (c) => {
  const id = parseInt(c.req.param('id') || '')

  const post = await queryOne<{ id: number; pinned: number }>(
    c.env.abdl_space_db, 'SELECT id, pinned FROM posts WHERE id = ?', [id]
  )
  if (!post) return c.json({ error: 'Post not found' }, 404)

  const newPinned = post.pinned ? 0 : 1
  await run(c.env.abdl_space_db, 'UPDATE posts SET pinned = ? WHERE id = ?', [newPinned, id])

  return c.json({ pinned: !!newPinned })
})

/**
 * DELETE /api/admin/posts/:id — 删除帖子
 */
admin.delete('/posts/:id', adminMiddleware, async (c) => {
  const id = parseInt(c.req.param('id') || '')

  const post = await queryOne<{ id: number }>(c.env.abdl_space_db, 'SELECT id FROM posts WHERE id = ?', [id])
  if (!post) return c.json({ error: 'Post not found' }, 404)

  // Clean up related data first
  await run(c.env.abdl_space_db, "DELETE FROM likes WHERE target_type = 'post' AND target_id = ?", [id])
  await run(c.env.abdl_space_db, 'DELETE FROM post_images WHERE post_id = ?', [id])
  // Clean up comment likes
  const comments = await query<{ id: number }>(c.env.abdl_space_db, 'SELECT id FROM post_comments WHERE post_id = ?', [id])
  for (const cmt of comments) {
    await run(c.env.abdl_space_db, "DELETE FROM likes WHERE target_type = 'comment' AND target_id = ?", [cmt.id])
  }
  await run(c.env.abdl_space_db, 'DELETE FROM post_comments WHERE post_id = ?', [id])
  await run(c.env.abdl_space_db, 'DELETE FROM posts WHERE id = ?', [id])
  return c.json({ message: '已删除' })
})

/**
 * DELETE /api/admin/comments/:id — 删除评论
 */
admin.delete('/comments/:id', adminMiddleware, async (c) => {
  const id = parseInt(c.req.param('id') || '')

  const comment = await queryOne<{ id: number }>(c.env.abdl_space_db, 'SELECT id FROM post_comments WHERE id = ?', [id])
  if (!comment) return c.json({ error: 'Comment not found' }, 404)

  // 删除图床图片
  const commentImages = await query<{ image_url: string }>(
    c.env.abdl_space_db, 'SELECT image_url FROM comment_images WHERE comment_id = ?', [id]
  )
  for (const img of commentImages) {
    await deleteImageFromImgbed(c.env, img.image_url)
  }

  await run(c.env.abdl_space_db, 'DELETE FROM post_comments WHERE id = ?', [id])
  return c.json({ message: '已删除' })
})

/**
 * DELETE /api/admin/diapers/:id — 删除纸尿裤
 */
admin.delete('/diapers/:id', adminMiddleware, async (c) => {
  const id = parseInt(c.req.param('id') || '')
  if (!id) return c.json({ error: 'Invalid id' }, 400)

  const diaper = await queryOne<{ id: number }>(c.env.abdl_space_db, 'SELECT id FROM diapers WHERE id = ?', [id])
  if (!diaper) return c.json({ error: 'Diaper not found', id }, 404)

  try {
    const images = await query<{ image_url: string }>(c.env.abdl_space_db, 'SELECT image_url FROM diaper_images WHERE diaper_id = ?', [id])
    for (const img of images) {
      await deleteImageFromImgbed(c.env, img.image_url)
    }
    await run(c.env.abdl_space_db, 'DELETE FROM diaper_images WHERE diaper_id = ?', [id])
    await run(c.env.abdl_space_db, 'DELETE FROM diaper_sizes WHERE diaper_id = ?', [id])
    await run(c.env.abdl_space_db, 'DELETE FROM diapers WHERE id = ?', [id])
    return c.json({ message: '已删除' })
  } catch (e) {
    console.error('Delete diaper error:', e)
    return c.json({ error: '删除失败' }, 500)
  }
})

/**
 * GET /api/admin/diapers — 纸尿裤列表（管理用）
 */
admin.get('/diapers', adminMiddleware, async (c) => {
  const rows = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT d.*, GROUP_CONCAT(di.image_url) as image_urls
     FROM diapers d
     LEFT JOIN diaper_images di ON di.diaper_id = d.id
     GROUP BY d.id
     ORDER BY d.created_at DESC`
  )
  const ids = rows.map(r => r.id as number)
  const sizesMap = new Map<number, { label: string; waist_min: number; waist_max: number; hip_min: number; hip_max: number }[]>()
  const imagesMap = new Map<number, string[]>()
  if (ids.length > 0) {
    const ph = ids.map(() => '?').join(',')
    const [sizes, images] = await Promise.all([
      query<{ diaper_id: number; label: string; waist_min: number; waist_max: number; hip_min: number; hip_max: number }>(c.env.abdl_space_db, `SELECT * FROM diaper_sizes WHERE diaper_id IN (${ph})`, ids),
      query<{ diaper_id: number; image_url: string }>(c.env.abdl_space_db, `SELECT diaper_id, image_url FROM diaper_images WHERE diaper_id IN (${ph}) ORDER BY sort_order`, ids),
    ])
    for (const s of sizes) { if (!sizesMap.has(s.diaper_id)) sizesMap.set(s.diaper_id, []); sizesMap.get(s.diaper_id)!.push(s); }
    for (const img of images) { if (!imagesMap.has(img.diaper_id)) imagesMap.set(img.diaper_id, []); imagesMap.get(img.diaper_id)!.push(img.image_url); }
  }
  const diapers = rows.map(r => ({
    ...r,
    images: imagesMap.get(r.id as number) || [],
    sizes: sizesMap.get(r.id as number) || [],
    image_urls: undefined,
  }))
  return c.json({ diapers })
})

/**
 * POST /api/admin/diapers — 创建纸尿裤
 */
admin.post('/diapers', adminMiddleware, async (c) => {
  const body = await c.req.json<{
    brand: string; model: string; product_type: string;
    absorbency_mfr: string; absorbency_adult: string;
    is_baby_diaper: number; material: string; features: string; avg_price: string; official_url?: string;
    images?: string[];
    sizes?: { label: string; waist_min: number; waist_max: number; hip_min: number; hip_max: number }[];
  }>()

  if (!body.brand || !body.model || !body.product_type) {
    return c.json({ error: '品牌、型号、产品类型为必填' }, 400)
  }

  const result = await run(
    c.env.abdl_space_db,
    `INSERT INTO diapers (brand, model, product_type, thickness, absorbency_mfr, absorbency_adult, is_baby_diaper, material, features, avg_price, official_url)
     VALUES (?, ?, ?, 3, ?, ?, ?, ?, ?, ?, ?)`,
    [body.brand, body.model, body.product_type, body.absorbency_mfr || '', body.absorbency_adult || '', body.is_baby_diaper || 0, body.material || '', body.features || '', body.avg_price || '', body.official_url || '']
  )
  const diaperId = result.meta.last_row_id as number

  // 添加图片
  if (body.images && body.images.length > 0) {
    for (let i = 0; i < body.images.length; i++) {
      await run(c.env.abdl_space_db, 'INSERT INTO diaper_images (diaper_id, image_url, sort_order) VALUES (?, ?, ?)', [diaperId, body.images[i], i])
    }
  }

  // 添加尺码
  if (body.sizes && body.sizes.length > 0) {
    for (const s of body.sizes) {
      await run(c.env.abdl_space_db, 'INSERT INTO diaper_sizes (diaper_id, label, waist_min, waist_max, hip_min, hip_max) VALUES (?, ?, ?, ?, ?, ?)', [diaperId, s.label, s.waist_min, s.waist_max, s.hip_min, s.hip_max])
    }
  }

  return c.json({ id: diaperId, message: '创建成功' }, 201)
})

/**
 * PATCH /api/admin/diapers/:id — 更新纸尿裤
 */
admin.patch('/diapers/:id', adminMiddleware, async (c) => {
  const id = parseInt(c.req.param('id') || '')
  const body = await c.req.json<Partial<{
    brand: string; model: string; product_type: string;
    absorbency_mfr: string; absorbency_adult: string;
    is_baby_diaper: number; material: string; features: string; avg_price: string;
    images: string[];
    sizes: { label: string; waist_min: number; waist_max: number; hip_min: number; hip_max: number }[];
  }>>()

  const diaper = await queryOne<{ id: number }>(c.env.abdl_space_db, 'SELECT id FROM diapers WHERE id = ?', [id])
  if (!diaper) return c.json({ error: 'Diaper not found' }, 404)

  // 更新基本信息
  const fields: string[] = []
  const values: unknown[] = []
  for (const key of ['brand', 'model', 'product_type', 'absorbency_mfr', 'absorbency_adult', 'is_baby_diaper', 'material', 'features', 'avg_price', 'official_url']) {
    if (key in body) {
      fields.push(`${key} = ?`)
      values.push((body as Record<string, unknown>)[key])
    }
  }
  if (fields.length > 0) {
    values.push(id)
    await run(c.env.abdl_space_db, `UPDATE diapers SET ${fields.join(', ')} WHERE id = ?`, values)
  }

  // 更新图片（如果有传）
  if (body.images) {
    const oldImages = await query<{ image_url: string }>(c.env.abdl_space_db, 'SELECT image_url FROM diaper_images WHERE diaper_id = ?', [id])
    for (const img of oldImages) {
      await deleteImageFromImgbed(c.env, img.image_url)
    }
    await run(c.env.abdl_space_db, 'DELETE FROM diaper_images WHERE diaper_id = ?', [id])
    for (let i = 0; i < body.images.length; i++) {
      await run(c.env.abdl_space_db, 'INSERT INTO diaper_images (diaper_id, image_url, sort_order) VALUES (?, ?, ?)', [id, body.images[i], i])
    }
  }

  // 更新尺码（如果有传）
  if (body.sizes) {
    await run(c.env.abdl_space_db, 'DELETE FROM diaper_sizes WHERE diaper_id = ?', [id])
    for (const s of body.sizes) {
      await run(c.env.abdl_space_db, 'INSERT INTO diaper_sizes (diaper_id, label, waist_min, waist_max, hip_min, hip_max) VALUES (?, ?, ?, ?, ?, ?)', [id, s.label, s.waist_min, s.waist_max, s.hip_min, s.hip_max])
    }
  }

  return c.json({ message: '更新成功' })
})

// ===== 品牌管理 =====

/**
 * GET /api/admin/brands — 品牌列表
 */
admin.get('/brands', adminMiddleware, async (c) => {
  const rows = await query<{ id: number; name: string; logo: string; invert_dark: number; invert_light: number; created_at: string }>(
    c.env.abdl_space_db,
    'SELECT id, name, logo, invert_dark, invert_light, created_at FROM brands ORDER BY name'
  )
  return c.json({ brands: rows.map(r => ({ ...r, logo: r.logo || null, invert_dark: !!r.invert_dark, invert_light: !!r.invert_light })) })
})

/**
 * POST /api/admin/brands — 创建/更新品牌
 * { name, logo? }
 */
admin.post('/brands', adminMiddleware, async (c) => {
  const body = await c.req.json<{ name: string; logo?: string; invert_dark?: boolean; invert_light?: boolean }>()
  if (!body.name?.trim()) return c.json({ error: '品牌名称为必填' }, 400)

  const existing = await queryOne<{ id: number }>(
    c.env.abdl_space_db, 'SELECT id FROM brands WHERE name = ?', [body.name.trim()]
  )
  if (existing) {
    await run(c.env.abdl_space_db, 'UPDATE brands SET logo = ?, invert_dark = ?, invert_light = ? WHERE id = ?', [body.logo || '', body.invert_dark ? 1 : 0, body.invert_light ? 1 : 0, existing.id])
    return c.json({ id: existing.id, message: '更新成功' })
  }
  const result = await run(c.env.abdl_space_db, 'INSERT INTO brands (name, logo, invert_dark, invert_light) VALUES (?, ?, ?, ?)', [body.name.trim(), body.logo || '', body.invert_dark ? 1 : 0, body.invert_light ? 1 : 0])
  return c.json({ id: result.meta.last_row_id, message: '创建成功' }, 201)
})

/**
 * DELETE /api/admin/brands/:id
 */
admin.delete('/brands/:id', adminMiddleware, async (c) => {
  const id = parseInt(c.req.param('id') || '')
  const brand = await queryOne<{ id: number; logo: string }>(c.env.abdl_space_db, 'SELECT id, logo FROM brands WHERE id = ?', [id])
  if (!brand) return c.json({ error: '品牌不存在' }, 404)
  if (brand.logo) { try { await deleteImageFromImgbed(c.env, brand.logo); } catch { /* ignore */ } }
  await run(c.env.abdl_space_db, 'DELETE FROM brands WHERE id = ?', [id])
  return c.json({ message: '删除成功' })
})

// ============================================================
// GET /api/admin/security/logs — 安全日志列表
// ============================================================
admin.get('/security/logs', adminMiddleware, async (c) => {
  const db = c.env.abdl_space_db
  const page = Number(c.req.query('page') || '1')
  const limit = Math.min(Number(c.req.query('limit') || '50'), 200)
  const eventType = c.req.query('type') || ''
  const offset = (page - 1) * limit

  let where = '1=1'
  const params: any[] = []
  if (eventType) { where += ' AND event_type = ?'; params.push(eventType) }

  const total = await queryOne<{ cnt: number }>(db, `SELECT COUNT(*) as cnt FROM security_logs WHERE ${where}`, params)
  const logs = await query(db,
    `SELECT * FROM security_logs WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  )
  return c.json({ logs, total: total?.cnt || 0, page, limit })
})

// ============================================================
// GET /api/admin/security/stats — 安全统计
// ============================================================
admin.get('/security/stats', adminMiddleware, async (c) => {
  const db = c.env.abdl_space_db
  const now = Math.floor(Date.now() / 1000)
  const dayAgo = now - 86400
  const weekAgo = now - 604800

  const [dayCount, weekCount, typeStats, scoreDistribution] = await Promise.all([
    queryOne<{ cnt: number }>(db, 'SELECT COUNT(*) as cnt FROM security_logs WHERE created_at > ?', [dayAgo]),
    queryOne<{ cnt: number }>(db, 'SELECT COUNT(*) as cnt FROM security_logs WHERE created_at > ?', [weekAgo]),
    query(db, 'SELECT event_type, COUNT(*) as cnt FROM security_logs WHERE created_at > ? GROUP BY event_type ORDER BY cnt DESC', [weekAgo]),
    query(db, `SELECT
      CASE
        WHEN score < 20 THEN 'critical'
        WHEN score < 40 THEN 'warning'
        WHEN score < 60 THEN 'info'
        ELSE 'normal'
      END as level,
      COUNT(*) as cnt
    FROM security_logs WHERE created_at > ? GROUP BY level`, [weekAgo]),
  ])

  // 24小时趋势（每小时）
  const trend = await query(db,
    `SELECT
      CAST((created_at / 3600) * 3600 AS INTEGER) as hour,
      COUNT(*) as cnt
    FROM security_logs WHERE created_at > ?
    GROUP BY hour ORDER BY hour`,
    [dayAgo]
  )

  return c.json({
    dayCount: dayCount?.cnt || 0,
    weekCount: weekCount?.cnt || 0,
    typeStats: typeStats || [],
    scoreDistribution: scoreDistribution || [],
    trend: trend || [],
  })
})

// ============================================================
// 内测模式配置
// ============================================================

interface BetaModeConfig {
  enabled: boolean
  allowedRoutes: string[]
  message: string
}

const DEFAULT_BETA_MODE: BetaModeConfig = {
  enabled: false,
  allowedRoutes: ['/', '/login', '/register', '/admin', '/beta-register'],
  message: '产品正在内测中，请登录后访问',
}

/**
 * GET /api/admin/beta-mode — 获取内测模式配置（公开接口，供前端路由守卫使用）
 */
admin.get('/beta-mode', async (c) => {
  try {
    const db = c.env.abdl_space_db
    const row = await queryOne<{ value: string }>(db, "SELECT value FROM site_settings WHERE key = 'beta_mode'")
    if (!row) return c.json(DEFAULT_BETA_MODE)
    return c.json(JSON.parse(row.value) as BetaModeConfig)
  } catch (e) {
    console.error('GET /api/admin/beta-mode error:', e)
    return c.json(DEFAULT_BETA_MODE)
  }
})

/**
 * PUT /api/admin/beta-mode — 更新内测模式配置（仅管理员）
 */
admin.put('/beta-mode', adminMiddleware, async (c) => {
  try {
    const db = c.env.abdl_space_db
    const body = await c.req.json<Partial<BetaModeConfig>>()
    
    // 获取当前配置
    const row = await queryOne<{ value: string }>(db, "SELECT value FROM site_settings WHERE key = 'beta_mode'")
    const current = row ? JSON.parse(row.value) as BetaModeConfig : DEFAULT_BETA_MODE
    
    // 合并更新
    const updated: BetaModeConfig = {
      enabled: body.enabled ?? current.enabled,
      allowedRoutes: body.allowedRoutes ?? current.allowedRoutes,
      message: body.message ?? current.message,
    }
    
    // 验证 allowedRoutes 格式
    if (!Array.isArray(updated.allowedRoutes)) {
      return c.json({ error: 'allowedRoutes 必须是数组' }, 400)
    }
    for (const route of updated.allowedRoutes) {
      if (typeof route !== 'string' || !route.startsWith('/')) {
        return c.json({ error: '路由格式错误，必须以 / 开头' }, 400)
      }
    }
    
    // 保存到数据库
    await run(
      db,
      `INSERT INTO site_settings (key, value, updated_at) VALUES ('beta_mode', ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [JSON.stringify(updated)]
    )
    
    return c.json({ success: true, config: updated })
  } catch (e) {
    console.error('PUT /api/admin/beta-mode error:', e)
    return c.json({ error: '更新失败' }, 500)
  }
})

export default admin
