import type { SponsorStockEnv } from '../types/sponsor-stock.ts'

// Protocol reference (2025-08-14 additions):
// https://ifdian.net/api/post/get-detail?post_id=9c65d9cc617011ed81c352540025c377
// query-plan documents skus[].reply_random_content, NOT a completeness/remaining-pool
// guarantee. update-plan-reply documents append, NOT a per-line acknowledgement.
// Deployment attestations plus a controlled positively reconciled probe are required.
const ORIGIN = 'https://ifdian.net'
const MAX_BYTES = 256 * 1024
const TIMEOUT_MS = 8000
const ID = /^[a-f0-9]{32}$/i

/** Redacted adapter failure. Never propagate upstream em/debug/request/sign material. */
export class AfdianError extends Error {
	readonly code: string
	readonly definitelyRejected: boolean
	constructor(code: string, definitelyRejected = false) {
		super('爱发电接口未能提供可确认的结果')
		this.code = code
		this.definitelyRejected = definitelyRejected
	}
}

/** Expected SKU data comes exclusively from the backend catalog. */
export interface AfdianExpectedPlan {
	id: string
	name: string
	price_minor: number
	afdian_plan_id: string
	afdian_sku_id: string
}

/** Pool lines stay server-side, and observed line count is not automatically inventory. */
export interface AfdianObservation {
	planId: string
	skuId: string
	productStock: number | null
	lines: string[]
}

/** Dependency injection is limited to transport, time and the legacy digest for Node tests. */
export interface AfdianOptions {
	fetch?: typeof fetch
	now?: () => number
	digest?: (bytes: Uint8Array) => Promise<ArrayBuffer>
	timeoutMs?: number
	maxBytes?: number
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AfdianError('afdian_shape')
	return value as Record<string, unknown>
}

function priceMinor(value: unknown): number {
	if (typeof value !== 'string' || !/^\d{1,8}\.\d{2}$/.test(value)) throw new AfdianError('afdian_price_shape')
	const [whole, fraction] = value.split('.')
	return Number(whole) * 100 + Number(fraction)
}

function poolLines(value: unknown): string[] {
	if (typeof value !== 'string') throw new AfdianError('afdian_pool_shape')
	// Afdian adds a newline when appending. Empty separator lines are not codes.
	const lines = value.split(/\r?\n/).filter(line => line !== '')
	// eslint-disable-next-line no-control-regex -- 码池行必须拒绝换行以外的控制字符
	if (lines.length > 10000 || lines.some(line => line.length > 512 || line.trim() !== line || /[\r\x00-\x1f]/.test(line))) throw new AfdianError('afdian_pool_shape')
	if (new Set(lines).size !== lines.length) throw new AfdianError('afdian_pool_duplicates')
	return lines
}

async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
	const advertised = response.headers.get('content-length')
	if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > maxBytes)) {
		await response.body?.cancel()
		throw new AfdianError('afdian_response_limit')
	}
	if (!response.body) throw new AfdianError('afdian_empty_response')
	const reader = response.body.getReader()
	const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
	let size = 0
	let text = ''
	try {
		for (;;) {
			const chunk = await reader.read()
			if (chunk.done) break
			size += chunk.value.byteLength
			if (size > maxBytes) throw new AfdianError('afdian_response_limit')
			text += decoder.decode(chunk.value, { stream: true })
		}
		text += decoder.decode()
		return JSON.parse(text)
	} finally {
		await reader.cancel().catch(() => undefined)
		reader.releaseLock()
	}
}

/** Strict fixed-host Afdian Open API adapter. No generic write endpoint or overwrite mode. */
export class AfdianClient {
	private readonly env: SponsorStockEnv
	private readonly options: AfdianOptions
	constructor(env: SponsorStockEnv, options: AfdianOptions = {}) {
		this.env = env
		this.options = options
	}

	private async request(endpoint: 'query-plan' | 'query-random-reply' | 'update-plan-reply', params: Record<string, unknown>): Promise<Record<string, unknown>> {
		if (!this.env.AFDIAN_USER_ID?.trim() || !this.env.AFDIAN_API_TOKEN?.trim()) throw new AfdianError('afdian_credentials_missing', true)
		const paramsString = JSON.stringify(params)
		const ts = (this.options.now ?? (() => Math.floor(Date.now() / 1000)))()
		const bytes = new TextEncoder().encode(`${this.env.AFDIAN_API_TOKEN}params${paramsString}ts${ts}user_id${this.env.AFDIAN_USER_ID}`)
		// Workers supports MD5 only for legacy interoperability; code security uses AES/SHA in core.
		const hash = await (this.options.digest ? this.options.digest(bytes) : crypto.subtle.digest('MD5', bytes))
		const sign = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
		const controller = new AbortController()
		const timeout = Math.min(this.options.timeoutMs ?? TIMEOUT_MS, TIMEOUT_MS)
		let timer: ReturnType<typeof setTimeout> | undefined
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => { controller.abort(); reject(new AfdianError('afdian_timeout')) }, timeout)
		})
		try {
			const task = async () => {
				const response = await (this.options.fetch ?? fetch)(`${ORIGIN}/api/open/${endpoint}`, {
					method: 'POST', redirect: 'error', signal: controller.signal,
					headers: { 'content-type': 'application/json', accept: 'application/json' },
					body: JSON.stringify({ user_id: this.env.AFDIAN_USER_ID, params: paramsString, ts, sign }),
				})
				if (!response.ok || response.redirected || (response.url && new URL(response.url).origin !== ORIGIN)) {
					await response.body?.cancel()
					throw new AfdianError('afdian_http_unknown')
				}
				const result = object(await boundedJson(response, Math.min(this.options.maxBytes ?? MAX_BYTES, MAX_BYTES)))
				if (result.ec !== 200) {
					// Only the documented pre-execution wrapper validation errors prove no append.
					throw new AfdianError('afdian_api_unknown', typeof result.ec === 'number' && [400001, 400002, 400003, 400004, 400005].includes(result.ec))
				}
				return result
			}
			return await Promise.race([task(), deadline])
		} catch (error) {
			if (error instanceof AfdianError) throw error
			throw new AfdianError('afdian_transport_unknown')
		} finally {
			if (timer !== undefined) clearTimeout(timer)
			controller.abort()
		}
	}

	private async read(endpoint: 'query-plan' | 'query-random-reply', params: Record<string, unknown>): Promise<Record<string, unknown>> {
		try { return await this.request(endpoint, params) }
		catch (error) {
			if (error instanceof AfdianError && error.definitelyRejected) throw error
			return this.request(endpoint, params) // exactly one bounded retry, reads only
		}
	}

	/** Validate all five configured SKUs, names and prices, keeping product stock separate. */
	async queryPlans(expected: AfdianExpectedPlan[]): Promise<AfdianObservation[]> {
		if (expected.length !== 5 || new Set(expected.map(p => p.id)).size !== 5 || new Set(expected.map(p => p.afdian_sku_id)).size !== 5
			|| new Set(expected.map(p => p.afdian_plan_id)).size !== 1 || expected.some(p => !ID.test(p.afdian_plan_id) || !ID.test(p.afdian_sku_id))) throw new AfdianError('afdian_mapping')
		const result = await this.read('query-plan', { plan_id: expected[0].afdian_plan_id })
		const plan = object(object(result.data).plan)
		if (plan.plan_id !== expected[0].afdian_plan_id || plan.product_type !== 1 || typeof plan.name !== 'string' || !plan.name.trim() || !Array.isArray(plan.skus)) throw new AfdianError('afdian_mapping')
		priceMinor(plan.price) // product's display price is not a SKU price or a stock count
		const skus = plan.skus.map(object)
		if (new Set(skus.map(sku => sku.sku_id)).size !== skus.length) throw new AfdianError('afdian_mapping')
		return expected.map(item => {
			const sku = skus.find(candidate => candidate.sku_id === item.afdian_sku_id)
			if (!sku || sku.plan_id !== item.afdian_plan_id || sku.name !== item.name || priceMinor(sku.price) !== item.price_minor) throw new AfdianError('afdian_mapping_name_price')
			const stock = sku.stock
			const productStock = typeof stock === 'number' && Number.isSafeInteger(stock) && stock >= 0 ? stock
				: typeof stock === 'string' && /^\d{1,9}$/.test(stock) ? Number(stock) : null
			return { planId: item.id, skuId: item.afdian_sku_id, productStock, lines: poolLines(sku.reply_random_content) }
		})
	}

	/** Append once, SKU-only. ec=200 acknowledges transport, never confirms every line. */
	async append(skuId: string, codes: string[]): Promise<void> {
		if (!ID.test(skuId) || !Array.isArray(codes) || codes.length < 1 || codes.length > 200
			|| new Set(codes).size !== codes.length || codes.some(code => typeof code !== 'string' || !/^[A-Za-z0-9-]{16,128}$/.test(code))) throw new AfdianError('afdian_append_input', true)
		await this.request('update-plan-reply', { sku_id: skuId, auto_random_reply: codes.join('\n'), update_random_reply_type: 'append' })
	}

	/** Official replies for explicitly selected orders are positive evidence, never absence proof. */
	async queryReplies(outTradeNos: string[]): Promise<string[]> {
		if (outTradeNos.length < 1 || outTradeNos.length > 20 || new Set(outTradeNos).size !== outTradeNos.length || outTradeNos.some(value => !/^\d{8,64}$/.test(value))) throw new AfdianError('afdian_order_input', true)
		const result = await this.read('query-random-reply', { out_trade_no: outTradeNos.join(',') })
		const list = object(result.data).list
		if (!Array.isArray(list) || list.length > 20) throw new AfdianError('afdian_reply_shape')
		return list.flatMap(value => {
			const reply = object(value)
			if (typeof reply.out_trade_no !== 'string' || !outTradeNos.includes(reply.out_trade_no)) throw new AfdianError('afdian_reply_shape')
			return poolLines(reply.content)
		})
	}
}
