import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { query, queryOne, run } from '../lib/db.ts'
import { authMiddleware } from '../middleware/auth.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const messages = new Hono<AppType>()

/**
 * GET /api/messages/conversations — 对话列表
 */
messages.get('/conversations', authMiddleware, async (c) => {
  const user = c.get('user')

  // Fix BUG-003: Use subquery to get latest message per conversation
  // Fix BUG-007: Batch query user info and unread counts
  const rows = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT other_id, content as last_msg, created_at as last_time
     FROM (
       SELECT
         CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END as other_id,
         content, created_at,
         ROW_NUMBER() OVER (
           PARTITION BY CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END
           ORDER BY created_at DESC
         ) as rn
       FROM messages
       WHERE sender_id = ? OR receiver_id = ?
     )
     WHERE rn = 1
     ORDER BY created_at DESC`,
    [user.sub, user.sub, user.sub, user.sub]
  )

  const otherIds = rows.map(r => r.other_id as number)

  // Batch query user info
  const usersMap = new Map<number, { username: string; avatar: string | null }>()
  if (otherIds.length > 0) {
    const otherUsers = await query<{ id: number; username: string; avatar: string | null }>(
      c.env.abdl_space_db,
      `SELECT id, username, avatar FROM users WHERE id IN (${otherIds.map(() => '?').join(',')})`,
      otherIds
    )
    for (const u of otherUsers) usersMap.set(u.id, { username: u.username, avatar: u.avatar })
  }

  // Batch query unread counts
  const unreadMap = new Map<number, number>()
  if (otherIds.length > 0) {
    const unreadRows = await query<{ sender_id: number; cnt: number }>(
      c.env.abdl_space_db,
      `SELECT sender_id, COUNT(*) as cnt FROM messages
       WHERE receiver_id = ? AND read = 0 AND sender_id IN (${otherIds.map(() => '?').join(',')})
       GROUP BY sender_id`,
      [user.sub, ...otherIds]
    )
    for (const u of unreadRows) unreadMap.set(u.sender_id, u.cnt)
  }

  const conversations = rows.map(r => {
    const u = usersMap.get(r.other_id as number)
    return {
      user_id: r.other_id,
      username: u?.username || '未知用户',
      avatar: u?.avatar ?? null,
      last_message: r.last_msg,
      last_message_at: r.last_time,
      unread_count: unreadMap.get(r.other_id as number) ?? 0,
    }
  })

  return c.json({ conversations })
})

/**
 * GET /api/messages/:userId — 与某用户的消息记录
 */
messages.get('/:userId', authMiddleware, async (c) => {
  const user = c.get('user')
  const otherId = parseInt(c.req.param('userId'))
  const page = Math.max(1, parseInt(c.req.query('page') || '1'))
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '50')))
  const offset = (page - 1) * limit

  const rows = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT m.id, m.sender_id, m.receiver_id, m.content, m.read, m.created_at,
            u.username as sender_name
     FROM messages m
     JOIN users u ON m.sender_id = u.id
     WHERE (m.sender_id = ? AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = ?)
     ORDER BY m.created_at ASC
     LIMIT ? OFFSET ?`,
    [user.sub, otherId, otherId, user.sub, limit, offset]
  )

  const messagesList = rows.map(r => ({
    id: r.id,
    sender_id: r.sender_id,
    receiver_id: r.receiver_id,
    content: r.content,
    read: !!r.read,
    created_at: r.created_at,
  }))

  return c.json({ messages: messagesList })
})

/**
 * POST /api/messages — 发送消息
 */
messages.post('/', authMiddleware, async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ receiver_id: number; content: string }>()
  const { receiver_id, content } = body

  if (!receiver_id || !content?.trim()) {
    return c.json({ error: 'receiver_id 和 content 必填' }, 400)
  }
  if (content.length > 2000) {
    return c.json({ error: '消息最长 2000 字符' }, 400)
  }
  if (receiver_id === user.sub) {
    return c.json({ error: '不能给自己发消息' }, 400)
  }

  const receiver = await queryOne<{ id: number }>(
    c.env.abdl_space_db,
    'SELECT id FROM users WHERE id = ?',
    [receiver_id]
  )
  if (!receiver) return c.json({ error: '用户不存在' }, 404)

  const settings = await queryOne<{ allow_messages: number }>(
    c.env.abdl_space_db,
    'SELECT allow_messages FROM user_settings WHERE user_id = ?',
    [receiver_id]
  )
  if (settings && settings.allow_messages === 0) {
    return c.json({ error: '该用户已关闭私信功能' }, 403)
  }

  const result = await run(
    c.env.abdl_space_db,
    'INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)',
    [user.sub, receiver_id, content.trim()]
  )

  return c.json({ id: result.meta.last_row_id, message: '发送成功' }, 201)
})

/**
 * POST /api/messages/:userId/read — 标记已读
 */
messages.post('/:userId/read', authMiddleware, async (c) => {
  const user = c.get('user')
  const otherId = parseInt(c.req.param('userId'))

  await run(
    c.env.abdl_space_db,
    'UPDATE messages SET read = 1 WHERE sender_id = ? AND receiver_id = ? AND read = 0',
    [otherId, user.sub]
  )

  return c.json({ message: '已标为已读' })
})

export default messages
