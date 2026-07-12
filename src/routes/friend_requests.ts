import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { query, queryOne, run } from '../lib/db.ts'
import { authMiddleware, adminMiddleware } from '../middleware/auth.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const friendRequests = new Hono<AppType>()

// ============================================================
// 列表与详情
// ============================================================

/**
 * GET /api/friend-request/list — 交友请求列表
 * Query: page, limit, search, looking_for
 */
friendRequests.get('/list', async (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') || '1'))
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '20')))
  const offset = (page - 1) * limit
  const search = c.req.query('search') || ''
  const lookingFor = c.req.query('looking_for') || ''

  const db = c.env.abdl_space_db

  let where = "fr.status = 'active' AND (fr.created_at > datetime('now', '-3 days') OR fr.id IN (SELECT request_id FROM friend_request_reports WHERE status = 'pending'))"
  const params: any[] = []

  if (search) {
    where += ' AND (fr.title LIKE ? OR fr.description LIKE ?)'
    params.push(`%${search}%`, `%${search}%`)
  }
  if (lookingFor) {
    where += ' AND fr.looking_for = ?'
    params.push(lookingFor)
  }

  const rows = await query<any>(
    db,
    `SELECT fr.*, u.username, u.avatar, u.display_name
     FROM friend_requests fr
     JOIN users u ON fr.user_id = u.id
     WHERE ${where}
     ORDER BY fr.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  )

  const countResult = await queryOne<{ total: number }>(
    db,
    `SELECT COUNT(*) as total FROM friend_requests fr WHERE ${where}`,
    params
  )

  // 批量获取字段
  const requestIds = rows.map(r => r.id)
  let fieldsMap = new Map<number, any[]>()
  if (requestIds.length > 0) {
    const ph = requestIds.map(() => '?').join(',')
    const fields = await query<any>(
      db,
      `SELECT * FROM friend_request_fields WHERE request_id IN (${ph}) ORDER BY sort_order`,
      requestIds
    )
    for (const f of fields) {
      if (!fieldsMap.has(f.request_id)) fieldsMap.set(f.request_id, [])
      fieldsMap.get(f.request_id)!.push(f)
    }
  }

  // 批量获取评论数
  let commentCountMap = new Map<number, number>()
  if (requestIds.length > 0) {
    const ph = requestIds.map(() => '?').join(',')
    const counts = await query<{ request_id: number; cnt: number }>(
      db,
      `SELECT request_id, COUNT(*) as cnt FROM friend_request_comments WHERE request_id IN (${ph}) GROUP BY request_id`,
      requestIds
    )
    for (const c of counts) commentCountMap.set(c.request_id, c.cnt)
  }

  const enriched = rows.map(r => ({
    id: r.id,
    user_id: r.user_id,
    title: r.title,
    looking_for: r.looking_for,
    description: r.description,
    status: r.status,
    created_at: r.created_at,
    updated_at: r.updated_at,
    user: {
      username: r.username,
      avatar: r.avatar || 'https://img.abdl-space.top/file/system/1781439303787_play_store_512.png',
      display_name: r.display_name || r.username,
    },
    fields: fieldsMap.get(r.id) || [],
    comment_count: commentCountMap.get(r.id) || 0,
  }))

  return c.json({
    requests: enriched,
    pagination: { page, limit, total: countResult?.total ?? 0 },
  })
})

/**
 * GET /api/friend-request/my — 我的交友请求
 */
friendRequests.get('/my', authMiddleware, async (c) => {
  const user = c.get('user')
  const db = c.env.abdl_space_db

  const rows = await query<any>(
    db,
    `SELECT fr.*, u.username, u.avatar, u.display_name
     FROM friend_requests fr
     JOIN users u ON fr.user_id = u.id
     WHERE fr.user_id = ?
     ORDER BY fr.created_at DESC`,
    [user.sub]
  )

  const requestIds = rows.map(r => r.id)
  let fieldsMap = new Map<number, any[]>()
  if (requestIds.length > 0) {
    const ph = requestIds.map(() => '?').join(',')
    const fields = await query<any>(
      db,
      `SELECT * FROM friend_request_fields WHERE request_id IN (${ph}) ORDER BY sort_order`,
      requestIds
    )
    for (const f of fields) {
      if (!fieldsMap.has(f.request_id)) fieldsMap.set(f.request_id, [])
      fieldsMap.get(f.request_id)!.push(f)
    }
  }

  let commentCountMap = new Map<number, number>()
  if (requestIds.length > 0) {
    const ph = requestIds.map(() => '?').join(',')
    const counts = await query<{ request_id: number; cnt: number }>(
      db,
      `SELECT request_id, COUNT(*) as cnt FROM friend_request_comments WHERE request_id IN (${ph}) GROUP BY request_id`,
      requestIds
    )
    for (const c of counts) commentCountMap.set(c.request_id, c.cnt)
  }

  const enriched = rows.map(r => ({
    id: r.id,
    user_id: r.user_id,
    title: r.title,
    looking_for: r.looking_for,
    description: r.description,
    status: r.status,
    created_at: r.created_at,
    updated_at: r.updated_at,
    user: {
      username: r.username,
      avatar: r.avatar || 'https://img.abdl-space.top/file/system/1781439303787_play_store_512.png',
      display_name: r.display_name || r.username,
    },
    fields: fieldsMap.get(r.id) || [],
    comment_count: commentCountMap.get(r.id) || 0,
  }))

  return c.json({ requests: enriched })
})

/**
 * GET /api/friend-request/:id — 交友请求详情
 */
friendRequests.get('/:id', async (c) => {
  const id = parseInt(c.req.param('id') || '0')
  if (!id) return c.json({ error: 'Invalid id' }, 400)

  const db = c.env.abdl_space_db

  const row = await queryOne<any>(
    db,
    `SELECT fr.*, u.username, u.avatar, u.display_name
     FROM friend_requests fr
     JOIN users u ON fr.user_id = u.id
     WHERE fr.id = ? AND (fr.status = 'active' OR fr.status = 'reported')`,
    [id]
  )
  if (!row) return c.json({ error: '交友请求不存在' }, 404)

  const fields = await query<any>(
    db,
    'SELECT * FROM friend_request_fields WHERE request_id = ? ORDER BY sort_order',
    [id]
  )

  const commentCount = await queryOne<{ cnt: number }>(
    db,
    'SELECT COUNT(*) as cnt FROM friend_request_comments WHERE request_id = ?',
    [id]
  )

  return c.json({
    id: row.id,
    user_id: row.user_id,
    title: row.title,
    looking_for: row.looking_for,
    description: row.description,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    user: {
      username: row.username,
      avatar: row.avatar || 'https://img.abdl-space.top/file/system/1781439303787_play_store_512.png',
      display_name: row.display_name || row.username,
    },
    fields,
    comment_count: commentCount?.cnt ?? 0,
  })
})

// ============================================================
// CRUD
// ============================================================

/**
 * POST /api/friend-request/create — 创建交友请求
 */
friendRequests.post('/create', authMiddleware, async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{
    title?: string
    looking_for: string
    description?: string
    fields?: { field_key: string; field_value: string; is_primary?: number }[]
  }>()

  if (!body.looking_for?.trim()) return c.json({ error: '交友类型为必填' }, 400)
  if (body.title && body.title.length > 100) return c.json({ error: '标题不能超过100字' }, 400)
  if (body.description && body.description.length > 2000) return c.json({ error: '描述不能超过2000字' }, 400)

  const db = c.env.abdl_space_db

  // 插入新记录
  const result = await run(
    db,
    'INSERT INTO friend_requests (user_id, title, looking_for, description) VALUES (?, ?, ?, ?)',
    [user.sub, body.title?.trim() || null, body.looking_for.trim(), body.description?.trim() || null]
  )
  const requestId = result.meta.last_row_id as number

  // 插入自定义字段
  if (body.fields && body.fields.length > 0) {
    for (let i = 0; i < body.fields.length; i++) {
      const f = body.fields[i]
      if (f.field_key?.trim() && f.field_value?.trim()) {
        await run(
          db,
          'INSERT INTO friend_request_fields (request_id, field_key, field_value, is_primary, sort_order) VALUES (?, ?, ?, ?, ?)',
          [requestId, f.field_key.trim(), f.field_value.trim(), f.is_primary || 0, i]
        )
      }
    }
  }

  return c.json({ id: requestId, message: '创建成功' }, 201)
})

/**
 * DELETE /api/friend-request/:id — 删除交友请求（创建快照，status=deleted）
 */
friendRequests.delete('/:id', authMiddleware, async (c) => {
  const user = c.get('user')
  const id = parseInt(c.req.param('id') || '0')
  const db = c.env.abdl_space_db

  const existing = await queryOne<any>(
    db,
    `SELECT fr.*, u.username, u.avatar, u.display_name
     FROM friend_requests fr
     JOIN users u ON fr.user_id = u.id
     WHERE fr.id = ? AND fr.user_id = ?`,
    [id, user.sub]
  )
  if (!existing) return c.json({ error: '交友请求不存在或无权删除' }, 404)

  // 获取所有字段
  const fields = await query<any>(
    db,
    'SELECT * FROM friend_request_fields WHERE request_id = ? ORDER BY sort_order',
    [id]
  )

  // 创建快照
  const snapshot = {
    id: existing.id,
    user_id: existing.user_id,
    title: existing.title,
    looking_for: existing.looking_for,
    description: existing.description,
    status: existing.status,
    created_at: existing.created_at,
    user: {
      username: existing.username,
      avatar: existing.avatar,
      display_name: existing.display_name,
    },
    fields,
  }

  await run(
    db,
    'INSERT INTO friend_request_snapshots (original_id, user_id, data, snapshot_type) VALUES (?, ?, ?, ?)',
    [id, user.sub, JSON.stringify(snapshot), 'delete']
  )

  // 标记为已删除
  await run(db, "UPDATE friend_requests SET status = 'deleted', updated_at = datetime('now') WHERE id = ?", [id])

  return c.json({ message: '已删除' })
})

// ============================================================
// 评论
// ============================================================

/**
 * GET /api/friend-request/:id/comments — 评论列表（1级嵌套）
 */
friendRequests.get('/:id/comments', async (c) => {
  const id = parseInt(c.req.param('id') || '0')
  if (!id) return c.json({ error: 'Invalid id' }, 400)

  const db = c.env.abdl_space_db

  // 检查交友请求是否存在
  const fr = await queryOne<{ id: number }>(db, 'SELECT id FROM friend_requests WHERE id = ?', [id])
  if (!fr) return c.json({ error: '交友请求不存在' }, 404)

  // 获取所有评论
  const rows = await query<any>(
    db,
    `SELECT frc.*, u.username, u.avatar, u.display_name
     FROM friend_request_comments frc
     JOIN users u ON frc.user_id = u.id
     WHERE frc.request_id = ?
     ORDER BY frc.created_at ASC`,
    [id]
  )

  // 构建1级嵌套
  const rootComments = rows.filter(r => !r.parent_id)
  const childMap = new Map<number, any[]>()
  for (const r of rows) {
    if (r.parent_id) {
      if (!childMap.has(r.parent_id)) childMap.set(r.parent_id, [])
      childMap.get(r.parent_id)!.push({
        id: r.id,
        user_id: r.user_id,
        parent_id: r.parent_id,
        content: r.content,
        created_at: r.created_at,
        user: {
          username: r.username,
          avatar: r.avatar || 'https://img.abdl-space.top/file/system/1781439303787_play_store_512.png',
          display_name: r.display_name || r.username,
        },
      })
    }
  }

  const enriched = rootComments.map(r => ({
    id: r.id,
    user_id: r.user_id,
    parent_id: r.parent_id,
    content: r.content,
    created_at: r.created_at,
    user: {
      username: r.username,
      avatar: r.avatar || 'https://img.abdl-space.top/file/system/1781439303787_play_store_512.png',
      display_name: r.display_name || r.username,
    },
    replies: childMap.get(r.id) || [],
  }))

  return c.json({ comments: enriched })
})

/**
 * POST /api/friend-request/:id/comment — 发表评论
 */
friendRequests.post('/:id/comment', authMiddleware, async (c) => {
  const user = c.get('user')
  const id = parseInt(c.req.param('id') || '0')
  const body = await c.req.json<{ content: string; parent_id?: number }>()

  if (!body.content?.trim()) return c.json({ error: '评论内容不能为空' }, 400)
  if (body.content.length > 500) return c.json({ error: '评论不能超过500字' }, 400)

  const db = c.env.abdl_space_db

  // 检查交友请求是否存在且活跃
  const fr = await queryOne<{ id: number; status: string }>(
    db, "SELECT id, status FROM friend_requests WHERE id = ? AND status IN ('active', 'reported')", [id]
  )
  if (!fr) return c.json({ error: '交友请求不存在' }, 404)

  // 如果有 parent_id，检查父评论是否存在
  if (body.parent_id) {
    const parent = await queryOne<{ id: number; request_id: number }>(
      db, 'SELECT id, request_id FROM friend_request_comments WHERE id = ? AND request_id = ?',
      [body.parent_id, id]
    )
    if (!parent) return c.json({ error: '父评论不存在' }, 404)
  }

  const result = await run(
    db,
    'INSERT INTO friend_request_comments (request_id, user_id, parent_id, content) VALUES (?, ?, ?, ?)',
    [id, user.sub, body.parent_id || null, body.content.trim()]
  )

  return c.json({ id: result.meta.last_row_id, message: '评论成功' }, 201)
})

/**
 * DELETE /api/friend-request/comment/:id — 删除评论（自己/管理员）
 */
friendRequests.delete('/comment/:id', authMiddleware, async (c) => {
  const user = c.get('user')
  const id = parseInt(c.req.param('id') || '0')
  const db = c.env.abdl_space_db

  const comment = await queryOne<{ id: number; user_id: number }>(
    db, 'SELECT id, user_id FROM friend_request_comments WHERE id = ?', [id]
  )
  if (!comment) return c.json({ error: '评论不存在' }, 404)

  // 只有自己或管理员能删除
  if (comment.user_id !== user.sub && user.role !== 'admin') {
    return c.json({ error: '无权删除' }, 403)
  }

  // 删除子评论
  await run(db, 'DELETE FROM friend_request_comments WHERE parent_id = ?', [id])
  await run(db, 'DELETE FROM friend_request_comments WHERE id = ?', [id])

  return c.json({ message: '已删除' })
})

// ============================================================
// 举报
// ============================================================

/**
 * POST /api/friend-request/:id/report — 举报（立即隐藏+邮件通知管理员）
 */
friendRequests.post('/:id/report', authMiddleware, async (c) => {
  const user = c.get('user')
  const id = parseInt(c.req.param('id') || '0')
  const body = await c.req.json<{ reason: string; evidence_urls?: string[] }>()

  if (!body.reason?.trim()) return c.json({ error: '举报原因不能为空' }, 400)
  if (body.evidence_urls && body.evidence_urls.length > 3) return c.json({ error: '最多上传3张图片' }, 400)

  const db = c.env.abdl_space_db

  // 检查交友请求是否存在
  const fr = await queryOne<{ id: number; user_id: number; status: string; title: string }>(
    db, 'SELECT id, user_id, status, title FROM friend_requests WHERE id = ?', [id]
  )
  if (!fr) return c.json({ error: '交友请求不存在' }, 404)
  if (fr.user_id === user.sub) return c.json({ error: '不能举报自己的交友请求' }, 400)
  if (fr.status !== 'active') return c.json({ error: '该请求已被举报或删除' }, 400)

  // 检查是否已举报
  const existing = await queryOne<{ id: number }>(
    db,
    "SELECT id FROM friend_request_reports WHERE reporter_id = ? AND request_id = ? AND status = 'pending'",
    [user.sub, id]
  )
  if (existing) return c.json({ error: '您已举报过该内容，请等待处理' }, 409)

  // 插入举报记录
  await run(
    db,
    'INSERT INTO friend_request_reports (request_id, reporter_id, reason, evidence_urls) VALUES (?, ?, ?, ?)',
    [id, user.sub, body.reason.trim(), body.evidence_urls ? JSON.stringify(body.evidence_urls) : null]
  )

  // 立即隐藏：status = 'reported'
  await run(db, "UPDATE friend_requests SET status = 'reported', updated_at = datetime('now') WHERE id = ?", [id])

  // 邮件通知管理员（异步，不阻塞响应）
  c.executionCtx.waitUntil((async () => {
    try {
      const reporter = await queryOne<{ username: string }>(db, 'SELECT username FROM users WHERE id = ?', [user.sub])
      const { sendTencentEmail } = await import('../lib/ses.ts')
      await sendTencentEmail(
        '3806526113@qq.com',
        `[ABDL Space] 新的交友请求举报`,
        0, // 模板ID需要在腾讯云SES控制台创建
        JSON.stringify({
          title: fr.title,
          reporter: reporter?.username || '未知用户',
          reason: body.reason.trim(),
          request_id: String(id),
        }),
        c.env
      )
    } catch (e) {
      console.error('Failed to send report notification email:', e)
    }
  })())

  return c.json({ message: '举报已提交，感谢您的反馈' }, 201)
})

// ============================================================
// 管理员举报管理
// ============================================================

/**
 * GET /api/friend-request/admin/reports — 管理员举报列表
 */
friendRequests.get('/admin/reports', adminMiddleware, async (c) => {
  const status = c.req.query('status') || 'pending'
  const page = Math.max(1, parseInt(c.req.query('page') || '1'))
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '20')))
  const offset = (page - 1) * limit

  const db = c.env.abdl_space_db

  const rows = await query<any>(
    db,
    `SELECT frr.*, u.username as reporter_name, u.email as reporter_email,
            fr.title as request_title, fr.looking_for, fr.description as request_description,
            fr.user_id as request_user_id,
            ru.username as request_username, ru.email as request_user_email
     FROM friend_request_reports frr
     JOIN users u ON frr.reporter_id = u.id
     JOIN friend_requests fr ON frr.request_id = fr.id
     JOIN users ru ON fr.user_id = ru.id
     WHERE frr.status = ?
     ORDER BY frr.created_at DESC
     LIMIT ? OFFSET ?`,
    [status, limit, offset]
  )

  const countResult = await queryOne<{ total: number }>(
    db,
    'SELECT COUNT(*) as total FROM friend_request_reports WHERE status = ?',
    [status]
  )

  // 获取被举报交友请求的字段
  const requestIds = [...new Set(rows.map(r => r.request_id))]
  let fieldsMap = new Map<number, any[]>()
  if (requestIds.length > 0) {
    const ph = requestIds.map(() => '?').join(',')
    const fields = await query<any>(
      db,
      `SELECT * FROM friend_request_fields WHERE request_id IN (${ph}) ORDER BY sort_order`,
      requestIds
    )
    for (const f of fields) {
      if (!fieldsMap.has(f.request_id)) fieldsMap.set(f.request_id, [])
      fieldsMap.get(f.request_id)!.push(f)
    }
  }

  const enriched = rows.map(r => ({
    id: r.id,
    request_id: r.request_id,
    reporter_id: r.reporter_id,
    reason: r.reason,
    evidence_urls: r.evidence_urls ? JSON.parse(r.evidence_urls) : [],
    status: r.status,
    admin_reply: r.admin_reply,
    created_at: r.created_at,
    resolved_at: r.resolved_at,
    reporter: { username: r.reporter_name, email: r.reporter_email },
    request: {
      id: r.request_id,
      title: r.request_title,
      looking_for: r.looking_for,
      description: r.request_description,
      user_id: r.request_user_id,
      username: r.request_username,
      user_email: r.request_user_email,
      fields: fieldsMap.get(r.request_id) || [],
    },
  }))

  return c.json({
    reports: enriched,
    pagination: { page, limit, total: countResult?.total ?? 0 },
  })
})

/**
 * POST /api/friend-request/admin/reports/:id/accept — 采纳举报（删除+封禁+快照+邮件通知）
 */
friendRequests.post('/admin/reports/:id/accept', adminMiddleware, async (c) => {
  const admin = c.get('user')
  const id = parseInt(c.req.param('id') || '0')
  const db = c.env.abdl_space_db

  const report = await queryOne<any>(
    db,
    `SELECT frr.*, fr.user_id, fr.title, fr.status as request_status,
            ru.email as user_email, ru.username as user_username
     FROM friend_request_reports frr
     JOIN friend_requests fr ON frr.request_id = fr.id
     JOIN users ru ON fr.user_id = ru.id
     WHERE frr.id = ? AND frr.status = 'pending'`,
    [id]
  )
  if (!report) return c.json({ error: '举报不存在或已处理' }, 404)

  // 获取完整交友请求数据用于快照
  const fr = await queryOne<any>(
    db,
    `SELECT fr.*, u.username, u.avatar, u.display_name
     FROM friend_requests fr
     JOIN users u ON fr.user_id = u.id
     WHERE fr.id = ?`,
    [report.request_id]
  )
  const fields = await query<any>(
    db,
    'SELECT * FROM friend_request_fields WHERE request_id = ? ORDER BY sort_order',
    [report.request_id]
  )

  // 创建快照
  if (fr) {
    const snapshot = {
      id: fr.id,
      user_id: fr.user_id,
      title: fr.title,
      looking_for: fr.looking_for,
      description: fr.description,
      status: fr.status,
      created_at: fr.created_at,
      user: { username: fr.username, avatar: fr.avatar, display_name: fr.display_name },
      fields,
    }
    await run(
      db,
      'INSERT INTO friend_request_snapshots (original_id, user_id, data, snapshot_type) VALUES (?, ?, ?, ?)',
      [report.request_id, fr.user_id, JSON.stringify(snapshot), 'report_delete']
    )
  }

  // 删除交友请求
  await run(db, "UPDATE friend_requests SET status = 'deleted', updated_at = datetime('now') WHERE id = ?", [report.request_id])

  // 封禁用户
  const hasBannedColumn = await queryOne<{ cid: number }>(
    db, "SELECT cid FROM pragma_table_info('users') WHERE name = 'banned'"
  )
  if (!hasBannedColumn) {
    await run(db, 'ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0')
  }
  await run(db, 'UPDATE users SET banned = 1 WHERE id = ?', [report.user_id])

  // 更新举报状态
  await run(
    db,
    "UPDATE friend_request_reports SET status = 'resolved', resolved_by = ?, resolved_at = datetime('now') WHERE id = ?",
    [admin.sub, id]
  )

  // 邮件通知被举报人
  c.executionCtx.waitUntil((async () => {
    try {
      if (report.user_email) {
        const { sendTencentEmail } = await import('../lib/ses.ts')
        await sendTencentEmail(
          report.user_email,
          '[ABDL Space] 您的交友请求已被处理',
          0,
          JSON.stringify({
            title: report.request_title,
            reason: report.reason,
            reply: '您的交友请求因违反社区规定已被删除，账户已被封禁。',
          }),
          c.env
        )
      }
    } catch (e) {
      console.error('Failed to send ban notification email:', e)
    }
  })())

  return c.json({ message: '已采纳：删除交友请求并封禁用户' })
})

/**
 * POST /api/friend-request/admin/reports/:id/dismiss — 驳回举报（恢复+邮件通知举报人）
 */
friendRequests.post('/admin/reports/:id/dismiss', adminMiddleware, async (c) => {
  const admin = c.get('user')
  const id = parseInt(c.req.param('id') || '0')
  const body = await c.req.json<{ reply?: string }>()
  const db = c.env.abdl_space_db

  const report = await queryOne<any>(
    db,
    `SELECT frr.*, fr.user_id, fr.title, fr.status as request_status,
            ru.email as reporter_email, ru.username as reporter_username
     FROM friend_request_reports frr
     JOIN friend_requests fr ON frr.request_id = fr.id
     JOIN users ru ON frr.reporter_id = ru.id
     WHERE frr.id = ? AND frr.status = 'pending'`,
    [id]
  )
  if (!report) return c.json({ error: '举报不存在或已处理' }, 404)

  // 更新举报状态
  await run(
    db,
    "UPDATE friend_request_reports SET status = 'dismissed', resolved_by = ?, admin_reply = ?, resolved_at = datetime('now') WHERE id = ?",
    [admin.sub, body.reply || null, id]
  )

  // 如果交友请求未被用户删除，恢复为 active
  if (report.request_status === 'reported') {
    await run(db, "UPDATE friend_requests SET status = 'active', updated_at = datetime('now') WHERE id = ?", [report.request_id])
  }

  // 邮件通知举报人
  c.executionCtx.waitUntil((async () => {
    try {
      if (report.reporter_email) {
        const { sendTencentEmail } = await import('../lib/ses.ts')
        await sendTencentEmail(
          report.reporter_email,
          '[ABDL Space] 您的举报已被处理',
          0,
          JSON.stringify({
            title: report.title,
            result: '驳回',
            reply: body.reply || '经管理员审核，该举报不成立。',
          }),
          c.env
        )
      }
    } catch (e) {
      console.error('Failed to send dismiss notification email:', e)
    }
  })())

  return c.json({ message: '已驳回' })
})

export default friendRequests
