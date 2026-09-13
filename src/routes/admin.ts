import { Hono } from 'hono'
const DEFAULT_AVATAR = 'https://img.abdl-space.top/file/system/1781439303787_play_store_512.png'
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types'
import type { Env, JWTPayload } from '../types/index.ts'
import { query, queryOne, run } from '../lib/db.ts'
import { cacheDelete, cacheDeletePrefix } from '../lib/ttl-cache.ts'
import { kvCacheInvalidate } from '../lib/kv-cache.ts'
import { adminMiddleware } from '../middleware/auth.ts'

const IMGBED_URL = 'https://img.abdl-space.top'

/**
 * 删除一组评论及其完整回复树（含跨帖引用）。
 * post_comments.parent_id 是自引用且 NO ACTION，直接删父评论会触发 FK 违约，
 * 因此先断开树内父子引用，再清理评论点赞/评论图片，最后删除评论本体。
 */
async function deleteCommentTree(db: D1Database, commentIds: number[]): Promise<void> {
  if (!commentIds.length) return
  const ph = commentIds.map(() => '?').join(',')
  // 断开树内父子引用（含指向被删评论的跨帖回复），彻底避免自引用 FK 违约
  await run(db, `UPDATE post_comments SET parent_id = NULL WHERE parent_id IN (${ph})`, commentIds)
  // 评论点赞与评论图片
  await run(db, `DELETE FROM likes WHERE target_type = 'comment' AND target_id IN (${ph})`, commentIds)
  await run(db, `DELETE FROM comment_images WHERE comment_id IN (${ph})`, commentIds)
  // 删除评论本体
  await run(db, `DELETE FROM post_comments WHERE id IN (${ph})`, commentIds)
}

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

// ============================================================
// 运维统计辅助 —— “按天”统一按北京时间 UTC+8 日历分桶
// ============================================================
const CN_TZ = '+8 hours'

async function tableHasColumn(db: D1Database, table: string, column: string): Promise<boolean> {
  const row = await queryOne<{ name: string }>(
    db, `SELECT name FROM pragma_table_info('${table.replace(/'/g, "''")}') WHERE name = ?`, [column]
  )
  return !!row
}

/** 文本时间戳（DATETIME 文本，如 CURRENT_TIMESTAMP）按北京时间聚合为日序列 */
async function dailySeries(db: D1Database, table: string, extra: string, params: unknown[] = []): Promise<{ d: string; c: number }[]> {
  return query<{ d: string; c: number }>(
    db,
    `SELECT substr(datetime(created_at, '${CN_TZ}'), 1, 10) AS d, COUNT(*) AS c
     FROM ${table} ${extra} GROUP BY d ORDER BY d`,
    params
  )
}

/** Unix 秒时间戳表按北京时间聚合为日序列（novels 等） */
async function dailySeriesUnix(db: D1Database, table: string, extra: string, params: unknown[] = []): Promise<{ d: string; c: number }[]> {
  return query<{ d: string; c: number }>(
    db,
    `SELECT substr(datetime(created_at, 'unixepoch', '${CN_TZ}'), 1, 10) AS d, COUNT(*) AS c
     FROM ${table} ${extra} GROUP BY d ORDER BY d`,
    params
  )
}

/** 文本时间戳表：北京时区日窗口 [startDays 天前 0 点, start 后 endDays 天 0 点) 内的行数 */
async function bucketCount(db: D1Database, table: string, startDays: number, endDays: number | null): Promise<number> {
  const dayMod = (nDays: number, sign: '+' | '-') => (nDays === 0 ? '' : `, '${sign}${nDays} days'`)
  const conditions = [`created_at >= datetime('now', '${CN_TZ}', 'start of day'${dayMod(startDays, '-')})`]
  if (endDays !== null) {
    conditions.push(`created_at < datetime('now', '${CN_TZ}', 'start of day'${dayMod(startDays, '-')}${dayMod(endDays, '+')})`)
  }
  const row = await queryOne<{ c: number }>(
    db, `SELECT COUNT(*) AS c FROM ${table} WHERE ${conditions.join(' AND ')}`)
  return row?.c ?? 0
}

// ============================================================
// 管理台读行优化 —— 每日快照（admin_daily_stats）+ 分钟级 KV 缓存
// 策略：周/环比/趋势读日快照（几十行），总量与待办等 5 分钟缓存，仅"今日"实时按索引窗口计数
// ============================================================
const SNAP_TTL_MS = 5 * 60 * 1000
const DAILY_LOOKBACK = 200

/** [响应 key, 目标表] —— 文本时间戳表 */
const DAILY_TABLES = [
  ['users', 'users'],
  ['posts', 'posts'],
  ['comments', 'post_comments'],
  ['ratings', 'ratings'],
  ['checkins', 'daily_checkins'],
  ['likes', 'likes'],
] as const

/** admin_daily_stats 中与 DAILY_TABLES 对应的求和列 */
const DAILY_COLUMNS = ['users', 'posts', 'comments', 'ratings', 'checkins', 'likes'] as const

/** 趋势序列的 key（= DAILY_COLUMNS + novels） */
const TREND_KEYS = [...DAILY_COLUMNS, 'novels'] as const

/** 北京时区日期字符串 YYYY-MM-DD（今天或 offsetDays 前） */
function bjDate(offsetDays = 0): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  d.setUTCDate(d.getUTCDate() - offsetDays)
  return d.toISOString().slice(0, 10)
}

/** 读管理员 KV 缓存（value 为 JSON 字符串） */
async function metricsCacheGet(db: D1Database, key: string): Promise<{ value: unknown; ts: number } | null> {
  const row = await queryOne<{ value: string; updated_at: string }>(
    db, 'SELECT value, updated_at FROM admin_metrics_cache WHERE key = ?', [key]
  ).catch(() => null)
  if (!row) return null
  const ts = Math.floor(new Date(row.updated_at.replace(' ', 'T') + 'Z').getTime())
  try { return { value: JSON.parse(row.value), ts: Number.isFinite(ts) ? ts : 0 } } catch { return null }
}

async function metricsCacheSet(db: D1Database, key: string, value: unknown): Promise<void> {
  await run(
    db,
    `INSERT INTO admin_metrics_cache (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, JSON.stringify(value)]
  ).catch(() => null)
}

/** 回填每日快照到昨天（北京时区），从上次标记次日增量补齐。失败静默，保持旧直连路径可回退 */
async function ensureDailyStats(db: D1Database): Promise<void> {
  const until = bjDate(1) // 昨天，今天的数据等明天再入快照
  try {
    const marker = await metricsCacheGet(db, 'daily_stats_filled_until')
    if (marker && typeof marker.value === 'string' && marker.value >= until) return
  } catch { /* 表还不存在时走回填失败路径 */ }
  try {
    let since = bjDate(DAILY_LOOKBACK)
    try {
      const marker = await metricsCacheGet(db, 'daily_stats_filled_until')
      if (marker && typeof marker.value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(marker.value)) {
        const d = marker.value + 'T00:00:00Z'
        const next = new Date(d)
        next.setUTCDate(next.getUTCDate() + 1)
        const candidate = next.toISOString().slice(0, 10)
        if (candidate > since) since = candidate
      }
    } catch { /* 保持初始全量回填 */ }
    const writes: D1PreparedStatement[] = []
    for (const [col, table] of DAILY_TABLES) {
      const rows = await query<{ d: string; c: number }>(
        db,
        `SELECT substr(datetime(created_at, '+8 hours'), 1, 10) AS d, COUNT(*) AS c
         FROM ${table}
         WHERE created_at >= datetime(? || ' 00:00:00') AND created_at < datetime(? || ' 00:00:00')
         GROUP BY d`,
        [since, until]
      )
      for (const r of rows) {
        if (!r.d || r.d < since) continue
        writes.push(db.prepare(
          `INSERT INTO admin_daily_stats (date, ${col}) VALUES (?, ?)
           ON CONFLICT(date) DO UPDATE SET ${col} = excluded.${col}`
        ).bind(r.d, r.c))
      }
    }
    // novels：unix 秒时间戳
    const colNovel = 'novels'
    const novelRows = await query<{ d: string; c: number }>(
      db,
      `SELECT substr(datetime(created_at, 'unixepoch', '+8 hours'), 1, 10) AS d, COUNT(*) AS c
       FROM novels
       WHERE deleted_at IS NULL
         AND created_at >= CAST(strftime('%s', ? || ' 00:00:00') AS INTEGER)
         AND created_at < CAST(strftime('%s', ? || ' 00:00:00') AS INTEGER)
       GROUP BY d`,
      [since, until]
    )
    for (const r of novelRows) {
      if (!r.d || r.d < since) continue
      writes.push(db.prepare(
        `INSERT INTO admin_daily_stats (date, ${colNovel}) VALUES (?, ?)
         ON CONFLICT(date) DO UPDATE SET ${colNovel} = excluded.${colNovel}`
      ).bind(r.d, r.c))
    }
    if (writes.length) {
      for (let i = 0; i < writes.length; i += 100) {
        await db.batch(writes.slice(i, i + 100)).catch(() => null)
      }
    }
    await metricsCacheSet(db, 'daily_stats_filled_until', until)
  } catch {
    // 表不存在或查询失败 → 保持旧路径
  }
}

/** 读单日快照；无该日数据（或表缺失）返回 null */
async function dailyStatsRow(db: D1Database, dateStr: string): Promise<Record<string, number> | null> {
  const row = await queryOne<Record<string, number>>(
    db, `SELECT users, posts, comments, ratings, checkins, likes FROM admin_daily_stats WHERE date = ?`, [dateStr]
  ).catch(() => null)
  if (!row) return null
  const out: Record<string, number> = {}
  for (const key of DAILY_COLUMNS) out[key] = Number(row[key]) || 0
  return out
}

/** 日快照区间逐列求和（含边界）；区间内无任何快照行返回 null（上层回退旧路径） */
async function dailyStatsSum(db: D1Database, fromDate: string, toDate: string): Promise<Record<string, number> | null> {
  const rows = await query<Record<string, number>>(
    db, `SELECT date, users, posts, comments, ratings, checkins, likes FROM admin_daily_stats WHERE date >= ? AND date <= ?`, [fromDate, toDate]
  ).catch(() => [])
  if (rows.length === 0) return null
  const out: Record<string, number> = {}
  for (const key of DAILY_COLUMNS) {
    let s = 0
    for (const r of rows) s += Number(r[key]) || 0
    out[key] = s
  }
  return out
}

/**
 * 5 分钟快照：总量 / 小说状态 / 待办 / 地域 / 徽章（低频变化部分合并为一次计算，
 * 概览每 5 分钟只做一遍，而不是每个请求都全表 COUNT）
 */
async function buildOverviewSnapshot(db: D1Database): Promise<Record<string, unknown>> {
  const totals = await Promise.allSettled([
    queryOne<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM users'),
    queryOne<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM posts'),
    queryOne<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM post_comments'),
    queryOne<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM ratings'),
    queryOne<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM diapers'),
    queryOne<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM likes'),
    queryOne<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM daily_checkins'),
    queryOne<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM user_badges'),
    queryOne<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM novels WHERE deleted_at IS NULL'),
  ])
  const numOf = (s: PromiseSettledResult<{ c: number } | null>): number =>
    s.status === 'fulfilled' && s.value ? s.value.c : 0
  const hasApp = await tableHasColumn(db, 'users', 'has_app')
  const hasBanned = await tableHasColumn(db, 'users', 'banned')
  const appUsers = hasApp
    ? (await queryOne<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM users WHERE has_app = 1').catch(() => null))?.c ?? 0
    : 0
  const bannedUsers = hasBanned
    ? (await queryOne<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM users WHERE banned = 1').catch(() => null))?.c ?? 0
    : 0

  // 小说状态分布（量级很小且低频变化，快照就够）
  const novelStatus = await query<{ status: string; c: number }>(
    db, 'SELECT status, COUNT(*) AS c FROM novels WHERE deleted_at IS NULL GROUP BY status'
  ).catch(() => [])
  const novels: Record<string, number> = { draft: 0, review_pending: 0, published: 0, rejected: 0, archived: 0 }
  for (const s of novelStatus) novels[s.status] = s.c

  // 待办工单
  const [pendingReports, pendingFriend, pendingNovelReports, pendingAppeals, pendingSecurity] = await Promise.all([
    queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM reports WHERE status = 'pending'").catch(() => null),
    queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM friend_request_reports WHERE status = 'pending'").catch(() => null),
    queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM novel_reports WHERE status IN ('pending','reviewing')").catch(() => null),
    queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM novel_review_appeals WHERE status IN ('pending','reviewing')").catch(() => null),
    queryOne<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM security_logs WHERE created_at > ?', [Math.floor(Date.now() / 1000) - 86400]).catch(() => null),
  ])

  // 帖子地域分布（近 30 天）
  const provinces = await query<{ name: string; c: number }>(
    db,
    `SELECT geo_province AS name, COUNT(*) AS c FROM posts
     WHERE geo_province IS NOT NULL AND geo_province <> ''
       AND created_at >= datetime('now', '${CN_TZ}', '-30 days')
     GROUP BY geo_province ORDER BY c DESC LIMIT 10`
  ).catch(() => [])

  // 徽章持有排行
  const topBadges = await query<{ key: string; name: string; c: number }>(
    db,
    `SELECT b.key, b.name, COUNT(ub.user_id) AS c
     FROM badges b LEFT JOIN user_badges ub ON ub.badge_key = b.key
     GROUP BY b.key ORDER BY c DESC LIMIT 6`
  ).catch(() => [])

  return {
    totals: {
      users: numOf(totals[0]), posts: numOf(totals[1]), comments: numOf(totals[2]),
      ratings: numOf(totals[3]), diapers: numOf(totals[4]), likes: numOf(totals[5]),
      checkins: numOf(totals[6]), badges: numOf(totals[7]), novels: numOf(totals[8]),
      appUsers, bannedUsers,
    },
    novels,
    pending: {
      reports: pendingReports?.c ?? 0, friend_reports: pendingFriend?.c ?? 0,
      novel_reports: pendingNovelReports?.c ?? 0, novel_appeals: pendingAppeals?.c ?? 0,
      security_24h: pendingSecurity?.c ?? 0,
    },
    provinces,
    topBadges,
  }
}

/** 读快照 value（5 分钟内命中缓存）；未命中时回填并返回 */
async function withOverviewSnapshot<T>(db: D1Database, key: string, build: () => Promise<T>): Promise<T> {
  const cached = await metricsCacheGet(db, key)
  if (cached && typeof cached.value === 'object' && cached.value !== null && Date.now() - cached.ts < SNAP_TTL_MS) {
    return cached.value as T
  }
  const fresh = await build()
  await metricsCacheSet(db, key, fresh)
  return fresh
}

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
 * GET /api/admin/users — 用户列表（分页 + 搜索 + 角色筛选）
 */
admin.get('/users', adminMiddleware, async (c) => {
  const db = c.env.abdl_space_db
  const page = Math.max(1, parseInt(c.req.query('page') || '1'))
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20')))
  const offset = (page - 1) * limit
  const q = (c.req.query('q') || '').trim()
  const role = (c.req.query('role') || '').trim()

  const colRows = await query<{ name: string }>(db, "SELECT name FROM pragma_table_info('users')")
  const colSet = new Set(colRows.map(r => r.name))
  const bannedSel = colSet.has('banned') ? 'u.banned,' : ''
  const hasAppSel = colSet.has('has_app') ? 'u.has_app,' : ''

  const where: string[] = ['1=1']
  const params: unknown[] = []
  if (q) { where.push('(u.username LIKE ? OR u.email LIKE ?)'); params.push(`%${q}%`, `%${q}%`) }
  if (role === 'admin' || role === 'user') { where.push('u.role = ?'); params.push(role) }
  const whereSql = where.join(' AND ')

  const [totalRow, rows] = await Promise.all([
    queryOne<{ c: number }>(db, `SELECT COUNT(*) AS c FROM users u WHERE ${whereSql}`, params),
    query<Record<string, unknown>>(
      db,
      `SELECT u.id, u.email, u.username, u.display_name, u.role, u.avatar, u.email_verified, u.created_at,
              ${bannedSel} ${hasAppSel}
              (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id) AS post_count,
              (SELECT COUNT(*) FROM post_comments pc WHERE pc.user_id = u.id) AS comment_count,
              (SELECT COUNT(*) FROM daily_checkins dc WHERE dc.user_id = u.id) AS checkin_count
       FROM users u WHERE ${whereSql} ORDER BY u.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    ),
  ])

  const total = totalRow?.c ?? 0
  return c.json({
    users: rows.map(r => ({
      id: r.id, email: r.email, username: r.username, display_name: r.display_name || '',
      role: r.role, avatar: r.avatar ?? DEFAULT_AVATAR, email_verified: r.email_verified,
      created_at: r.created_at, banned: !!r.banned, has_app: !!r.has_app,
      post_count: r.post_count ?? 0, comment_count: r.comment_count ?? 0, checkin_count: r.checkin_count ?? 0,
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  })
})

/**
 * GET /api/admin/users/:id/detail — 用户详情（含画像与行为统计）
 */
admin.get('/users/:id/detail', adminMiddleware, async (c) => {
  const id = parseInt(c.req.param('id') || '')
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Invalid user id' }, 400)
  const db = c.env.abdl_space_db

  const colSet = new Set((await query<{ name: string }>(db, "SELECT name FROM pragma_table_info('users')")).map(r => r.name))
  const safeCol = (n: string) => (colSet.has(n) ? `, ${n}` : '')

  const user = await queryOne<Record<string, unknown>>(
    db,
    `SELECT id, email, username, display_name, role, avatar, email_verified, created_at
     ${safeCol('banned')} ${safeCol('has_app')} ${safeCol('region')} ${safeCol('age')}
     ${safeCol('weight')} ${safeCol('waist')} ${safeCol('hip')} ${safeCol('style_preference')}
     ${safeCol('bio')} ${safeCol('header')}
     FROM users WHERE id = ?`,
    [id]
  )
  if (!user) return c.json({ error: 'User not found' }, 404)

  const [posts, comments, postLikes, ratings, feelings, checkins, points, badgeRows, recentPosts] = await Promise.all([
    queryOne<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM posts WHERE user_id = ?', [id]),
    queryOne<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM post_comments WHERE user_id = ?', [id]),
    queryOne<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM likes WHERE user_id = ?', [id]),
    queryOne<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM ratings WHERE user_id = ?', [id]),
    queryOne<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM feelings WHERE user_id = ?', [id]),
    queryOne<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM daily_checkins WHERE user_id = ?', [id]),
    queryOne<{ c: number; balance: number }>(db, 'SELECT balance FROM points WHERE user_id = ?', [id]).catch(() => null),
    query<{ key: string; name: string; color: string; created_at: string | null }>(
      db,
      `SELECT ub.badge_key AS key, b.name, b.color, ub.created_at
       FROM user_badges ub LEFT JOIN badges b ON b.key = ub.badge_key
       WHERE ub.user_id = ? ORDER BY ub.created_at DESC LIMIT 50`,
      [id]
    ).catch(() => []),
    query<{ id: number; content: string; created_at: string }>(
      db, 'SELECT id, content, created_at FROM posts WHERE user_id = ? ORDER BY id DESC LIMIT 5', [id]
    ),
  ])
  const [trackRule, trackEvents] = await Promise.all([
    queryOne<{ enabled: number; created_at: number }>(
      db, 'SELECT enabled, created_at FROM ip_tracking_rules WHERE user_id = ?', [id]
    ).catch(() => null),
    query<{ ip: string; path: string; created_at: number }>(
      db, 'SELECT ip, path, created_at FROM ip_tracking_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 20', [id]
    ).catch(() => [] as { ip: string; path: string; created_at: number }[]),
  ])

  return c.json({
    user: {
      ...user,
      banned: !!user.banned, has_app: !!user.has_app,
      avatar: user.avatar ?? DEFAULT_AVATAR,
    },
    counts: {
      posts: posts?.c ?? 0, comments: comments?.c ?? 0, likes: postLikes?.c ?? 0,
      ratings: ratings?.c ?? 0, feelings: feelings?.c ?? 0, checkins: checkins?.c ?? 0,
      points: points?.balance ?? 0,
    },
    badges: badgeRows,
    tracking: { enabled: !!trackRule?.enabled, created_at: trackRule?.created_at || null },
    trackEvents,
    recentPosts,
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

  // 级联删除所有关联数据（按依赖顺序）
  // ---- 评论（含被删用户的评论，以及别人回复它的整棵嵌套树；parent_id 自引用 NO ACTION，须先断链）----
  const userCommentTree = await query<{ id: number }>(db, `WITH RECURSIVE subtree(id) AS (
    SELECT id FROM post_comments WHERE user_id = ?
    UNION
    SELECT c.id FROM post_comments c JOIN subtree s ON c.parent_id = s.id
  )
  SELECT id FROM subtree`, [id])
  const userCommentIds = userCommentTree.map(r => r.id)
  await deleteCommentTree(db, userCommentIds)

  // ---- 帖子及其关联（posts、post_images、post_shares、polls 均 CASCADE，post_views 需手工清理）----
  const userPosts = await query<{ id: number }>(db, 'SELECT id FROM posts WHERE user_id = ?', [id])
  const postIds = userPosts.map(p => p.id)
  if (postIds.length > 0) {
    // 帖子评论（含被删用户帖子的评论、及回复树）先断链删除，防止 CASCADE 自引用违约
    const postCommentTree = await query<{ id: number }>(db, `WITH RECURSIVE subtree(id) AS (
      SELECT id FROM post_comments WHERE post_id IN (${postIds.map(() => '?').join(',')})
      UNION
      SELECT c.id FROM post_comments c JOIN subtree s ON c.parent_id = s.id
    )
    SELECT id FROM subtree`, postIds)
    await deleteCommentTree(db, postCommentTree.map(r => r.id))
    // 帖子图片（post_images CASCADE，但保留显式清理以同步删除图床资源）
    for (const post of userPosts) {
      await run(db, 'DELETE FROM post_images WHERE post_id = ?', [post.id])
    }
    // 浏览记录：post_views.post_id -> posts 无 CASCADE，必须在删帖前清掉
    await run(db, `DELETE FROM post_views WHERE post_id IN (${postIds.map(() => '?').join(',')})`, postIds)
  }
  // 该用户自身的浏览记录（post_views.user_id -> users 无 CASCADE）
  await run(db, 'DELETE FROM post_views WHERE user_id = ?', [id])
  // 投票
  await run(db, 'DELETE FROM polls WHERE status_id IN (SELECT id FROM posts WHERE user_id = ?)', [id])
  await run(db, 'DELETE FROM posts WHERE user_id = ?', [id])
  // 点赞/收藏/评分/感受
  await run(db, 'DELETE FROM likes WHERE user_id = ?', [id])
  await run(db, 'DELETE FROM ratings WHERE user_id = ?', [id])
  await run(db, 'DELETE FROM feelings WHERE user_id = ?', [id])
  // 投票记录
  await run(db, 'DELETE FROM poll_votes WHERE user_id = ?', [id])
  // 通知/消息/关注
  await run(db, 'DELETE FROM notifications WHERE user_id = ? OR actor_id = ?', [id, id])
  await run(db, 'DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?', [id, id])
  await run(db, 'DELETE FROM follows WHERE follower_id = ? OR following_id = ?', [id, id])
  // 好友申请评论（friend_request_comments.parent_id 自引用 NO ACTION，先断链）与举报
  const friendComments = await query<{ id: number }>(db, `WITH RECURSIVE subtree(id) AS (
    SELECT id FROM friend_request_comments WHERE user_id = ?
    UNION
    SELECT c.id FROM friend_request_comments c JOIN subtree s ON c.parent_id = s.id
  )
  SELECT id FROM subtree`, [id])
  const friendCommentIds = friendComments.map(r => r.id)
  if (friendCommentIds.length > 0) {
    const fph = friendCommentIds.map(() => '?').join(',')
    await run(db, `UPDATE friend_request_comments SET parent_id = NULL WHERE parent_id IN (${fph})`, friendCommentIds)
    await run(db, `DELETE FROM friend_request_comments WHERE id IN (${fph})`, friendCommentIds)
  }
  // 好友申请报告（reporter/resolved NO ACTION；request_id 外键指向 friend_requests，需在删申请前先清）
  await run(db, 'DELETE FROM friend_request_reports WHERE reporter_id = ? OR resolved_by = ?', [id, id])
  // 好友申请本体（friend_requests.user_id -> users CASCADE，剩下由 CASCADE 兜底）
  await run(db, 'DELETE FROM friend_requests WHERE user_id = ?', [id])
  // 积分/经验
  await run(db, 'DELETE FROM points WHERE user_id = ?', [id])
  await run(db, 'DELETE FROM exp_logs WHERE user_id = ?', [id])
  await run(db, 'DELETE FROM point_logs WHERE user_id = ?', [id])
  await run(db, 'DELETE FROM experience WHERE user_id = ?', [id])
  await run(db, 'DELETE FROM daily_checkins WHERE user_id = ?', [id])
  // 用户设置/徽章
  await run(db, 'DELETE FROM user_settings WHERE user_id = ?', [id])
  await run(db, 'DELETE FROM user_badges WHERE user_id = ?', [id])
  // OAuth
  await run(db, 'DELETE FROM oauth_tokens WHERE user_id = ?', [id])
  await run(db, 'DELETE FROM oauth_clients WHERE owner_id = ?', [id])
  await run(db, 'DELETE FROM oauth_codes WHERE user_id = ?', [id])
  // API keys（仅用户级）
  await run(db, 'DELETE FROM content_api_keys WHERE owner_id = ?', [id])
  await run(db, 'DELETE FROM captcha_api_keys WHERE owner_id = ?', [id])
  await run(db, 'DELETE FROM ks_channels WHERE owner_id = ?', [id])
  await run(db, 'DELETE FROM ks_sub_keys WHERE owner_id = ?', [id])
  // 举报（该用户作为举报者；resolved_by 在下方统一处理）
  await run(db, 'DELETE FROM reports WHERE reporter_id = ?', [id])
  // 邀请码/JPush/QR登录/公告互动/心跳/里程碑/Wiki评论
  await run(db, 'DELETE FROM invite_codes WHERE creator_id = ? OR used_by = ?', [id, id])
  await run(db, 'DELETE FROM jpush_registrations WHERE user_id = ?', [id])
  await run(db, 'DELETE FROM qr_login_sessions WHERE user_id = ?', [id])
  await run(db, 'DELETE FROM announcement_reactions WHERE user_id = ?', [id])
  await run(db, 'DELETE FROM announcement_read_status WHERE user_id = ?', [id])
  await run(db, 'DELETE FROM lan_heartbeats WHERE user_id = ?', [id])
  await run(db, 'DELETE FROM markers WHERE user_id = ?', [id])
  await run(db, 'DELETE FROM wiki_inline_comments WHERE author_id = ?', [id])
  // IP 追踪记录（ip_tracking_rules.user_id、ip_tracking_events.user_id、ip_bans.source_user_id
  // 均指向 users 无 CASCADE，须在删用户前清理；封禁表还引用了创建者）
  await run(db, 'DELETE FROM ip_tracking_rules WHERE user_id = ? OR created_by = ?', [id, id])
  await run(db, 'DELETE FROM ip_tracking_events WHERE user_id = ?', [id])
  await run(db, 'DELETE FROM ip_bans WHERE source_user_id = ? OR created_by = ?', [id, id])
  // Wiki 内容与条款（author_id / created_by 指向 users 且 no CASCADE，保留内容、置空归属）
  await run(db, 'UPDATE wiki_pages SET author_id = NULL WHERE author_id = ?', [id])
  await run(db, 'UPDATE page_versions SET author_id = NULL WHERE author_id = ?', [id])
  await run(db, 'UPDATE terms SET created_by = NULL WHERE created_by = ?', [id])
  // 其他用户的举报记录中该用户作为处理人（resolved_by）的引用
  await run(db, 'UPDATE reports SET resolved_by = NULL WHERE resolved_by = ?', [id])
  // 验证码记录
  await run(db, 'DELETE FROM email_verifications WHERE user_id = ?', [id])
  // 最后删除用户
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
 * POST /api/admin/security/users/:id/track-and-ban
 * 启用定向追踪，封禁已记录的 IP；后续该账户通过任意已认证端点访问时会自动记录并封禁其 IP。
 */
admin.post('/security/users/:id/track-and-ban', adminMiddleware, async (c) => {
  const id = parseInt(c.req.param('id') || '')
  const operator = c.get('user')
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Invalid user id' }, 400)
  if (id === operator.sub) return c.json({ error: '不能追踪或封禁自己的账户' }, 400)

  const db = c.env.abdl_space_db
  const target = await queryOne<{ id: number }>(db, 'SELECT id FROM users WHERE id = ?', [id])
  if (!target) return c.json({ error: 'User not found' }, 404)

  const now = Math.floor(Date.now() / 1000)
  await run(
    db,
    `INSERT INTO ip_tracking_rules (user_id, enabled, created_by, created_at)
     VALUES (?, 1, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET enabled = 1, created_by = excluded.created_by, created_at = excluded.created_at`,
    [id, operator.sub, now],
  )
  const ips = await query<{ ip: string }>(
    db,
    'SELECT DISTINCT ip FROM ip_tracking_events WHERE user_id = ? AND ip <> ? AND ip <> ? ',
    [id, '', 'unknown'],
  )
  for (const row of ips) {
    await run(
      db,
      `INSERT INTO ip_bans (ip, source_user_id, reason, created_by, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(ip) DO NOTHING`,
      [row.ip, id, 'Tracked account access', operator.sub, now],
    )
  }

  return c.json({ tracked: true, banned_ip_count: ips.length })
})

/** 管理员查看目标账户的追踪状态；不向普通用户暴露 IP 信息。 */
admin.get('/security/users/:id/tracking', adminMiddleware, async (c) => {
  const id = parseInt(c.req.param('id') || '')
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Invalid user id' }, 400)

  const db = c.env.abdl_space_db
  const rule = await queryOne<{ enabled: number; created_at: number }>(
    db,
    'SELECT enabled, created_at FROM ip_tracking_rules WHERE user_id = ?',
    [id],
  )
  const events = await query<{ ip: string; path: string; created_at: number }>(
    db,
    'SELECT ip, path, created_at FROM ip_tracking_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
    [id],
  )
  return c.json({ tracking: !!rule?.enabled, created_at: rule?.created_at || null, events })
})

/**
 * GET /api/admin/posts — 管理员帖子列表（分页 + 关键词搜索）
 */
admin.get('/posts', adminMiddleware, async (c) => {
  const db = c.env.abdl_space_db
  const page = Math.max(1, parseInt(c.req.query('page') || '1'))
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20')))
  const offset = (page - 1) * limit
  const q = (c.req.query('q') || '').trim()

  const where: string[] = ['1=1']
  const params: unknown[] = []
  if (q) { where.push('(p.content LIKE ? OR u.username LIKE ?)'); params.push(`%${q}%`, `%${q}%`) }
  const whereSql = where.join(' AND ')

  const [totalRow, rows] = await Promise.all([
    queryOne<{ c: number }>(db, `SELECT COUNT(*) AS c FROM posts p JOIN users u ON p.user_id = u.id WHERE ${whereSql}`, params),
    query<Record<string, unknown>>(
      db,
      `SELECT p.id, p.content, p.pinned, p.created_at, p.has_nsfw, p.is_announcement,
              u.username, u.avatar, u.role,
              (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
              (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) + (SELECT COUNT(*) FROM posts WHERE in_reply_to_id = p.id) as comment_count
       FROM posts p JOIN users u ON p.user_id = u.id
       WHERE ${whereSql}
       ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    ),
  ])

  const total = totalRow?.c ?? 0
  return c.json({
    posts: rows.map(r => ({
      id: r.id, content: r.content, pinned: !!r.pinned, has_nsfw: !!r.has_nsfw, is_announcement: !!r.is_announcement,
      user: { username: r.username, avatar: r.avatar ?? DEFAULT_AVATAR, role: r.role },
      like_count: r.like_count, comment_count: r.comment_count, created_at: r.created_at
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
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
 * PATCH /api/admin/posts/:id/nsfw — 显式设置帖子敏感状态
 */
admin.patch('/posts/:id/nsfw', adminMiddleware, async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Invalid post id' }, 400)

  const body = await c.req.json<{ has_nsfw?: unknown }>().catch(() => null)
  if (!body || typeof body.has_nsfw !== 'boolean') {
    return c.json({ error: 'has_nsfw must be a boolean' }, 400)
  }

  const db = c.env.abdl_space_db
  const post = await queryOne<{ id: number }>(db, 'SELECT id FROM posts WHERE id = ?', [id])
  if (!post) return c.json({ error: 'Post not found' }, 404)

  const value = body.has_nsfw ? 1 : 0
  const statements = [
    db.prepare('UPDATE posts SET has_nsfw = ? WHERE id = ?').bind(value, id),
    db.prepare('UPDATE post_images SET is_nsfw = ? WHERE post_id = ?').bind(value, id),
  ]
  const results = await db.batch(statements)
  if (results.some(result => !result.success)) return c.json({ error: 'Database operation failed' }, 500)

  cacheDeletePrefix('popular:')
  const cacheKeys = ['trends:statuses:10', 'trends:statuses:20', 'trends:statuses:40']
  for (const key of cacheKeys) cacheDelete(key)
  await Promise.all([
    ...cacheKeys.map(key => kvCacheInvalidate(c.env.NOTICE_KV, key)),
    kvCacheInvalidate(c.env.NOTICE_KV, 'public-timeline:snapshot'),
  ])

  return c.json({ has_nsfw: body.has_nsfw })
})

/**
 * DELETE /api/admin/posts/:id — 删除帖子
 */
admin.delete('/posts/:id', adminMiddleware, async (c) => {
  const id = parseInt(c.req.param('id') || '')

  const db = c.env.abdl_space_db
  const post = await queryOne<{ id: number }>(db, 'SELECT id FROM posts WHERE id = ?', [id])
  if (!post) return c.json({ error: 'Post not found' }, 404)

  // 浏览记录：post_views.post_id -> posts 无 ON DELETE CASCADE，删帖前必须清
  await run(db, 'DELETE FROM post_views WHERE post_id = ?', [id])
  // 帖子点赞/图片
  await run(db, "DELETE FROM likes WHERE target_type = 'post' AND target_id = ?", [id])
  await run(db, 'DELETE FROM post_images WHERE post_id = ?', [id])
  // 评论树：此帖的评论 + 所有引用它们的回复（含跨帖嵌套），先断链再删
  const comments = await query<{ id: number }>(db, `WITH RECURSIVE subtree(id) AS (
    SELECT id FROM post_comments WHERE post_id = ?
    UNION
    SELECT c.id FROM post_comments c JOIN subtree s ON c.parent_id = s.id
  )
  SELECT id FROM subtree`, [id])
  await deleteCommentTree(db, comments.map(r => r.id))
  // 转发/投票：post_shares、polls 对 posts 均为 ON DELETE CASCADE，随 posts 删除自动清理
  await run(db, 'DELETE FROM posts WHERE id = ?', [id])
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
 * GET /api/admin/diapers — 纸尿裤列表（管理用，分页）
 */
admin.get('/diapers', adminMiddleware, async (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') || '1'))
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '100')))
  const offset = (page - 1) * limit

  const countResult = await query<{ total: number }>(c.env.abdl_space_db, 'SELECT COUNT(*) as total FROM diapers')
  const total = countResult[0]?.total || 0

  const rows = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT d.*, GROUP_CONCAT(di.image_url) as image_urls
     FROM diapers d
     LEFT JOIN diaper_images di ON di.diaper_id = d.id
     GROUP BY d.id
     ORDER BY d.created_at DESC
     LIMIT ? OFFSET ?`,
    [limit, offset]
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
  return c.json({ diapers, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } })
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

// ============================================================
// GET /api/admin/stats/overview — 经营总览（总量 / 今日 / 环比 / 待办）
// 读行优化：总量/待办/地域/徽章走 5 分钟缓存；周/环比读日快照；仅今日实时按索引窗口计数
// ============================================================
admin.get('/stats/overview', adminMiddleware, async (c) => {
  const db = c.env.abdl_space_db
  await ensureDailyStats(db)

  const snapshot = await withOverviewSnapshot<Record<string, unknown>>(
    db, 'overview_snapshot_v2', async () => buildOverviewSnapshot(db)
  )
  const totals = snapshot.totals as Record<string, number>
  const novels = snapshot.novels as Record<string, number>
  const pending = snapshot.pending as Record<string, number>
  const provinces = (snapshot.provinces ?? []) as { name: string; c: number }[]
  const topBadges = (snapshot.topBadges ?? []) as { key: string; name: string; c: number }[]

  // 今日实时（每个表只扫今日窗口，走 created_at 索引）；昨日 / 周 / 前周读日快照
  const [todayPairs, yesterdayRow, weekSum, prevSum] = await Promise.all([
    Promise.all(DAILY_TABLES.map(async ([key, table]) => [key, await bucketCount(db, table, 0, 1)] as const)),
    dailyStatsRow(db, bjDate(1)),
    dailyStatsSum(db, bjDate(6), bjDate(1)),
    dailyStatsSum(db, bjDate(13), bjDate(7)),
  ])
  const today: Record<string, number> = {}
  for (const [key, v] of todayPairs) today[key] = v
  const yesterday: Record<string, number> = {}
  const week: Record<string, number> = {}
  const prevWeek: Record<string, number> = {}
  if (yesterdayRow && weekSum && prevSum) {
    for (const key of DAILY_COLUMNS) {
      yesterday[key] = yesterdayRow[key] || 0
      week[key] = (weekSum[key] || 0) + (today[key] || 0)
      prevWeek[key] = prevSum[key] || 0
    }
  } else {
    // 快照表缺失或未回填 → 旧直连
    for (let i = 0; i < DAILY_TABLES.length; i++) {
      const key = DAILY_TABLES[i][0]
      const table = DAILY_TABLES[i][1]
      yesterday[key] = await bucketCount(db, table, 1, 1)
      week[key] = await bucketCount(db, table, 7, null)
      prevWeek[key] = await bucketCount(db, table, 14, 7)
    }
  }

  // 最新注册 / 最新帖子（少量，保持实时）
  const [recentUsers, recentPosts] = await Promise.all([
    query<Record<string, unknown>>(db, 'SELECT id, username, avatar, created_at FROM users ORDER BY id DESC LIMIT 8'),
    query<Record<string, unknown>>(
      db,
      `SELECT p.id, p.content, p.created_at, u.username
       FROM posts p JOIN users u ON u.id = p.user_id
       WHERE p.content <> '' ORDER BY p.id DESC LIMIT 8`
    ),
  ])

  return c.json({
    totals,
    today, yesterday, week, prevWeek,
    novels,
    pending,
    provinces,
    topBadges,
    recentUsers: recentUsers.map(r => ({ id: r.id, username: r.username, avatar: r.avatar ?? DEFAULT_AVATAR, created_at: r.created_at })),
    recentPosts: recentPosts.map(r => ({ id: r.id, content: r.content, username: r.username, created_at: r.created_at })),
  })
})

// ============================================================
// GET /api/admin/stats/trends?days=30 — 每日趋势序列（7~90 天）
// 读行优化：优先读 admin_daily_stats 快照（几十行）；快照缺失时回退旧直连
// ============================================================
admin.get('/stats/trends', adminMiddleware, async (c) => {
  const db = c.env.abdl_space_db
  const days = Math.min(90, Math.max(7, parseInt(c.req.query('days') || '30')))
  await ensureDailyStats(db)
  try {
    const rows = await query<Record<string, number>>(
      db,
      `SELECT date, users, posts, comments, ratings, checkins, likes, novels
       FROM admin_daily_stats WHERE date >= ? ORDER BY date ASC`,
      [bjDate(days - 1)]
    )
    if (rows.length > 0) {
      const byDate = new Map<string, Record<string, number>>()
      for (const r of rows) byDate.set(String(r.date), r)
      const series: Record<string, { d: string; c: number }[]> = {}
      for (const key of TREND_KEYS) {
        series[key] = Array.from({ length: days }, (_, i) => {
          const d = bjDate(days - 1 - i)
          return { d, c: Number(byDate.get(d)?.[key]) || 0 }
        })
      }
      // 今天的数据次日才入快照，最后一格实时补齐
      const todayStr = bjDate()
      const todayIdx = series.users.findIndex(s => s.d === todayStr)
      if (todayIdx >= 0) {
        const [todayPairs, novelToday] = await Promise.all([
          Promise.all(DAILY_TABLES.map(async ([key, table]) => [key, await bucketCount(db, table, 0, 1)] as const)),
          queryOne<{ c: number }>(
            db,
            `SELECT COUNT(*) AS c FROM novels WHERE deleted_at IS NULL
             AND created_at >= CAST(strftime('%s', 'now', '${CN_TZ}', 'start of day') AS INTEGER)`
          ).catch(() => null),
        ])
        for (const [key, v] of todayPairs) series[key][todayIdx].c = v
        if (novelToday) series.novels[todayIdx].c = (novelToday.c ?? 0) || series.novels[todayIdx].c
      }
      return c.json({ days, series })
    }
  } catch { /* 快照表不存在 → 回退旧路径 */ }

  // 旧直连路径（兼容）
  const shift = `-${days} days`
  const sinceText = `datetime('now', '${CN_TZ}', ?)`
  const sinceUnix = `CAST(strftime('%s', 'now', '${CN_TZ}', ?) AS INTEGER)`

  const [users, posts, comments, ratings, checkins, likes, novels] = await Promise.all([
    dailySeries(db, 'users', `WHERE created_at >= ${sinceText}`, [shift]),
    dailySeries(db, 'posts', `WHERE created_at >= ${sinceText}`, [shift]),
    dailySeries(db, 'post_comments', `WHERE created_at >= ${sinceText}`, [shift]),
    dailySeries(db, 'ratings', `WHERE created_at >= ${sinceText}`, [shift]),
    dailySeries(db, 'daily_checkins', `WHERE created_at >= ${sinceText}`, [shift]),
    dailySeries(db, 'likes', `WHERE created_at >= ${sinceText}`, [shift]),
    dailySeriesUnix(db, 'novels', `WHERE deleted_at IS NULL AND created_at >= ${sinceUnix}`, [shift]),
  ])

  return c.json({ days, series: { users, posts, comments, ratings, checkins, likes, novels } })
})

// ============================================================
// GET /api/admin/comments — 评论管理（分页 + 搜索）
// ============================================================
admin.get('/comments', adminMiddleware, async (c) => {
  const db = c.env.abdl_space_db
  const page = Math.max(1, parseInt(c.req.query('page') || '1'))
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20')))
  const offset = (page - 1) * limit
  const q = (c.req.query('q') || '').trim()
  const postId = parseInt(c.req.query('post_id') || '0')

  const where: string[] = ['1=1']
  const params: unknown[] = []
  if (q) { where.push('c.content LIKE ?'); params.push(`%${q}%`) }
  if (Number.isInteger(postId) && postId > 0) { where.push('c.post_id = ?'); params.push(postId) }
  const whereSql = where.join(' AND ')

  const [totalRow, rows] = await Promise.all([
    queryOne<{ c: number }>(db, `SELECT COUNT(*) AS c FROM post_comments c WHERE ${whereSql}`, params),
    query<Record<string, unknown>>(
      db,
      `SELECT c.id, c.post_id, c.parent_id, c.content, c.created_at,
              u.id AS user_id, u.username, u.avatar,
              (SELECT COUNT(*) FROM likes WHERE target_type = 'comment' AND target_id = c.id) AS like_count
       FROM post_comments c JOIN users u ON u.id = c.user_id
       WHERE ${whereSql} ORDER BY c.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    ),
  ])

  const total = totalRow?.c ?? 0
  return c.json({
    comments: rows.map(r => ({
      id: r.id, post_id: r.post_id, parent_id: r.parent_id, content: r.content, created_at: r.created_at,
      user: { id: r.user_id, username: r.username, avatar: r.avatar ?? DEFAULT_AVATAR },
      like_count: r.like_count ?? 0,
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  })
})

// ============================================================
// 小说管理（作品列表 / 状态机管理）
// ============================================================
const NOVEL_ADMIN_STATUSES = ['published', 'archived'] as const

admin.get('/novels', adminMiddleware, async (c) => {
  const db = c.env.abdl_space_db
  const page = Math.max(1, parseInt(c.req.query('page') || '1'))
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20')))
  const offset = (page - 1) * limit
  const q = (c.req.query('q') || '').trim()
  const status = (c.req.query('status') || '').trim()

  const where: string[] = ['n.deleted_at IS NULL']
  const params: unknown[] = []
  if (q) { where.push('n.title LIKE ?'); params.push(`%${q}%`) }
  if (status && status !== 'all') { where.push('n.status = ?'); params.push(status) }
  const whereSql = where.join(' AND ')

  const [totalRow, rows, statusCounts] = await Promise.all([
    queryOne<{ c: number }>(db, `SELECT COUNT(*) AS c FROM novels n WHERE ${whereSql}`, params),
    query<Record<string, unknown>>(
      db,
      `SELECT n.id, n.title, n.description, n.category, n.status, n.created_at, n.updated_at,
              u.id AS author_id, u.username AS author_username,
              (SELECT COUNT(*) FROM novel_volumes v WHERE v.novel_id = n.id AND v.deleted_at IS NULL) AS volumes,
              (SELECT COUNT(*) FROM novel_chapters ch WHERE ch.novel_id = n.id AND ch.deleted_at IS NULL) AS chapters
       FROM novels n JOIN users u ON u.id = n.author_id
       WHERE ${whereSql} ORDER BY n.updated_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    ),
    query<{ status: string; c: number }>(
      db, 'SELECT status, COUNT(*) AS c FROM novels WHERE deleted_at IS NULL GROUP BY status'
    ).catch(() => []),
  ])

  const total = totalRow?.c ?? 0
  const statusMap: Record<string, number> = {}
  for (const s of statusCounts) statusMap[s.status] = s.c
  return c.json({
    novels: rows.map(r => ({
      id: r.id, title: r.title, description: r.description || '', category: r.category || '',
      status: r.status, author: { id: r.author_id, username: r.author_username },
      volumes: r.volumes ?? 0, chapters: r.chapters ?? 0,
      created_at: r.created_at, updated_at: r.updated_at,
    })),
    statusCounts: statusMap,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  })
})

admin.post('/novels/:id/status', adminMiddleware, async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ status?: string }>()
  const status = body?.status
  if (!status || !(NOVEL_ADMIN_STATUSES as readonly string[]).includes(status)) {
    return c.json({ error: '仅支持 published / archived' }, 400)
  }
  const db = c.env.abdl_space_db
  const novel = await queryOne<{ id: string; status: string }>(
    db, 'SELECT id, status FROM novels WHERE id = ? AND deleted_at IS NULL', [id])
  if (!novel) return c.json({ error: '作品不存在' }, 404)
  if (novel.status === status) return c.json({ ok: true, status })
  await run(db, 'UPDATE novels SET status = ?, updated_at = unixepoch() WHERE id = ?', [status, id])
  return c.json({ ok: true, status })
})

// ============================================================
// 站点设置 — site_settings 查看 / 编辑
// ============================================================
const SETTINGS_KEY_RE = /^[a-z0-9_]{1,64}$/

admin.get('/settings', adminMiddleware, async (c) => {
  const rows = await query<Record<string, unknown>>(
    c.env.abdl_space_db, 'SELECT key, value, updated_at FROM site_settings ORDER BY key')
  return c.json({ settings: rows.map(r => ({ key: r.key, value: r.value, updated_at: r.updated_at })) })
})

admin.put('/settings', adminMiddleware, async (c) => {
  const body = await c.req.json<{ key?: string; value?: string }>()
  const key = body?.key || ''
  const value = body?.value ?? ''
  if (!SETTINGS_KEY_RE.test(key)) return c.json({ error: 'key 仅允许小写字母/数字/下划线，长度 ≤ 64' }, 422)
  if (typeof value !== 'string' || value.length > 8000) return c.json({ error: 'value 必须为字符串且长度 ≤ 8000' }, 422)
  await run(c.env.abdl_space_db,
    `INSERT INTO site_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value])
  return c.json({ ok: true, key, updated_at: new Date().toISOString() })
})

// ============================================================
// 邮箱屏蔽名单 — 命中的邮箱在注册/绑定/找回申请验证码时被 send-code 直接拒绝
// ============================================================
const BLOCKED_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

admin.get('/blocked-emails', adminMiddleware, async (c) => {
  const rows = await query<{ email: string; reason: string; created_by: number | null; created_at: string }>(
    c.env.abdl_space_db,
    `SELECT b.email, b.reason, b.created_by, b.created_at, u.username AS created_by_username
     FROM email_blocklist b LEFT JOIN users u ON u.id = b.created_by
     ORDER BY b.created_at DESC`)
  return c.json({ emails: rows })
})

admin.post('/blocked-emails', adminMiddleware, async (c) => {
  const db = c.env.abdl_space_db
  const body = await c.req.json<{ email?: string; reason?: string }>().catch(() => null)
  const email = (body?.email || '').trim().toLowerCase()
  const reason = (body?.reason || '').trim()
  if (!BLOCKED_EMAIL_RE.test(email)) return c.json({ error: '请输入有效的邮箱地址' }, 400)
  if (reason.length > 200) return c.json({ error: '屏蔽原因长度不能超过 200 字符' }, 422)
  const adminId = c.get('user')?.sub ?? null
  const exists = await queryOne<{ email: string }>(
    db, 'SELECT email FROM email_blocklist WHERE email = ?', [email]).catch(() => null)
  if (exists) return c.json({ error: '该邮箱已在屏蔽名单中' }, 409)
  await run(db,
    'INSERT INTO email_blocklist (email, reason, created_by, created_at) VALUES (?, ?, ?, datetime(\'now\'))',
    [email, reason, adminId])
  return c.json({ ok: true, email })
})

admin.delete('/blocked-emails/:email', adminMiddleware, async (c) => {
  const email = decodeURIComponent(c.req.param('email') || '').trim().toLowerCase()
  if (!BLOCKED_EMAIL_RE.test(email)) return c.json({ error: '邮箱格式无效' }, 400)
  const res = await run(c.env.abdl_space_db, 'DELETE FROM email_blocklist WHERE email = ?', [email])
  if (!res || (res as { meta?: { changes?: number } }).meta?.changes === 0) {
    return c.json({ error: '该邮箱不在屏蔽名单中' }, 404)
  }
  return c.json({ ok: true, email })
})

export default admin
