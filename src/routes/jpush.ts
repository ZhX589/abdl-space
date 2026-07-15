import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { query, run } from '../lib/db.ts'
import { authMiddleware } from '../middleware/auth.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const INSTANCE_DOMAIN = 'abdl-space.top'

const jpush = new Hono<AppType>()

/**
 * POST /api/jpush/register — 注册极光推送 regId
 * 策略：一台设备 regId 只绑定当前活跃账号
 * Body: { regId: string }
 */
jpush.post('/register', authMiddleware, async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ regId: string }>()

  if (!body.regId) return c.json({ error: 'regId required' }, 400)

  const db = c.env.abdl_space_db
  const accountId = `${INSTANCE_DOMAIN}_${user.sub}`

  // 先删除该 regId 的其他用户绑定（一设备一账号）
  await run(db,
    'DELETE FROM jpush_registrations WHERE reg_id = ? AND user_id != ?',
    [body.regId, user.sub],
  )

  // 检查当前用户是否已有该 regId
  const existing = await query<{ id: number }>(
    db, 'SELECT id FROM jpush_registrations WHERE user_id = ? AND reg_id = ?',
    [user.sub, body.regId],
  )

  if (existing.length === 0) {
    await run(db,
      'INSERT INTO jpush_registrations (user_id, reg_id, created_at) VALUES (?, ?, unixepoch())',
      [user.sub, body.regId],
    )
  }

  // 更新最后活跃时间
  await run(db,
    'UPDATE jpush_registrations SET last_active_at = unixepoch() WHERE user_id = ? AND reg_id = ?',
    [user.sub, body.regId],
  )

  return c.json({ success: true, account_id: accountId })
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
    [user.sub, body.regId],
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
    [user.sub],
  )

  const accountId = `${INSTANCE_DOMAIN}_${user.sub}`
  return c.json({ registrations: rows.map(r => ({ ...r, account_id: accountId })) })
})

// 内部发送 API — 只供 Worker 内部调用（outbox dispatcher）
// 已移至 src/lib/jpush.ts 的 sendJPushToUser 函数

export default jpush
