import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { authMiddleware, extractUser } from '../middleware/auth.ts'
import { rateLimit } from '../lib/rate-limit.ts'
import { query, queryOne, run } from '../lib/db.ts'
import { recordAdvertisingEvent, validateAdvertisingUrl } from '../lib/advertising.ts'

 type AppType = { Bindings: Env; Variables: { user: JWTPayload } }
const merchant = new Hono<AppType>()
merchant.use('*', async (c, next) => { c.header('Cache-Control', 'private, no-store'); await next() })
merchant.use('*', async (c, next) => {
  if (c.req.method === 'POST' && /\/ads\/\d+\/events$/.test(c.req.path)) return next()
  return authMiddleware(c, next)
})
merchant.use('/ads/*/events', rateLimit('advertising-events', 60_000, 120))

async function currentMerchant(c: Context<AppType>) {
  return queryOne<{ id: number; user_id: number; display_name: string; avatar_url: string | null; website_url: string | null; status: string }>(c.env.abdl_space_db, 'SELECT id,user_id,display_name,avatar_url,website_url,status FROM merchants WHERE user_id=?', [c.get('user').sub])
}

function text(value: unknown, max: number, required = true): string | null {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new Error('Invalid merchant field')
  return value.trim() || null
}

merchant.get('/info', async c => {
  const profile = await currentMerchant(c)
  const user = c.get('user')
  const isSuperAdmin = user.sub === 1 && user.role === 'admin'
  return c.json({ active: !!profile || isSuperAdmin, authorized: !!profile || isSuperAdmin, is_super_admin: isSuperAdmin, merchant: profile, profile })
})
merchant.get('/profile', async c => {
  const row = await currentMerchant(c)
  if (!row) return c.json({ error: 'Merchant activation required' }, 404)
  return c.json(row)
})
merchant.post('/activate', async c => {
  const user = c.get('user')
  const isSuperAdmin = user.sub === 1 && user.role === 'admin'
  const existing = await currentMerchant(c)
  if (existing || isSuperAdmin && existing) return c.json(existing)
  const body = await c.req.json<{ code?: unknown }>().catch(() => null)
  const raw = typeof body?.code === 'string' ? body.code.trim() : ''
  if (isSuperAdmin && !raw) {
    await run(c.env.abdl_space_db, `INSERT INTO merchants(user_id,display_name,status) VALUES(?,?, 'active')`, [user.sub, user.username || 'ABDL Space 官方'])
    return c.json(await currentMerchant(c), 201)
  }
  if (!raw || raw.length > 200) return c.json({ error: 'code is required' }, 422)
  const codeHash = await sha256(raw)
  const code = await queryOne<{ id: number; consumed_at: string | null; expires_at: string | null }>(c.env.abdl_space_db, 'SELECT id,consumed_at,expires_at FROM merchant_registration_codes WHERE code_hash=?', [codeHash])
  if (!code || code.consumed_at || (code.expires_at && code.expires_at <= new Date().toISOString())) return c.json({ error: 'Registration code unavailable', code: 'code_unavailable' }, 409)
  const changed = await run(c.env.abdl_space_db, `UPDATE merchant_registration_codes SET consumed_at=CURRENT_TIMESTAMP, consumed_by=? WHERE id=? AND consumed_at IS NULL AND (expires_at IS NULL OR expires_at>CURRENT_TIMESTAMP)`, [c.get('user').sub, code.id])
  if (Number(changed.meta?.changes ?? 0) !== 1) return c.json({ error: 'Registration code unavailable', code: 'code_unavailable' }, 409)
  try {
    await run(c.env.abdl_space_db, `INSERT INTO merchants(user_id,display_name,status) VALUES(?,?, 'active')`, [c.get('user').sub, `Merchant ${c.get('user').username}`])
  } catch {
    return c.json({ error: 'Merchant activation unavailable' }, 503)
  }
  return c.json(await currentMerchant(c), 201)
})

merchant.patch('/profile', async c => {
  const row = await currentMerchant(c)
  if (!row) return c.json({ error: 'Merchant activation required' }, 404)
  const body = await c.req.json<{ display_name?: unknown; avatar_url?: unknown; website_url?: unknown }>().catch(() => null)
  try {
    const name = body?.display_name === undefined ? row.display_name : text(body.display_name, 120) as string
    const avatar = body?.avatar_url === undefined || body.avatar_url === null || body.avatar_url === '' ? row.avatar_url : validateAdvertisingUrl(body.avatar_url).url
    const website = body?.website_url === undefined || body.website_url === null || body.website_url === '' ? null : validateAdvertisingUrl(body.website_url).url
    await run(c.env.abdl_space_db, 'UPDATE merchants SET display_name=?,avatar_url=?,website_url=?,updated_at=CURRENT_TIMESTAMP WHERE id=?', [name, avatar, website, row.id])
    return c.json(await currentMerchant(c))
  } catch { return c.json({ error: 'Invalid merchant profile' }, 422) }
})

merchant.get('/ads', async c => {
  const row = await currentMerchant(c)
  if (!row) return c.json({ error: 'Merchant activation required' }, 404)
  return c.json({ items: await query(c.env.abdl_space_db, `SELECT id,title,body,landing_url,image_url,status,starts_at,ends_at,impression_count,link_click_count,image_view_count,ad_navigation_count,created_at,updated_at FROM advertisements WHERE merchant_id=? ORDER BY id DESC`, [row.id]) })
})

merchant.post('/ads', async c => {
  const row = await currentMerchant(c)
  if (!row) return c.json({ error: 'Merchant activation required' }, 404)
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  try {
    const title = text(body?.title, 160) as string
    const adBody = text(body?.body ?? '', 2000, false) ?? ''
    const landing = body?.landing_url ? validateAdvertisingUrl(body.landing_url).url : null
    const image = body?.image_url ? validateAdvertisingUrl(body.image_url).url : null
    const status = body?.status === 'active' ? 'active' : 'draft'
    const isSuperAdmin = c.get('user').sub === 1 && c.get('user').role === 'admin'
    const adType = isSuperAdmin && ['merchant', 'official', 'system'].includes(String(body?.ad_type)) ? String(body?.ad_type) : 'merchant'
    await run(c.env.abdl_space_db, 'INSERT INTO advertisements(merchant_id,ad_type,title,body,landing_url,image_url,status,starts_at,ends_at) VALUES(?,?,?,?,?,?,?,?,?)', [row.id, adType, title, adBody, landing, image, status, body?.starts_at ?? null, body?.ends_at ?? null])
    return c.json(await queryOne(c.env.abdl_space_db, 'SELECT * FROM advertisements WHERE id=last_insert_rowid()'), 201)
  } catch { return c.json({ error: 'Invalid advertisement' }, 422) }
})

merchant.patch('/ads/:id', async c => mutateAd(c, 'update'))
merchant.delete('/ads/:id', async c => mutateAd(c, 'archive'))

async function mutateAd(c: Context<AppType>, mode: 'update' | 'archive') {
  const row = await currentMerchant(c)
  if (!row) return c.json({ error: 'Merchant activation required' }, 404)
  const id = Number(c.req.param('id'))
  const ad = await queryOne<{ id: number }>(c.env.abdl_space_db, 'SELECT id FROM advertisements WHERE id=? AND merchant_id=?', [id, row.id])
  if (!ad) return c.json({ error: 'Advertisement not found' }, 404)
  if (mode === 'archive') { await run(c.env.abdl_space_db, "UPDATE advertisements SET status='archived',updated_at=CURRENT_TIMESTAMP WHERE id=?", [id]); return c.json({ success: true }) }
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  try {
    const sets: string[] = []; const params: unknown[] = []
    if (body?.ad_type !== undefined && c.get('user').sub === 1 && c.get('user').role === 'admin' && ['merchant', 'official', 'system'].includes(String(body.ad_type))) { sets.push('ad_type=?'); params.push(body.ad_type) }
    if (body?.title !== undefined) { sets.push('title=?'); params.push(text(body.title, 160)) }
    if (body?.body !== undefined) { sets.push('body=?'); params.push(text(body.body, 2000, false) ?? '') }
    if (body?.landing_url !== undefined) { sets.push('landing_url=?'); params.push(body.landing_url ? validateAdvertisingUrl(body.landing_url).url : null) }
    if (body?.image_url !== undefined) { sets.push('image_url=?'); params.push(body.image_url ? validateAdvertisingUrl(body.image_url).url : null) }
    if (['draft', 'active', 'paused', 'archived'].includes(String(body?.status))) { sets.push('status=?'); params.push(body?.status) }
    if (body?.starts_at !== undefined) { sets.push('starts_at=?'); params.push(body.starts_at || null) }
    if (body?.ends_at !== undefined) { sets.push('ends_at=?'); params.push(body.ends_at || null) }
    if (!sets.length) return c.json({ error: 'No changes' }, 422)
    params.push(id); await run(c.env.abdl_space_db, `UPDATE advertisements SET ${sets.join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`, params)
    return c.json(await queryOne(c.env.abdl_space_db, 'SELECT * FROM advertisements WHERE id=?', [id]))
  } catch { return c.json({ error: 'Invalid advertisement' }, 422) }
}

merchant.post('/ads/:id/events', async c => {
  const id = Number(c.req.param('id'))
  const ad = await queryOne<{ id: number; status: string }>(c.env.abdl_space_db, "SELECT id,status FROM advertisements WHERE id=? AND status='active'", [id])
  if (!ad) return c.json({ error: 'Advertisement not found' }, 404)
  const body = await c.req.json<{ event_type?: unknown; event_key?: unknown }>().catch(() => null)
  if (typeof body?.event_key !== 'string') return c.json({ error: 'event_key is required' }, 422)
  const user = await extractUser(c)
  try { return c.json(await recordAdvertisingEvent(c.env.abdl_space_db, id, user?.sub ?? null, body.event_type, body.event_key)) } catch { return c.json({ error: 'Invalid advertising event' }, 422) }
})

merchant.get('/stats', async c => {
  const row = await currentMerchant(c)
  if (!row) return c.json({ error: 'Merchant activation required' }, 404)
  const stats = await queryOne<Record<string, number>>(c.env.abdl_space_db, `SELECT COALESCE(SUM(impression_count),0) AS impressions,COALESCE(SUM(link_click_count),0) AS link_clicks,COALESCE(SUM(image_view_count),0) AS image_views,COALESCE(SUM(ad_navigation_count),0) AS ad_navigations FROM advertisements WHERE merchant_id=?`, [row.id])
  return c.json({ ...stats, clicks: Number(stats?.link_clicks ?? 0) + Number(stats?.image_views ?? 0) + Number(stats?.ad_navigations ?? 0) })
})
merchant.get('/ads/:id/stats', async c => {
  const row = await currentMerchant(c)
  if (!row) return c.json({ error: 'Merchant activation required' }, 404)
  const id = Number(c.req.param('id'))
  const stats = await queryOne<Record<string, number>>(c.env.abdl_space_db, 'SELECT impression_count AS impressions,link_click_count AS link_clicks,image_view_count AS image_views,ad_navigation_count AS ad_navigations FROM advertisements WHERE id=? AND merchant_id=?', [id, row.id])
  if (!stats) return c.json({ error: 'Advertisement not found' }, 404)
  return c.json({ ...stats, clicks: Number(stats.link_clicks ?? 0) + Number(stats.image_views ?? 0) + Number(stats.ad_navigations ?? 0) })
})

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes)).map(v => v.toString(16).padStart(2, '0')).join('')
}

export default merchant
