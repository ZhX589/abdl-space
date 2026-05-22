import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { query, queryOne, run } from '../lib/db.ts'
import { authMiddleware, adminMiddleware } from '../middleware/auth.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const reports = new Hono<AppType>()

/**
 * POST /api/reports — 提交举报
 */
reports.post('/', authMiddleware, async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ target_type: string; target_id: number; reason: string; description?: string }>()
  const { target_type, target_id, reason, description } = body

  if (!['post', 'comment'].includes(target_type)) return c.json({ error: '无效的举报类型' }, 400)
  if (!target_id || typeof target_id !== 'number') return c.json({ error: '无效的目标 ID' }, 400)
  if (!['nsfw', 'spam', 'other'].includes(reason)) return c.json({ error: '无效的举报原因' }, 400)

  if (target_type === 'post') {
    const post = await queryOne<{ id: number }>(c.env.abdl_space_db, 'SELECT id FROM posts WHERE id = ?', [target_id])
    if (!post) return c.json({ error: '帖子不存在' }, 404)
  } else {
    const comment = await queryOne<{ id: number }>(c.env.abdl_space_db, 'SELECT id FROM post_comments WHERE id = ?', [target_id])
    if (!comment) return c.json({ error: '评论不存在' }, 404)
  }

  const existing = await queryOne<{ id: number }>(
    c.env.abdl_space_db,
    'SELECT id FROM reports WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND status = ?',
    [user.sub, target_type, target_id, 'pending']
  )
  if (existing) return c.json({ error: '您已举报过该内容，请等待处理' }, 409)

  await run(
    c.env.abdl_space_db,
    'INSERT INTO reports (reporter_id, target_type, target_id, reason, description) VALUES (?, ?, ?, ?, ?)',
    [user.sub, target_type, target_id, reason, description || null]
  )

  return c.json({ message: '举报已提交，感谢您的反馈' }, 201)
})

/**
 * GET /api/reports/admin — 管理员查看举报列表
 */
reports.get('/admin', adminMiddleware, async (c) => {
  const status = c.req.query('status') || 'pending'
  const page = Math.max(1, parseInt(c.req.query('page') || '1'))
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '20')))
  const offset = (page - 1) * limit

  const rows = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT r.*, u.username as reporter_name
     FROM reports r JOIN users u ON r.reporter_id = u.id
     WHERE r.status = ?
     ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
    [status, limit, offset]
  )

  const countResult = await query<{ total: number }>(
    c.env.abdl_space_db,
    'SELECT COUNT(*) as total FROM reports WHERE status = ?',
    [status]
  )

  const enriched = await Promise.all(rows.map(async (r) => {
    let content = ''
    if (r.target_type === 'post') {
      const post = await queryOne<{ content: string }>(c.env.abdl_space_db, 'SELECT content FROM posts WHERE id = ?', [r.target_id])
      content = post?.content?.slice(0, 100) || '(已删除)'
    } else {
      const comment = await queryOne<{ content: string }>(c.env.abdl_space_db, 'SELECT content FROM post_comments WHERE id = ?', [r.target_id])
      content = comment?.content?.slice(0, 100) || '(已删除)'
    }
    return { ...r, content_preview: content }
  }))

  return c.json({ reports: enriched, pagination: { page, limit, total: countResult[0]?.total ?? 0 } })
})

/**
 * PATCH /api/reports/admin/:id — 处理举报
 */
reports.patch('/admin/:id', adminMiddleware, async (c) => {
  const user = c.get('user')
  const id = parseInt(c.req.param('id'))
  const body = await c.req.json<{ action: 'resolve' | 'dismiss'; delete_content?: boolean }>()
  const { action, delete_content } = body

  const report = await queryOne<{ id: number; target_type: string; target_id: number; status: string }>(
    c.env.abdl_space_db, 'SELECT * FROM reports WHERE id = ?', [id]
  )
  if (!report) return c.json({ error: '举报不存在' }, 404)
  if (report.status !== 'pending') return c.json({ error: '该举报已处理' }, 400)

  const newStatus = action === 'resolve' ? 'resolved' : 'dismissed'
  await run(c.env.abdl_space_db, 'UPDATE reports SET status = ?, resolved_by = ? WHERE id = ?', [newStatus, user.sub, id])

  if (delete_content && action === 'resolve') {
    if (report.target_type === 'post') {
      await run(c.env.abdl_space_db, 'DELETE FROM posts WHERE id = ?', [report.target_id])
    } else {
      // 删除评论图片
      const cmtImages = await query<{ image_url: string }>(
        c.env.abdl_space_db, 'SELECT image_url FROM comment_images WHERE comment_id = ?', [report.target_id]
      )
      for (const img of cmtImages) {
        await deleteImageFromImgbed(c.env, img.image_url)
      }
      await run(c.env.abdl_space_db, 'DELETE FROM post_comments WHERE id = ?', [report.target_id])
    }
  }

  return c.json({ message: action === 'resolve' ? '举报已处理' : '举报已驳回' })
})

export default reports
