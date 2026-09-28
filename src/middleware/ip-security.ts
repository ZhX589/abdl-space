import type { Context, Next } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { queryOne, run } from '../lib/db.ts'
import { cacheIpBan, cacheTrackingRule, getCachedIpBan, getCachedTrackingRule } from '../lib/ip-security-cache.ts'
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
    const cachedBan = getCachedIpBan(ip)
    if (cachedBan === true) return c.json({ error: 'Access denied' }, 403)
    if (cachedBan === undefined) {
      try {
        const ban = await queryOne<{ ip: string }>(db, 'SELECT ip FROM ip_bans WHERE ip = ?', [ip])
        cacheIpBan(ip, !!ban)
        if (ban) return c.json({ error: 'Access denied' }, 403)
      } catch {
        // D1 故障（配额耗尽等）：fail-open 放行，避免把每个请求都拖成 500。
        // 代价：故障期间封禁列表不生效，但优先保证 API 仍可响应。
        // 失败结果不写缓存，下个请求重试。
      }
    }
  }

  let user: JWTPayload | null = null
  try {
    user = await extractUser(c)
  } catch {
    // D1 故障：视为未认证请求放行（fail-open），避免 500。
  }
  if (!user) return next()

  let tracked = getCachedTrackingRule(user.sub)
  if (tracked === undefined) {
    try {
      const tracking = await queryOne<{ user_id: number }>(
        db,
        'SELECT user_id FROM ip_tracking_rules WHERE user_id = ? AND enabled = 1',
        [user.sub],
      )
      tracked = !!tracking
      cacheTrackingRule(user.sub, tracked)
    } catch {
      // D1 故障：按未开启追踪处理放行（与封禁检查的 fail-open 语义一致）。
      tracked = false
    }
  }
  if (!tracked || !ip) return next()

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
  // 本请求前半段可能已把该 IP 负缓存为未封禁；写入成功后必须立刻改为 true，
  // 防止客户端去掉认证信息后在 TTL 窗口内绕过封禁。
  cacheIpBan(ip, true)

  return c.json({ error: 'Access denied' }, 403)
}
