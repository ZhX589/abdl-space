import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { JWTPayload } from '../types/index.ts'
import type { SponsorStockEnv, StockSetting } from '../types/sponsor-stock.ts'
import { sponsorAdminMiddleware } from '../lib/sponsors.ts'
import { SponsorStockError, SponsorStockService } from '../lib/sponsor-stock.ts'

type AppType = { Bindings: SponsorStockEnv; Variables: { user: JWTPayload } }
const adminSponsorStockRoutes = new Hono<AppType>()

adminSponsorStockRoutes.use('*', async (c, next) => {
	c.header('Cache-Control', 'private, no-store')
	await next()
})
adminSponsorStockRoutes.use('*', sponsorAdminMiddleware)
adminSponsorStockRoutes.use('*', bodyLimit({ maxSize: 8192, onError: c => c.json({ error: '库存请求过大', code: 'request_too_large' }, 413) }))
adminSponsorStockRoutes.onError((error, c) => {
	if (error instanceof SponsorStockError) return c.json({ error: error.message, code: error.code }, error.status)
	if (error instanceof SyntaxError) return c.json({ error: '请求 JSON 格式错误', code: 'invalid_json' }, 400)
	// Never use upstream errors or core exception messages: they may contain diagnostic payloads.
	return c.json({ error: '库存操作未完成，请核对配置及批次状态；不要重复发送', code: 'stock_unavailable' }, 503)
})

adminSponsorStockRoutes.get('/', async c => c.json(await new SponsorStockService(c.env).list()))
adminSponsorStockRoutes.get('/batches', async c => c.json(await new SponsorStockService(c.env).batches(
	Number(c.req.query('limit') ?? 20), Number(c.req.query('offset') ?? 0),
)))
adminSponsorStockRoutes.put('/:planId', async c => {
	const body = await c.req.json<{ setting: Partial<StockSetting>; reason: string }>()
	if (!body || typeof body !== 'object') throw new SponsorStockError('invalid_body', '请求格式错误', 400)
	return c.json(await new SponsorStockService(c.env).update(c.req.param('planId'), body.setting, body.reason, String(c.get('user').sub)))
})
adminSponsorStockRoutes.post('/:planId/check', async c => {
	const body = await c.req.json<{ reason: string }>()
	if (!body || typeof body !== 'object') throw new SponsorStockError('invalid_body', '请求格式错误', 400)
	return c.json(await new SponsorStockService(c.env).check(c.req.param('planId'), body.reason, String(c.get('user').sub)))
})
adminSponsorStockRoutes.post('/:planId/refill', async c => {
	const body = await c.req.json<{ operation_id: string; count?: number; reason: string }>()
	if (!body || typeof body !== 'object') throw new SponsorStockError('invalid_body', '请求格式错误', 400)
	return c.json(await new SponsorStockService(c.env).refill(c.req.param('planId'), body.operation_id, body.count, body.reason, String(c.get('user').sub)))
})
adminSponsorStockRoutes.post('/batches/:id/reconcile', async c => {
	const body = await c.req.json<{ reason: string; out_trade_nos?: string[] }>()
	if (!body || typeof body !== 'object') throw new SponsorStockError('invalid_body', '请求格式错误', 400)
	return c.json(await new SponsorStockService(c.env).reconcile(c.req.param('id'), body.reason, String(c.get('user').sub), body.out_trade_nos))
})

// 只读诊断端点：验证 Worker 侧 MD5 签名链是否可用、到爱发电接口的网络是否可达；
// 仅回错误名称与 HTTP 状态，不输出密钥、签名原文或上游响应体。
adminSponsorStockRoutes.get('/diag/net', async c => {
	const out: Record<string, unknown> = { ts: Math.floor(Date.now() / 1000) }
	try {
		const bytes = new TextEncoder().encode('diagnostic')
		await crypto.subtle.digest('MD5', bytes)
		out.md5 = true
	} catch (error) {
		out.md5 = false
		out.md5ErrorName = (error as { name?: string }).name
	}
	const t0 = Date.now()
	try {
		const response = await fetch('https://ifdian.net/api/open/query-plan', {
			method: 'POST', redirect: 'manual',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify({ user_id: c.env.AFDIAN_USER_ID ?? '', params: '{}', ts: 1, sign: '00000000000000000000000000000000' }),
		})
		out.reachable = true
		out.httpStatus = response.status
		out.redirected = response.redirected
		out.elapsedMs = Date.now() - t0
	} catch (error) {
		out.reachable = false
		out.errorName = (error as { name?: string }).name
		out.elapsedMs = Date.now() - t0
	}
	return c.json(out)
})

export default adminSponsorStockRoutes
