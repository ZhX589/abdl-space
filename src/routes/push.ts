import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { query, queryOne, run } from '../lib/db.ts'
import { authMiddleware, adminMiddleware } from '../middleware/auth.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const push = new Hono<AppType>()

// ============================================================
// 用户端：Web Push 订阅管理
// ============================================================

/**
 * POST /api/push/subscribe — 保存 Web Push 订阅
 */
push.post('/subscribe', authMiddleware, async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{
    platform?: string
    endpoint?: string
    p256dh?: string
    auth?: string
    registration_id?: string
    device_info?: Record<string, string>
  }>()

  const platform = body.platform || 'web'
  const db = c.env.abdl_space_db

  if (platform === 'web') {
    if (!body.endpoint) return c.json({ error: 'endpoint required' }, 400)

    // Upsert: 先删除旧的同 endpoint 订阅，再插入新的
    await run(db,
      'DELETE FROM push_subscriptions WHERE user_id = ? AND platform = ? AND endpoint = ?',
      [user.sub, 'web', body.endpoint]
    )

    await run(db,
      `INSERT INTO push_subscriptions (user_id, platform, endpoint, p256dh, auth, device_info, created_at)
       VALUES (?, 'web', ?, ?, ?, ?, unixepoch())`,
      [user.sub, body.endpoint, body.p256dh || null, body.auth || null, JSON.stringify(body.device_info || {})]
    )
  } else if (platform === 'jpush') {
    if (!body.registration_id) return c.json({ error: 'registration_id required' }, 400)

    // Upsert JPush registration
    const existing = await queryOne<{ id: number }>(
      db, 'SELECT id FROM push_subscriptions WHERE user_id = ? AND platform = ? AND registration_id = ?',
      [user.sub, 'jpush', body.registration_id]
    )

    if (!existing) {
      await run(db,
        `INSERT INTO push_subscriptions (user_id, platform, registration_id, alias, device_info, created_at)
         VALUES (?, 'jpush', ?, ?, ?, unixepoch())`,
        [user.sub, body.registration_id, String(user.sub), JSON.stringify(body.device_info || {})]
      )
    } else {
      await run(db,
        'UPDATE push_subscriptions SET last_active_at = unixepoch() WHERE id = ?',
        [existing.id]
      )
    }
  }

  return c.json({ success: true })
})

/**
 * DELETE /api/push/subscribe — 删除当前用户的推送订阅
 */
push.delete('/subscribe', authMiddleware, async (c) => {
  const user = c.get('user')
  const db = c.env.abdl_space_db

  await run(db, 'DELETE FROM push_subscriptions WHERE user_id = ?', [user.sub])
  return c.json({ success: true })
})

/**
 * GET /api/push/status — 查询当前用户订阅状态
 */
push.get('/status', authMiddleware, async (c) => {
  const user = c.get('user')
  const db = c.env.abdl_space_db

  const webCount = await queryOne<{ cnt: number }>(
    db, 'SELECT COUNT(*) as cnt FROM push_subscriptions WHERE user_id = ? AND platform = ?',
    [user.sub, 'web']
  )

  const jpushCount = await queryOne<{ cnt: number }>(
    db, 'SELECT COUNT(*) as cnt FROM push_subscriptions WHERE user_id = ? AND platform = ?',
    [user.sub, 'jpush']
  )

  return c.json({
    web: webCount?.cnt || 0,
    jpush: jpushCount?.cnt || 0,
  })
})

/**
 * GET /api/push/vapid-key — 获取 VAPID 公钥（公开接口）
 */
push.get('/vapid-key', async (c) => {
  const db = c.env.abdl_space_db
  const config = await queryOne<{ vapid_public_key: string }>(
    db, 'SELECT vapid_public_key FROM push_config WHERE id = 1'
  )

  if (!config?.vapid_public_key) {
    return c.json({ error: 'VAPID key not configured' }, 404)
  }

  return c.json({ publicKey: config.vapid_public_key })
})

// ============================================================
// 管理端：推送管理
// ============================================================

/**
 * GET /api/admin/push/stats — 统计数据
 */
push.get('/admin/stats', adminMiddleware, async (c) => {
  const db = c.env.abdl_space_db

  const webCount = await queryOne<{ cnt: number }>(
    db, 'SELECT COUNT(*) as cnt FROM push_subscriptions WHERE platform = ?',
    ['web']
  )

  const jpushCount = await queryOne<{ cnt: number }>(
    db, 'SELECT COUNT(*) as cnt FROM push_subscriptions WHERE platform = ?',
    ['jpush']
  )

  const todaySent = await queryOne<{ cnt: number }>(
    db, "SELECT COUNT(*) as cnt FROM push_logs WHERE created_at > unixepoch() - 86400",
    []
  )

  const todayFailed = await queryOne<{ total: number }>(
    db, "SELECT SUM(fail_count) as total FROM push_logs WHERE created_at > unixepoch() - 86400",
    []
  )

  return c.json({
    web_count: webCount?.cnt || 0,
    jpush_count: jpushCount?.cnt || 0,
    today_sent: todaySent?.cnt || 0,
    today_failed: todayFailed?.total || 0,
  })
})

/**
 * GET /api/admin/push/logs — 推送记录列表
 */
push.get('/admin/logs', adminMiddleware, async (c) => {
  const page = Number(c.req.query('page') || 1)
  const limit = 20
  const offset = (page - 1) * limit
  const db = c.env.abdl_space_db

  const logs = await query<{
    id: number
    sender_id: number | null
    target_type: string
    title: string
    body: string
    url: string | null
    platform: string
    sent_count: number
    fail_count: number
    jpush_msg_id: string | null
    created_at: number
  }>(
    db, 'SELECT * FROM push_logs ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [limit, offset]
  )

  const total = await queryOne<{ cnt: number }>(
    db, 'SELECT COUNT(*) as cnt FROM push_logs', []
  )

  return c.json({ logs, total: total?.cnt || 0, page, limit })
})

/**
 * POST /api/admin/push/send — 发送推送通知
 */
push.post('/admin/send', adminMiddleware, async (c) => {
  const senderId = c.get('user').sub
  const body = await c.req.json<{
    target_type: string
    target_ids?: number[]
    title: string
    body: string
    url?: string
    platform?: string
  }>()

  if (!body.title || !body.body) {
    return c.json({ error: 'title and body required' }, 400)
  }

  const db = c.env.abdl_space_db
  let targetUserIds: number[] = []

  if (body.target_type === 'all') {
    const allUsers = await query<{ user_id: number }>(
      db, 'SELECT DISTINCT user_id FROM push_subscriptions', []
    )
    targetUserIds = allUsers.map(u => u.user_id)
  } else if (body.target_type === 'user' && body.target_ids) {
    targetUserIds = body.target_ids
  }

  let webSent = 0
  let jpushSent = 0
  let failed = 0

  // 获取 JPush 配置
  const jpushConfig = await queryOne<{
    jpush_app_key: string
    jpush_master_secret: string
    jpush_enabled: number
  }>(db, 'SELECT jpush_app_key, jpush_master_secret, jpush_enabled FROM push_config WHERE id = 1')

  for (const userId of targetUserIds) {
    const subs = await query<{
      id: number
      platform: string
      endpoint: string | null
      p256dh: string | null
      auth: string | null
      registration_id: string | null
    }>(
      db, 'SELECT * FROM push_subscriptions WHERE user_id = ?',
      [userId]
    )

    for (const sub of subs) {
      try {
        if (sub.platform === 'web' && sub.endpoint) {
          // TODO: Web Push 发送（需要 web-push 库或原生加密）
          // 暂时跳过，后续用 web-push 库实现
          webSent++
        } else if (sub.platform === 'jpush' && sub.registration_id && jpushConfig?.jpush_enabled) {
          // JPush 发送
          const auth = btoa(`${jpushConfig.jpush_app_key}:${jpushConfig.jpush_master_secret}`)
          const payload = {
            platform: 'all',
            audience: { registration_id: [sub.registration_id] },
            notification: {
              alert: body.body,
              android: {
                alert: body.body,
                title: body.title,
                extras: { url: body.url || '/notifications' },
              },
              ios: {
                alert: { title: body.title, body: body.body },
                sound: 'default',
                extras: { url: body.url || '/notifications' },
              },
            },
            options: { apns_production: true },
          }

          const res = await fetch('https://api.jpush.cn/v3/push', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Basic ${auth}`,
            },
            body: JSON.stringify(payload),
          })

          const result = await res.json() as { code?: number; msg_id?: string }
          if (result.code === 0) {
            jpushSent++
          } else {
            failed++
          }
        }
      } catch {
        failed++
      }
    }
  }

  // 记录推送日志
  await run(db,
    `INSERT INTO push_logs (sender_id, target_type, target_ids, title, body, url, platform, sent_count, fail_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`,
    [
      senderId,
      body.target_type,
      JSON.stringify(targetUserIds),
      body.title,
      body.body,
      body.url || null,
      body.platform || 'all',
      webSent + jpushSent,
      failed,
    ]
  )

  return c.json({ success: true, webSent, jpushSent, failed })
})

/**
 * POST /api/admin/push/test — 发送测试推送
 */
push.post('/admin/test', adminMiddleware, async (c) => {
  const body = await c.req.json<{ user_id: number }>()
  if (!body.user_id) return c.json({ error: 'user_id required' }, 400)

  const db = c.env.abdl_space_db

  // 获取 JPush 配置
  const jpushConfig = await queryOne<{
    jpush_app_key: string
    jpush_master_secret: string
    jpush_enabled: number
  }>(db, 'SELECT jpush_app_key, jpush_master_secret, jpush_enabled FROM push_config WHERE id = 1')

  const subs = await query<{
    platform: string
    registration_id: string | null
  }>(
    db, 'SELECT platform, registration_id FROM push_subscriptions WHERE user_id = ?',
    [body.user_id]
  )

  let sent = 0

  for (const sub of subs) {
    if (sub.platform === 'jpush' && sub.registration_id && jpushConfig?.jpush_enabled) {
      const auth = btoa(`${jpushConfig.jpush_app_key}:${jpushConfig.jpush_master_secret}`)
      const payload = {
        platform: 'all',
        audience: { registration_id: [sub.registration_id] },
        notification: {
          alert: '这是一条测试推送',
          android: { alert: '这是一条测试推送', title: 'ABDL Space 测试' },
          ios: { alert: { title: 'ABDL Space 测试', body: '这是一条测试推送' }, sound: 'default' },
        },
        options: { apns_production: true },
      }

      const res = await fetch('https://api.jpush.cn/v3/push', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${auth}`,
        },
        body: JSON.stringify(payload),
      })

      const result = await res.json() as { code?: number }
      if (result.code === 0) sent++
    }
  }

  return c.json({ success: true, sent })
})

/**
 * GET /api/admin/push/platforms — 各平台状态
 */
push.get('/admin/platforms', adminMiddleware, async (c) => {
  const db = c.env.abdl_space_db
  const config = await queryOne<{
    jpush_app_key: string | null
    jpush_enabled: number
    vapid_public_key: string | null
  }>(db, 'SELECT jpush_app_key, jpush_enabled, vapid_public_key FROM push_config WHERE id = 1')

  return c.json({
    vapidConfigured: !!config?.vapid_public_key,
    jpushEnabled: config?.jpush_enabled === 1,
    jpushAppKey: config?.jpush_app_key ? config.jpush_app_key.slice(0, 6) + '***' : null,
  })
})

/**
 * GET /api/admin/push/jpush-stats — 从极光拉取送达统计
 */
push.get('/admin/jpush-stats', adminMiddleware, async (c) => {
  const msgIds = c.req.query('msg_ids')
  if (!msgIds) return c.json({ error: 'msg_ids required' }, 400)

  const db = c.env.abdl_space_db
  const config = await queryOne<{
    jpush_app_key: string
    jpush_master_secret: string
    jpush_enabled: number
  }>(db, 'SELECT jpush_app_key, jpush_master_secret, jpush_enabled FROM push_config WHERE id = 1')

  if (!config?.jpush_enabled || !config.jpush_app_key) {
    return c.json({ error: 'JPush not configured' }, 400)
  }

  const auth = btoa(`${config.jpush_app_key}:${config.jpush_master_secret}`)
  const res = await fetch(
    `https://report.jpush.cn/v3/received/detail?msg_ids=${msgIds}`,
    { headers: { 'Authorization': `Basic ${auth}` } }
  )

  const data = await res.json()
  return c.json(data)
})

export default push
