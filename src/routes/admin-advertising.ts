import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { adminMiddleware } from '../middleware/auth.ts'
import { query, queryOne, run } from '../lib/db.ts'
import { validateAdvertisingUrl } from '../lib/advertising.ts'

 type AppType = { Bindings: Env; Variables: { user: JWTPayload } }
const advertising = new Hono<AppType>()
advertising.use('*', adminMiddleware)
advertising.use('*', async (c, next) => { c.header('Cache-Control', 'private, no-store'); await next() })

function sha256(value: string): Promise<string> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)).then(bytes => Array.from(new Uint8Array(bytes)).map(v => v.toString(16).padStart(2, '0')).join(''))
}

advertising.get('/policy', async c => c.json(await queryOne(c.env.abdl_space_db, 'SELECT enabled,max_per_timeline,min_interval_seconds,ad_probability,fallback_probability,updated_at,updated_by FROM advertising_policies WHERE id=1')))
advertising.put('/policy', async c => {
  const body = await c.req.json<{ enabled?: unknown; max_per_timeline?: unknown; min_interval_seconds?: unknown; ad_probability?: unknown; fallback_probability?: unknown }>().catch(() => null)
  const validPercent = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 100
  if (typeof body?.enabled !== 'boolean' || !Number.isInteger(body.max_per_timeline) || !Number.isInteger(body.min_interval_seconds)
    || Number(body.max_per_timeline) < 0 || Number(body.max_per_timeline) > 1 || Number(body.min_interval_seconds) < 0 || Number(body.min_interval_seconds) > 86400
    || !validPercent(body.ad_probability) || !validPercent(body.fallback_probability)) return c.json({ error: 'Invalid advertising policy' }, 422)
  await run(c.env.abdl_space_db, 'UPDATE advertising_policies SET enabled=?,max_per_timeline=?,min_interval_seconds=?,ad_probability=?,fallback_probability=?,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE id=1', [body.enabled ? 1 : 0, body.max_per_timeline, body.min_interval_seconds, body.ad_probability, body.fallback_probability, c.get('user').sub])
  return c.json(await queryOne(c.env.abdl_space_db, 'SELECT enabled,max_per_timeline,min_interval_seconds,ad_probability,fallback_probability,updated_at,updated_by FROM advertising_policies WHERE id=1'))
})

advertising.post('/registration-codes', async c => {
  const body = await c.req.json<{ code?: unknown; expires_at?: unknown }>().catch(() => null)
  if (typeof body?.code !== 'string' || !/^[A-Za-z0-9_-]{8,200}$/.test(body.code)) return c.json({ error: 'Invalid registration code' }, 422)
  const raw = body.code.trim(); const hash = await sha256(raw)
  try {
    await run(c.env.abdl_space_db, 'INSERT INTO merchant_registration_codes(code_hash,masked_code,created_by,expires_at) VALUES(?,?,?,?)', [hash, `${raw.slice(0, 3)}***${raw.slice(-2)}`, c.get('user').sub, body.expires_at ?? null])
    return c.json({ success: true, masked_code: `${raw.slice(0, 3)}***${raw.slice(-2)}` }, 201)
  } catch { return c.json({ error: 'Registration code already exists' }, 409) }
})
advertising.get('/registration-codes', async c => c.json({ items: await query(c.env.abdl_space_db, 'SELECT id,masked_code,consumed_at,consumed_by,expires_at,created_at FROM merchant_registration_codes ORDER BY id DESC LIMIT 200') }))
advertising.get('/', async c => c.json({ items: await query(c.env.abdl_space_db, `SELECT a.*,m.display_name AS merchant_name FROM advertisements a JOIN merchants m ON m.id=a.merchant_id ORDER BY a.id DESC LIMIT 500`) }))
advertising.get('/ads', async c => c.json({ items: await query(c.env.abdl_space_db, `SELECT a.*,m.display_name AS merchant_name FROM advertisements a JOIN merchants m ON m.id=a.merchant_id ORDER BY a.id DESC LIMIT 500`) }))
advertising.patch('/ads/:id', async c => {
  const id = Number(c.req.param('id')); const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!Number.isSafeInteger(id) || !body) return c.json({ error: 'Invalid advertisement' }, 422)
  try {
    const sets: string[] = []; const params: unknown[] = []
    if (['draft', 'active', 'paused', 'archived'].includes(String(body.status))) { sets.push('status=?'); params.push(body.status) }
    if (body.landing_url !== undefined) { sets.push('landing_url=?'); params.push(body.landing_url ? validateAdvertisingUrl(body.landing_url).url : null) }
    if (body.image_url !== undefined) { sets.push('image_url=?'); params.push(body.image_url ? validateAdvertisingUrl(body.image_url).url : null) }
    if (!sets.length) return c.json({ error: 'No changes' }, 422)
    params.push(id); await run(c.env.abdl_space_db, `UPDATE advertisements SET ${sets.join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`, params)
    return c.json(await queryOne(c.env.abdl_space_db, 'SELECT * FROM advertisements WHERE id=?', [id]))
  } catch { return c.json({ error: 'Invalid advertisement' }, 422) }
})
advertising.get('/registration-codes', async c => c.json({ items: await query(c.env.abdl_space_db, 'SELECT id,masked_code,consumed_at,consumed_by,expires_at,created_at FROM merchant_registration_codes ORDER BY id DESC LIMIT 200') }))
advertising.get('/stats', async c => {
  const totals = await queryOne<Record<string, number>>(c.env.abdl_space_db, 'SELECT COALESCE(SUM(impression_count),0) AS impressions,COALESCE(SUM(link_click_count),0) AS link_clicks,COALESCE(SUM(image_view_count),0) AS image_views,COALESCE(SUM(ad_navigation_count),0) AS ad_navigations FROM advertisements')
  return c.json({ ...totals, clicks: Number(totals?.link_clicks ?? 0) + Number(totals?.image_views ?? 0) + Number(totals?.ad_navigations ?? 0) })
})

export default advertising
