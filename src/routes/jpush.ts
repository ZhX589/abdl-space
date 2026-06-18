import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { query, run } from '../lib/db.ts'
import { authMiddleware } from '../middleware/auth.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const jpush = new Hono<AppType>()

/**
 * POST /api/jpush/register — 注册极光推送 regId
 * Body: { regId: string }
 */
jpush.post('/register', authMiddleware, async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ regId: string }>()

  if (!body.regId) return c.json({ error: 'regId required' }, 400)

  const db = c.env.abdl_space_db

  // 检查是否已注册
  const existing = await query<{ id: number }>(
    db, 'SELECT id FROM jpush_registrations WHERE user_id = ? AND reg_id = ?',
    [user.sub, body.regId]
  )

  if (existing.length === 0) {
    await run(db,
      'INSERT INTO jpush_registrations (user_id, reg_id, created_at) VALUES (?, ?, unixepoch())',
      [user.sub, body.regId]
    )
  }

  // 更新最后活跃时间
  await run(db,
    'UPDATE jpush_registrations SET last_active_at = unixepoch() WHERE user_id = ? AND reg_id = ?',
    [user.sub, body.regId]
  )

  return c.json({ success: true })
})

/**
 * DELETE /api/jpush/unregister — 注销极光推送
 * Body: { regId: string }
 */
jpush.delete('/unregister', authMiddleware, async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ regId: string }>()

  if (!body.regId) return c.json({ error: 'regId required' }, 400)

  const db = c.env.abdl_space_db
  await run(db,
    'DELETE FROM jpush_registrations WHERE user_id = ? AND reg_id = ?',
    [user.sub, body.regId]
  )

  return c.json({ success: true })
})

/**
 * GET /api/jpush/my-registrations — 查询当前用户的注册列表
 */
jpush.get('/my-registrations', authMiddleware, async (c) => {
  const user = c.get('user')
  const db = c.env.abdl_space_db

  const rows = await query<{ reg_id: string; last_active_at: number }>(
    db, 'SELECT reg_id, last_active_at FROM jpush_registrations WHERE user_id = ?',
    [user.sub]
  )

  return c.json({ registrations: rows })
})

/**
 * POST /api/jpush/send — 发送推送（内部调用）
 * Body: { userId: number, title: string, content: string, extras?: object }
 */
jpush.post('/send', async (c) => {
  const db = c.env.abdl_space_db
  const body = await c.req.json<{ userId: number; title: string; content: string; extras?: Record<string, string> }>()

  if (!body.userId || !body.title || !body.content) {
    return c.json({ error: 'userId, title, content required' }, 400)
  }

  // 查询用户的所有 regId
  const rows = await query<{ reg_id: string }>(
    db, 'SELECT reg_id FROM jpush_registrations WHERE user_id = ?',
    [body.userId]
  )

  if (rows.length === 0) {
    return c.json({ success: true, sent: 0, message: '用户无注册设备' })
  }

  const regIds = rows.map(r => r.reg_id)

  // 调用极光推送 API 发送
  const appKey = '6aa46fed3b8f49a6d26ad1a1'
  const masterSecret = '5a3ee59eb63462139a67d231'

  const payload = {
    platform: 'all',
    audience: { registration_id: regIds },
    notification: {
      alert: body.content,
      title: body.title,
      android: {
        extras: body.extras || {},
        notification_channel: 'abdl-space'
      }
    }
  }

  try {
    const response = await fetch('https://api.jpush.cn/v3/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${btoa(`${appKey}:${masterSecret}`)}`
      },
      body: JSON.stringify(payload)
    })

    const result = await response.json()

    if (result.code === 0) {
      return c.json({ success: true, sent: regIds.length, msg_id: result.data?.msg_id })
    } else {
      return c.json({ success: false, error: result.message || '推送失败' })
    }
  } catch (e) {
    return c.json({ success: false, error: e.message })
  }
})

export default jpush
