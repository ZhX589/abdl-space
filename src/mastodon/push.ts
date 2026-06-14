/**
 * Mastodon-compatible WebPush subscription endpoints
 * POST/GET/PUT/DELETE /api/v1/push/subscription
 *
 * Mastodon WebPush payload format:
 * { title, body, icon, notification_id, notification_type, preferred_locale, ... }
 */

import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { queryOne, run } from '../lib/db.ts'
import { mastodonAuth } from './shared.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const push = new Hono<AppType>()

// Ensure push_subscriptions table exists
async function ensureTable(db: D1Database) {
  await db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    alerts_follow BOOLEAN DEFAULT 1,
    alerts_favourite BOOLEAN DEFAULT 1,
    alerts_reblog BOOLEAN DEFAULT 1,
    alerts_mention BOOLEAN DEFAULT 1,
    alerts_poll BOOLEAN DEFAULT 0,
    alerts_status BOOLEAN DEFAULT 0,
    server_key TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, endpoint)
  )`)
}

// ============================================================
// POST /api/v1/push/subscription — Create push subscription
// ============================================================
push.post('/subscription', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)

  await ensureTable(c.env.abdl_space_db)

  let body: {
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } }
    data?: { alerts?: { follow?: boolean; favourite?: boolean; reblog?: boolean; mention?: boolean; poll?: boolean; status?: boolean } }
  }
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid body' }, 400) }

  const { subscription, data } = body
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return c.json({ error: 'subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth required' }, 422)
  }

  const alerts = data?.alerts || {}

  // Upsert subscription
  await run(c.env.abdl_space_db,
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, alerts_follow, alerts_favourite, alerts_reblog, alerts_mention, alerts_poll, alerts_status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, endpoint) DO UPDATE SET
       p256dh = excluded.p256dh, auth = excluded.auth,
       alerts_follow = excluded.alerts_follow, alerts_favourite = excluded.alerts_favourite,
       alerts_reblog = excluded.alerts_reblog, alerts_mention = excluded.alerts_mention,
       alerts_poll = excluded.alerts_poll, alerts_status = excluded.alerts_status,
       updated_at = datetime('now')`,
    [user.sub, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth,
     alerts.follow ?? 1, alerts.favourite ?? 1, alerts.reblog ?? 1, alerts.mention ?? 1,
     alerts.poll ?? 0, alerts.status ?? 0]
  )

  // Generate server VAPID public key
  const serverKey = c.env.VAPID_PUBLIC_KEY || ''

  return c.json({
    id: String(user.sub),
    endpoint: subscription.endpoint,
    server_key: serverKey,
    alerts: {
      follow: alerts.follow ?? true,
      favourite: alerts.favourite ?? true,
      reblog: alerts.reblog ?? true,
      mention: alerts.mention ?? true,
      poll: alerts.poll ?? false,
      status: alerts.status ?? false,
    },
  })
})

// ============================================================
// GET /api/v1/push/subscription — Get current subscription
// ============================================================
push.get('/subscription', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)

  await ensureTable(c.env.abdl_space_db)

  const sub = await queryOne<Record<string, unknown>>(
    c.env.abdl_space_db,
    'SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1',
    [user.sub]
  )

  if (!sub) return c.json({ error: 'Record not found' }, 404)

  const serverKey = c.env.VAPID_PUBLIC_KEY || ''

  return c.json({
    id: String(sub.id),
    endpoint: sub.endpoint,
    server_key: serverKey,
    alerts: {
      follow: !!sub.alerts_follow,
      favourite: !!sub.alerts_favourite,
      reblog: !!sub.alerts_reblog,
      mention: !!sub.alerts_mention,
      poll: !!sub.alerts_poll,
      status: !!sub.alerts_status,
    },
  })
})

// ============================================================
// PUT /api/v1/push/subscription — Update subscription alerts
// ============================================================
push.put('/subscription', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)

  await ensureTable(c.env.abdl_space_db)

  let body: { data?: { alerts?: Record<string, boolean> } }
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid body' }, 400) }

  const alerts = body.data?.alerts || {}

  const sub = await queryOne<{ id: number }>(
    c.env.abdl_space_db, 'SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1', [user.sub]
  )
  if (!sub) return c.json({ error: 'Record not found' }, 404)

  const updates: string[] = []
  const params: unknown[] = []
  for (const [key, val] of Object.entries(alerts)) {
    const col = `alerts_${key}`
    if (['alerts_follow', 'alerts_favourite', 'alerts_reblog', 'alerts_mention', 'alerts_poll', 'alerts_status'].includes(col)) {
      updates.push(`${col} = ?`)
      params.push(val ? 1 : 0)
    }
  }
  if (updates.length > 0) {
    updates.push('updated_at = datetime(\'now\')')
    params.push(sub.id)
    await run(c.env.abdl_space_db, `UPDATE push_subscriptions SET ${updates.join(', ')} WHERE id = ?`, params)
  }

  const updated = await queryOne<Record<string, unknown>>(c.env.abdl_space_db, 'SELECT * FROM push_subscriptions WHERE id = ?', [sub.id])
  if (!updated) return c.json({ error: 'Record not found' }, 404)

  const serverKey = c.env.VAPID_PUBLIC_KEY || ''

  return c.json({
    id: String(updated.id),
    endpoint: updated.endpoint,
    server_key: serverKey,
    alerts: {
      follow: !!updated.alerts_follow,
      favourite: !!updated.alerts_favourite,
      reblog: !!updated.alerts_reblog,
      mention: !!updated.alerts_mention,
      poll: !!updated.alerts_poll,
      status: !!updated.alerts_status,
    },
  })
})

// ============================================================
// DELETE /api/v1/push/subscription — Delete subscription
// ============================================================
push.delete('/subscription', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)

  await ensureTable(c.env.abdl_space_db)
  await run(c.env.abdl_space_db, 'DELETE FROM push_subscriptions WHERE user_id = ?', [user.sub])

  return c.json({})
})

// ============================================================
// Push notification sender (called by notification creation logic)
// ============================================================
export async function sendPushNotification(
  db: D1Database,
  userId: number,
  notificationType: string,
  notificationId: number,
  title: string,
  body: string,
  icon?: string
) {
  // Check if user has subscription with this alert type enabled
  const alertCol = `alerts_${notificationType === 'favourite' ? 'favourite' : notificationType === 'reblog' ? 'reblog' : notificationType === 'follow' ? 'follow' : 'mention'}`
  const sub = await queryOne<Record<string, unknown>>(
    db,
    `SELECT * FROM push_subscriptions WHERE user_id = ? AND ${alertCol} = 1 ORDER BY updated_at DESC LIMIT 1`,
    [userId]
  )
  if (!sub) return

  // Build Mastodon-format push payload
  const pushPayload = JSON.stringify({
    access_token: '',
    notification_id: notificationId,
    notification_type: notificationType,
    icon: icon || 'https://img.abdl-space.top/file/system/1781439303787_play_store_512.png',
    title,
    body,
    preferred_locale: 'zh',
  })

  // Send via Web Push Protocol
  try {
    const endpoint = sub.endpoint as string

    // TODO: Implement actual WebPush encryption + delivery
    // Requires: VAPID private key in env, web-push library or manual encryption
    console.log(`[Push] Would send to ${endpoint}: ${title} (payload: ${pushPayload.length} bytes)`)
  } catch (err) {
    console.error('[Push] Failed:', err)
  }
}

export default push
