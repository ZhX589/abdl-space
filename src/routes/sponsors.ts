import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { bodyLimit } from 'hono/body-limit'
import type { SponsorAppType } from '../lib/sponsors.ts'
import { authorizeSponsorOriginal, claimSponsorBenefit, getSponsorConfig, getSponsorMe, redeemSponsorCode, setSponsorColor, sponsorAuthMiddleware, sponsorErrorResponse, SponsorError } from '../lib/sponsors.ts'
import type { SponsorPlan } from '../types/index.ts'

const sponsors = new Hono<SponsorAppType>()
sponsors.use('*', cors({ origin: origin => ['https://abdl-space.top', 'https://www.abdl-space.top', 'https://m.abdl-space.top', 'https://wiki.abdl-space.top', 'https://abdl-space-mobile.pages.dev', 'http://localhost:5173', 'http://localhost:5174'].includes(origin) ? origin : '', credentials: true, allowHeaders: ['Content-Type', 'Authorization'], allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'] }))
sponsors.use('*', bodyLimit({ maxSize: 32768, onError: c => c.json({ error: '请求内容过大', code: 'invalid_request' }, 413) }))
sponsors.onError((error, c) => sponsorErrorResponse(error, c))
sponsors.get('/catalog', async c => {
  const config = await getSponsorConfig(c.env)
  const plans = await c.env.abdl_space_db.prepare('SELECT plan_json FROM sponsor_plans WHERE enabled=1 ORDER BY sort_order,id').all<{ plan_json: string }>()
  c.header('Cache-Control', 'no-store')
  return c.json({ config, plans: plans.results.map(row => JSON.parse(row.plan_json) as SponsorPlan) })
})
sponsors.use('*', sponsorAuthMiddleware)
sponsors.get('/me', async c => c.json(await getSponsorMe(c.env, c.get('user').sub)))
sponsors.post('/redeem', async c => c.json({ ...await redeemSponsorCode(c.env, c.get('user').sub, await requestBody(c.req.raw)), message: '兑换成功，赞助者身份已更新' }))
sponsors.put('/color', async c => c.json(await setSponsorColor(c.env, c.get('user').sub, await requestBody(c.req.raw))))
sponsors.post('/claims', async c => c.json(await claimSponsorBenefit(c.env, c.get('user').sub, await requestBody(c.req.raw))))
sponsors.post('/original-authorizations', async c => c.json(await authorizeSponsorOriginal(c.env, c.get('user').sub, await requestBody(c.req.raw))))
sponsors.get('/redemptions', async c => {
  const { limit, offset } = sponsorPagination(c.req.query())
  const userId = c.get('user').sub
  const rows = await c.env.abdl_space_db.prepare('SELECT id,plan_name,redeemed_at,expires_at,permanent FROM sponsor_redemptions WHERE user_id=? ORDER BY redeemed_at DESC,id LIMIT ? OFFSET ?').bind(userId, limit, offset).all<{ id: string; plan_name: string; redeemed_at: number; expires_at: number | null; permanent: number }>()
  const total = await c.env.abdl_space_db.prepare('SELECT COUNT(*) AS total FROM sponsor_redemptions WHERE user_id=?').bind(userId).first<{ total: number }>()
  return c.json({ items: rows.results.map(row => ({ ...row, permanent: !!row.permanent })), total: total?.total ?? 0 })
})

/** Parse bounded JSON with the stable sponsor error response instead of leaking SyntaxError. */
export async function requestBody(request: Request): Promise<unknown> {
  try { return await request.json() } catch { throw new SponsorError('invalid_request', 'JSON 请求格式不正确', 400) }
}

/** Strict bounded pagination; no unbounded full-table response path. */
export function sponsorPagination(query: Record<string, string>): { limit: number; offset: number } {
  const parse = (value: string | undefined, fallback: number, max: number) => {
    if (value === undefined) return fallback
    if (!/^\d{1,7}$/.test(value) || Number(value) > max) throw new SponsorError('invalid_request', '分页参数不正确')
    return Number(value)
  }
  const limit = parse(query.limit, 20, 100)
  if (limit < 1) throw new SponsorError('invalid_request', '每页数量必须大于零')
  return { limit, offset: parse(query.offset, 0, 1000000) }
}

export default sponsors
