import type { Context, Next } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { queryOne, run } from '../lib/db.ts'
import { extractUser } from './auth.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

function getClientIp(c: Context<AppType>): string | null {
  const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim()
  return ip && ip !== 'unknown' ? ip : null
}

export async function ipSecurityMiddleware(c: Context<AppType>, next: Next): Promise<Response | void> {
  const ip = getClientIp(c)
  const db = c.env.abdl_space_db

  if (ip) {
    const ban = await queryOne<{ ip: string }>(db, 'SELECT ip FROM ip_bans WHERE ip = ?', [ip])
    if (ban) return c.json({ error: 'Access denied' }, 403)
  }

  const user = await extractUser(c)
  if (!user) return next()

  const tracking = await queryOne<{ user_id: number }>(
    db,
    'SELECT user_id FROM ip_tracking_rules WHERE user_id = ? AND enabled = 1',
    [user.sub],
  )
  if (!tracking || !ip) return next()

  const now = Math.floor(Date.now() / 1000)
  await run(
    db,
    'INSERT INTO ip_tracking_events (user_id, ip, user_agent, path, created_at) VALUES (?, ?, ?, ?, ?)',
    [user.sub, ip, c.req.header('User-Agent') || '', c.req.path, now],
  )
  await run(
    db,
    `INSERT INTO ip_bans (ip, source_user_id, reason, created_by, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(ip) DO NOTHING`,
    [ip, user.sub, 'Tracked account access', user.sub, now],
  )

  return c.json({ error: 'Access denied' }, 403)
}
