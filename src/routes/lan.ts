import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { query, queryOne } from '../lib/db.ts'
import { authMiddleware } from '../middleware/auth.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const lan = new Hono<AppType>()

/**
 * POST /api/auth/lan/discover — 发现内网设备
 * 返回最近活跃的手机 APP 设备列表
 */
lan.post('/discover', async (c) => {
  const db = c.env.abdl_space_db

  const rows = await query<{ user_id: string; username: string; last_active_at: number }>(
    db,
    `SELECT h.user_id, u.username, h.last_active_at 
     FROM lan_heartbeats h 
     JOIN users u ON h.user_id = u.id 
     WHERE h.last_active_at > unixepoch() - 300
     ORDER BY h.last_active_at DESC
     LIMIT 5`,
    []
  )

  return c.json({
    devices: rows.map(r => ({
      userId: r.user_id,
      username: r.username,
      lastActive: r.last_active_at,
      signature: `lan_${r.user_id}_${r.last_active_at}`,
      timestamp: Math.floor(Date.now() / 1000)
    }))
  })
})

/**
 * POST /api/auth/lan/heartbeat — 手机心跳上报
 */
lan.post('/heartbeat', authMiddleware, async (c) => {
  const user = c.get('user')
  const db = c.env.abdl_space_db
  const { run } = await import('../lib/db.ts')

  const existing = await queryOne<{ id: number }>(
    db, 'SELECT id FROM lan_heartbeats WHERE user_id = ?', [user.sub]
  )

  if (existing) {
    await run(db,
      'UPDATE lan_heartbeats SET last_active_at = unixepoch() WHERE user_id = ?',
      [user.sub]
    )
  } else {
    await run(db,
      'INSERT INTO lan_heartbeats (user_id, last_active_at) VALUES (?, unixepoch())',
      [user.sub]
    )
  }

  return c.json({ success: true })
})

/**
 * POST /api/auth/lan/verify — 验证手机身份
 * Body: { userId: string, username: string, signature: string, timestamp: number }
 */
lan.post('/verify', async (c) => {
  const db = c.env.abdl_space_db
  const body = await c.req.json<{
    userId: string
    username: string
    signature: string
    timestamp: number
  }>()

  if (!body.userId || !body.username || !body.signature || !body.timestamp) {
    return c.json({ error: '缺少必要参数' }, 400)
  }

  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - body.timestamp) > 300) {
    return c.json({ error: '请求已过期' }, 400)
  }

  const user = await queryOne<{ id: string; username: string }>(
    db,
    'SELECT id, username FROM users WHERE id = ? AND username = ?',
    [body.userId, body.username]
  )
  if (!user) {
    return c.json({ error: '用户不存在' }, 404)
  }

  const sessionId = crypto.randomUUID()
  const expiresAt = now + 300

  const { run } = await import('../lib/db.ts')
  await run(db,
    `INSERT INTO qr_login_sessions (id, status, created_at, expires_at, user_id)
     VALUES (?, 'scanned', unixepoch(), ?, ?)`,
    [sessionId, expiresAt, body.userId]
  )

  return c.json({
    sessionId,
    expiresIn: 300
  })
})

/**
 * GET /api/auth/lan/pending — 查询当前用户的待授权会话
 * 需要登录认证，只返回当前用户自己的待授权会话
 */
lan.get('/pending', authMiddleware, async (c) => {
  const user = c.get('user')
  const db = c.env.abdl_space_db

  const session = await queryOne<{ id: string; status: string; created_at: number }>(
    db,
    `SELECT id, status, created_at FROM qr_login_sessions 
     WHERE user_id = ? AND status = 'scanned' AND expires_at > unixepoch()
     ORDER BY created_at DESC LIMIT 1`,
    [user.sub]
  )

  if (!session) {
    return c.json({ pending: false })
  }

  return c.json({
    pending: true,
    sessionId: session.id,
    createdAt: session.created_at
  })
})

export default lan
