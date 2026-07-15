import { Hono } from 'hono'
const DEFAULT_AVATAR = 'https://img.abdl-space.top/file/system/1781439303787_play_store_512.png'
import type { Env, JWTPayload } from '../types/index.ts'
import { query, queryOne, run } from '../lib/db.ts'
import { authMiddleware } from '../middleware/auth.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const messages = new Hono<AppType>()

/**
 * 检查是否允许发消息（完整权限规则）
 */
async function canSendMessage(db: D1Database, senderId: number, receiverId: number): Promise<string | null> {
  if (senderId === receiverId) return '不能给自己发消息'
  const receiver = await queryOne<{ id: number }>(db, 'SELECT id FROM users WHERE id = ?', [receiverId])
  if (!receiver) return '用户不存在'
  const settings = await queryOne<{ allow_messages: number; allow_messages_from: string }>(
    db, 'SELECT allow_messages, allow_messages_from FROM user_settings WHERE user_id = ?', [receiverId],
  )
  if (!settings) return null // 默认允许
  if (settings.allow_messages === 0) return '该用户已关闭私信功能'
  if (settings.allow_messages_from === 'none') return '该用户不允许接收私信'
  if (settings.allow_messages_from === 'followers') {
    const isFollower = await queryOne<{ id: number }>(
      db, 'SELECT id FROM follows WHERE follower_id = ? AND following_id = ?', [senderId, receiverId],
    )
    if (!isFollower) return '对方只接受关注者的私信'
  }
  if (settings.allow_messages_from === 'mutual') {
    const mutual = await queryOne<{ id: number }>(
      db, `SELECT f1.id FROM follows f1 JOIN follows f2 ON f1.following_id = f2.follower_id
           WHERE f1.follower_id = ? AND f1.following_id = ? AND f2.follower_id = ? AND f2.following_id = ?`,
      [senderId, receiverId, receiverId, senderId],
    )
    if (!mutual) return '对方只接受互相关注者的私信'
  }
  return null
}

/**
 * 写 message.new 事件和 outbox（为 sender 和 receiver 各写一条）
 * 使用条件式 INSERT 依靠唯一索引去重
 */
async function writeMessageEvents(db: D1Database, messageId: number, senderId: number, receiverId: number, messageRow: any) {
  const payload = JSON.stringify(messageRow)
  // 为 sender 写事件
  await run(db,
    `INSERT INTO message_events (user_id, event_type, message_id, peer_id, payload)
     SELECT ?, 'message.new', ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM message_events WHERE user_id = ? AND event_type = 'message.new' AND message_id = ?)`,
    [senderId, messageId, receiverId, payload, senderId, messageId],
  )
  // 为 receiver 写事件
  await run(db,
    `INSERT INTO message_events (user_id, event_type, message_id, peer_id, payload)
     SELECT ?, 'message.new', ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM message_events WHERE user_id = ? AND event_type = 'message.new' AND message_id = ?)`,
    [receiverId, messageId, senderId, payload, receiverId, messageId],
  )
  // 写 outbox（sender 和 receiver 的事件都入队）
  await run(db,
    `INSERT INTO message_outbox (event_id)
     SELECT id FROM message_events WHERE message_id = ? AND event_type = 'message.new'
     AND id NOT IN (SELECT event_id FROM message_outbox)`,
    [messageId],
  )
}

/**
 * GET /api/messages/conversations — 对话列表
 */
messages.get('/conversations', authMiddleware, async (c) => {
  const user = c.get('user')

  const rows = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT other_id, content as last_msg, created_at as last_time, msg_id as last_msg_id
     FROM (
       SELECT
         CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END as other_id,
         content, created_at, id as msg_id,
         ROW_NUMBER() OVER (
           PARTITION BY CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END
           ORDER BY created_at DESC, id DESC
         ) as rn
       FROM messages
       WHERE sender_id = ? OR receiver_id = ?
     )
     WHERE rn = 1
     ORDER BY created_at DESC, msg_id DESC`,
    [user.sub, user.sub, user.sub, user.sub],
  )

  const otherIds = rows.map(r => r.other_id as number)

  const usersMap = new Map<number, { username: string; avatar: string | null }>()
  if (otherIds.length > 0) {
    const otherUsers = await query<{ id: number; username: string; avatar: string | null }>(
      c.env.abdl_space_db,
      `SELECT id, username, avatar FROM users WHERE id IN (${otherIds.map(() => '?').join(',')})`,
      otherIds,
    )
    for (const u of otherUsers) usersMap.set(u.id, { username: u.username, avatar: u.avatar ?? DEFAULT_AVATAR })
  }

  const unreadMap = new Map<number, number>()
  if (otherIds.length > 0) {
    const unreadRows = await query<{ sender_id: number; cnt: number }>(
      c.env.abdl_space_db,
      `SELECT sender_id, COUNT(*) as cnt FROM messages
       WHERE receiver_id = ? AND read = 0 AND sender_id IN (${otherIds.map(() => '?').join(',')})
       GROUP BY sender_id`,
      [user.sub, ...otherIds],
    )
    for (const u of unreadRows) unreadMap.set(u.sender_id, u.cnt)
  }

  const conversations = rows.map(r => {
    const u = usersMap.get(r.other_id as number)
    return {
      user_id: r.other_id,
      username: u?.username || '未知用户',
      avatar: u?.avatar ?? DEFAULT_AVATAR,
      last_message: r.last_msg,
      last_message_at: r.last_time,
      last_message_id: r.last_msg_id,
      unread_count: unreadMap.get(r.other_id as number) ?? 0,
    }
  })

  return c.json({ conversations })
})

/**
 * GET /api/messages/:userId — 与某用户的消息记录（cursor 分页）
 */
messages.get('/:userId', authMiddleware, async (c) => {
  const user = c.get('user')
  const otherId = parseInt(c.req.param('userId') ?? '0')
  const beforeId = parseInt(c.req.query('before_id') ?? '0')
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '50')))

  let sql: string
  let params: unknown[]

  if (beforeId > 0) {
    sql = `SELECT m.id, m.sender_id, m.receiver_id, m.content, m.client_msg_id, m.read, m.created_at,
                  u.username as sender_name
           FROM messages m
           JOIN users u ON m.sender_id = u.id
           WHERE ((m.sender_id = ? AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = ?))
           AND m.id < ?
           ORDER BY m.id DESC
           LIMIT ?`
    params = [user.sub, otherId, otherId, user.sub, beforeId, limit]
  } else {
    sql = `SELECT m.id, m.sender_id, m.receiver_id, m.content, m.client_msg_id, m.read, m.created_at,
                  u.username as sender_name
           FROM messages m
           JOIN users u ON m.sender_id = u.id
           WHERE (m.sender_id = ? AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = ?)
           ORDER BY m.id DESC
           LIMIT ?`
    params = [user.sub, otherId, otherId, user.sub, limit]
  }

  const rows = await query<Record<string, unknown>>(c.env.abdl_space_db, sql, params)

  // reverse 为升序返回给客户端
  rows.reverse()

  const messagesList = rows.map(r => ({
    id: r.id,
    sender_id: r.sender_id,
    receiver_id: r.receiver_id,
    content: r.content,
    client_msg_id: r.client_msg_id,
    read: !!r.read,
    created_at: r.created_at,
  }))

  return c.json({ messages: messagesList })
})

/**
 * POST /api/messages — 发送消息（原子幂等 + 事件 + outbox）
 */
messages.post('/', authMiddleware, async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ receiver_id: number; content: string; client_msg_id?: string }>()
  const { receiver_id, content, client_msg_id } = body

  if (!receiver_id || !content?.trim()) {
    return c.json({ error: 'receiver_id 和 content 必填' }, 400)
  }
  if (content.length > 2000) {
    return c.json({ error: '消息最长 2000 字符' }, 400)
  }

  const blocked = await canSendMessage(c.env.abdl_space_db, user.sub, receiver_id)
  if (blocked) return c.json({ error: blocked }, 403)

  const db = c.env.abdl_space_db
  const trimmedContent = content.trim()

  // 原子写入：INSERT message + events + outbox
  // Step 1: INSERT message（幂等：无目标 ON CONFLICT DO NOTHING）
  await run(db,
    'INSERT INTO messages (sender_id, receiver_id, content, client_msg_id) VALUES (?, ?, ?, ?)',
    [user.sub, receiver_id, trimmedContent, client_msg_id ?? null],
  )

  // Step 2: 查询确定的 message（新插入或已存在的冲突行）
  let messageRow: any
  if (client_msg_id) {
    messageRow = await queryOne(db,
      'SELECT * FROM messages WHERE sender_id = ? AND client_msg_id = ?',
      [user.sub, client_msg_id],
    )
  } else {
    // 无 client_msg_id 时，查询最新一条匹配
    messageRow = await queryOne(db,
      'SELECT * FROM messages WHERE sender_id = ? AND receiver_id = ? AND content = ? ORDER BY id DESC LIMIT 1',
      [user.sub, receiver_id, trimmedContent],
    )
  }

  if (!messageRow) return c.json({ error: '发送失败' }, 500)

  // Step 3: 校验冲突行的 receiver/content
  if (client_msg_id && messageRow.receiver_id !== receiver_id) {
    return c.json({ error: 'client_msg_id 已被使用' }, 409)
  }

  // Step 4: 写事件和 outbox
  await writeMessageEvents(db, messageRow.id, user.sub, receiver_id, messageRow)

  // Step 5: 获取最新 event_id 并入队 outbox
  const latestEvent = await queryOne<{ id: number }>(db,
    'SELECT MAX(id) as id FROM message_events WHERE message_id = ?',
    [messageRow.id],
  )

  // 异步入队 outbox（不阻塞响应）
  try {
    if (c.env.MESSAGE_OUTBOX_QUEUE && latestEvent?.id) {
      await c.env.MESSAGE_OUTBOX_QUEUE.send({ eventId: latestEvent.id })
    }
  } catch (e) {
    console.error('Failed to enqueue outbox:', e)
    // 不阻塞响应 — cron 扫尾会补
  }

  return c.json({
    event_id: latestEvent?.id || 0,
    message: {
      id: messageRow.id,
      sender_id: messageRow.sender_id,
      receiver_id: messageRow.receiver_id,
      content: messageRow.content as string,
      client_msg_id: messageRow.client_msg_id as string | null,
      created_at: messageRow.created_at,
    },
  }, 201)
})

/**
 * POST /api/messages/:userId/read — 标记已读（watermark）
 */
messages.post('/:userId/read', authMiddleware, async (c) => {
  const user = c.get('user')
  const otherId = parseInt(c.req.param('userId') ?? '0')
  const body = await c.req.json<{ read_up_to_id?: number }>()
  const readUpToId = body.read_up_to_id

  const db = c.env.abdl_space_db

  if (!readUpToId) {
    return c.json({ error: 'read_up_to_id 必填' }, 400)
  }

  // 只标记 id <= read_up_to_id 的未读消息
  await run(db,
    'UPDATE messages SET read = 1 WHERE sender_id = ? AND receiver_id = ? AND read = 0 AND id <= ?',
    [otherId, user.sub, readUpToId],
  )

  // 为双方写 message.read 事件
  const readPayload = JSON.stringify({ peer_id: otherId, reader_id: user.sub, read_up_to_id: readUpToId })
  // 给阅读者自己写（同步到其他设备）
  await run(db,
    `INSERT INTO message_events (user_id, event_type, peer_id, read_up_to_id, payload)
     SELECT ?, 'message.read', ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM message_events WHERE user_id = ? AND event_type = 'message.read' AND peer_id = ? AND read_up_to_id = ?)`,
    [user.sub, otherId, readUpToId, readPayload, user.sub, otherId, readUpToId],
  )
  // 给对方写（通知已读）
  await run(db,
    `INSERT INTO message_events (user_id, event_type, peer_id, read_up_to_id, payload)
     SELECT ?, 'message.read', ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM message_events WHERE user_id = ? AND event_type = 'message.read' AND peer_id = ? AND read_up_to_id = ?)`,
    [otherId, user.sub, readUpToId, readPayload, otherId, user.sub, readUpToId],
  )
  // 写 outbox
  await run(db,
    `INSERT INTO message_outbox (event_id)
     SELECT id FROM message_events WHERE event_type = 'message.read' AND read_up_to_id = ? AND peer_id = ?
     AND id NOT IN (SELECT event_id FROM message_outbox)`,
    [readUpToId, otherId],
  )

  // 异步入队 outbox
  try {
    if (c.env.MESSAGE_OUTBOX_QUEUE) {
      const readEvents = await query<{ id: number }>(db,
        'SELECT id FROM message_events WHERE event_type = \'message.read\' AND read_up_to_id = ? AND peer_id = ?',
        [readUpToId, otherId],
      )
      for (const ev of readEvents) {
        await c.env.MESSAGE_OUTBOX_QUEUE.send({ eventId: ev.id })
      }
    }
  } catch (e) {
    console.error('Failed to enqueue read outbox:', e)
  }

  return c.json({ message: '已标为已读' })
})

/**
 * POST /api/messages/typing — 发送正在输入（不落库，直接 DO 推送）
 */
messages.post('/typing', authMiddleware, async (c) => {
  const body = await c.req.json<{ receiver_id: number }>()
  if (!body.receiver_id) return c.json({ error: 'receiver_id required' }, 400)
  // TODO: Task 5 接入 DO 推送
  return c.json({ ok: true })
})

/**
 * GET /api/messages/sync — 持久化增量同步
 */
messages.get('/sync', authMiddleware, async (c) => {
  const user = c.get('user')
  const afterEventId = parseInt(c.req.query('after_event_id') || '0')
  const throughEventId = parseInt(c.req.query('through_event_id') || '0')
  const limit = Math.min(200, Math.max(1, parseInt(c.req.query('limit') || '100')))

  const db = c.env.abdl_space_db

  // 如果未指定 through_event_id，查询当前用户最大事件 ID 作为边界
  let boundary = throughEventId
  if (!boundary) {
    const maxRow = await queryOne<{ max_id: number }>(db,
      'SELECT MAX(id) as max_id FROM message_events WHERE user_id = ?',
      [user.sub],
    )
    boundary = maxRow?.max_id || 0
  }

  const rows = await query<{ id: number; event_type: string; message_id: number | null; peer_id: number; read_up_to_id: number | null; payload: string; created_at: number }>(
    db,
    `SELECT id, event_type, message_id, peer_id, read_up_to_id, payload, created_at
     FROM message_events
     WHERE user_id = ? AND id > ? AND id <= ?
     ORDER BY id ASC
     LIMIT ?`,
    [user.sub, afterEventId, boundary, limit],
  )

  const events = rows.map(r => ({
    event_id: r.id,
    type: r.event_type,
    message_id: r.message_id,
    peer_id: r.peer_id,
    read_up_to_id: r.read_up_to_id,
    ...JSON.parse(r.payload),
    created_at: r.created_at,
  }))

  const nextEventId = rows.length > 0 ? rows[rows.length - 1].id + 1 : afterEventId + 1

  return c.json({
    events,
    sync_boundary: boundary,
    next_event_id: nextEventId,
    has_more: rows.length >= limit,
  })
})

export default messages
