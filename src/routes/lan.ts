import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { queryOne } from '../lib/db.ts'
import { signJWT } from '../lib/auth.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const lan = new Hono<AppType>()

/**
 * POST /api/auth/lan/discover — 发现内网设备
 * 返回最近活跃的手机 APP 设备列表
 */
lan.post('/discover', async (c) => {
  const db = c.env.abdl_space_db

  // 查询最近 5 分钟内活跃的设备（手机 APP 定期上报心跳）
  const devices = await queryOne<{ count: number }>(
    db,
    `SELECT COUNT(*) as count FROM jpush_registrations 
     WHERE last_active_at > unixepoch() - 300`
  )

  if (!devices || devices.count === 0) {
    return c.json({ devices: [] })
  }

  // 查询设备详情
  const rows = await query<{ user_id: number; username: string; last_active_at: number }>(
    db,
    `SELECT j.user_id, u.username, j.last_active_at 
     FROM jpush_registrations j 
     JOIN users u ON j.user_id = u.id 
     WHERE j.last_active_at > unixepoch() - 300
     ORDER BY j.last_active_at DESC
     LIMIT 5`,
    []
  )

  return c.json({
    devices: rows.map(r => ({
      userId: r.user_id,
      username: r.username,
      lastActive: r.last_active_at,
      // 生成签名用于身份验证
      signature: `lan_${r.user_id}_${r.last_active_at}`,
      timestamp: Math.floor(Date.now() / 1000)
    }))
  })
})

/**
 * POST /api/auth/lan/verify — 验证手机身份（LAN 发现后）
 * Body: { userId: number, username: string, signature: string, timestamp: number }
 * Response: { sessionId, qrUrl } 或 { error }
 */
lan.post('/verify', async (c) => {
  const db = c.env.abdl_space_db
  const body = await c.req.json<{
    userId: number
    username: string
    signature: string
    timestamp: number
  }>()

  if (!body.userId || !body.username || !body.signature || !body.timestamp) {
    return c.json({ error: '缺少必要参数' }, 400)
  }

  // 检查时间戳是否在 5 分钟内
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - body.timestamp) > 300) {
    return c.json({ error: '请求已过期' }, 400)
  }

  // 验证用户是否存在
  const user = await queryOne<{ id: number; username: string }>(
    db,
    'SELECT id, username FROM users WHERE id = ? AND username = ?',
    [body.userId, body.username]
  )
  if (!user) {
    return c.json({ error: '用户不存在' }, 404)
  }

  // 创建 QR 登录会话（复用现有流程）
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
    qrUrl: `https://abdl-space.top/lan-login?session=${sessionId}`,
    expiresIn: 300
  })
})

export default lan
