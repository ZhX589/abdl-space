import { AfdianClient, AfdianError } from './afdian.ts'
import {
	createSponsorCodeBatch, exportSponsorCodeBatch, getSponsorPlan, getSponsorConfig, recordSponsorAudit,
} from './sponsors.ts'
import type { StockBatch, StockSetting, SponsorStockEnv } from '../types/sponsor-stock.ts'

const PLAN_IDS = ['week', 'month', 'quarter', 'year', 'permanent'] as const
const LEASE_SECONDS = 180
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CONTRACT_MESSAGE = '须依据官方证据确认完整未发送随机码池及追加契约，并设置两个部署验证开关；不得将商品库存当作兑换码库存。'

type Plan = NonNullable<Awaited<ReturnType<typeof getSponsorPlan>>>
type SettingRow = Omit<StockSetting, 'enabled' | 'verified' | 'paused' | 'verification_status' | 'verification_message' | 'can_refill' | 'can_enable'> & {
	enabled: number; verified: number; paused: number; read_fingerprint: string | null; verified_fingerprint: string | null
}
type BatchRow = StockBatch & {
	operation_id: string; afdian_plan_id: string; sku_id: string; fingerprint: string; initial_probe: number
}
type Lease = { skuId: string; owner: string }

/** Safe Chinese API errors. Upstream exception text is intentionally never returned or stored. */
export class SponsorStockError extends Error {
	readonly code: string
	readonly status: 400 | 404 | 409 | 503
	constructor(code: string, message: string, status: 400 | 404 | 409 | 503 = 409) {
		super(message)
		this.code = code
		this.status = status
	}
}

/** Injectable core/transport dependencies allow deterministic SQLite tests without external writes. */
export interface StockDependencies {
	client?: Pick<AfdianClient, 'queryPlans' | 'append' | 'queryReplies'>
	now?: () => number
	getPlan?: typeof getSponsorPlan
	getConfig?: typeof getSponsorConfig
	createBatch?: typeof createSponsorCodeBatch
	exportBatch?: typeof exportSponsorCodeBatch
	audit?: typeof recordSponsorAudit
}

function requireReason(reason: unknown): asserts reason is string {
	// eslint-disable-next-line no-control-regex -- 操作原因必须拒绝控制字符
	if (typeof reason !== 'string' || reason.trim().length < 3 || reason.length > 500 || /[\x00-\x1f]/.test(reason)) throw new SponsorStockError('invalid_reason', '请填写 3 至 500 字的操作原因', 400)
}

function requireOperation(operationId: string) {
	if (!UUID.test(operationId)) throw new SponsorStockError('invalid_operation_id', '操作编号必须是 UUID', 400)
}

function integer(value: unknown, min: number, max: number): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}

function safeError(error: unknown): string {
	if (error instanceof AfdianError) {
		if (error.code.startsWith('afdian_mapping')) return '爱发电商品、全部五个型号、名称或价格与后台方案不一致，请核对后重试'
		if (error.code.startsWith('afdian_pool')) return '爱发电随机码池格式不明确或包含重复行，已停止补货'
		return '爱发电查询或写入结果无法确认；写入批次不得重发，请人工对账'
	}
	return '库存操作未完成；请检查配置及持久化批次状态，不要重复发送'
}

/** Credential and deployment-attestation booleans only, never their values. */
export function sponsorStockCredentials(env: SponsorStockEnv) {
	return {
		user_id_configured: Boolean(env.AFDIAN_USER_ID?.trim()),
		token_configured: Boolean(env.AFDIAN_API_TOKEN?.trim()),
		code_key_configured: Boolean(env.SPONSOR_CODE_KEY?.trim()),
		pool_contract_verified: env.AFDIAN_STOCK_POOL_VERIFIED === 'true',
		append_contract_verified: env.AFDIAN_STOCK_APPEND_VERIFIED === 'true',
	}
}

/** D1-backed stock orchestration. Leases fence writes; durable unresolved rows outlive leases. */
export class SponsorStockService {
	private readonly env: SponsorStockEnv
	private readonly deps: StockDependencies
	private readonly client: Pick<AfdianClient, 'queryPlans' | 'append' | 'queryReplies'>
	constructor(env: SponsorStockEnv, deps: StockDependencies = {}) {
		this.env = env
		this.deps = deps
		this.client = deps.client ?? new AfdianClient(env)
	}
	private now() { return (this.deps.now ?? (() => Math.floor(Date.now() / 1000)))() }
	private db() { return this.env.abdl_space_db }
	private async audit(actorId: string | null, action: string, reason: string) {
		await (this.deps.audit ?? recordSponsorAudit)(this.env, { actorId, userId: null, action, reason })
	}
	private contracts() { return this.env.AFDIAN_STOCK_POOL_VERIFIED === 'true' && this.env.AFDIAN_STOCK_APPEND_VERIFIED === 'true' }
	private configured() {
		const c = sponsorStockCredentials(this.env)
		return c.user_id_configured && c.token_configured && c.code_key_configured
	}
	private async plans(): Promise<Plan[]> {
		const plans = await Promise.all(PLAN_IDS.map(id => (this.deps.getPlan ?? getSponsorPlan)(this.env, id)))
		if (plans.some(plan => !plan)) throw new SponsorStockError('stock_mapping_missing', '后台五个赞助方案配置不完整', 503)
		return plans as Plan[]
	}
	private fingerprint(plans: Plan[]): string {
		return JSON.stringify(plans.map(p => [p.id, p.version, p.name, p.price_minor, p.currency, p.duration_unit, p.duration_count, p.afdian_plan_id, p.afdian_sku_id]))
	}
	private selectPlan(plans: Plan[], id: string): Plan {
		const plan = plans.find(p => p.id === id)
		if (!plan) throw new SponsorStockError('stock_plan_not_found', '未找到库存方案', 404)
		return plan
	}
	private async row(id: string): Promise<SettingRow> {
		const row = await this.db().prepare('SELECT * FROM sponsor_stock_settings WHERE plan_id = ?').bind(id).first<SettingRow>()
		if (!row) throw new SponsorStockError('stock_plan_not_found', '未找到库存方案', 404)
		return row
	}
	private async unresolved(id: string): Promise<BatchRow | null> {
		return this.db().prepare("SELECT * FROM sponsor_stock_batches WHERE plan_id = ? AND state IN ('prepared','sending','unknown') LIMIT 1").bind(id).first<BatchRow>()
	}
	private view(row: SettingRow, fingerprint: string, active: boolean, blocked: boolean): StockSetting {
		const readVerified = row.read_fingerprint === fingerprint && row.last_error === null
		const verified = Boolean(row.verified && row.verified_fingerprint === fingerprint && this.contracts())
		const fresh = row.last_checked_at !== null && this.now() - row.last_checked_at <= row.check_interval_seconds
		const ready = this.configured() && this.contracts() && active && readVerified && !row.paused && !blocked
		return {
			plan_id: row.plan_id, enabled: Boolean(row.enabled), verified, low_water: row.low_water, target_stock: row.target_stock,
			batch_size: row.batch_size, check_interval_seconds: row.check_interval_seconds,
			last_stock: this.env.AFDIAN_STOCK_POOL_VERIFIED === 'true' && readVerified ? row.last_stock : null,
			product_stock: row.product_stock, observed_line_count: row.observed_line_count,
			last_checked_at: row.last_checked_at, next_check_at: row.next_check_at, last_error: row.last_error, paused: Boolean(row.paused),
			verification_status: row.last_error ? 'failed' : verified ? 'write_verified' : readVerified ? 'read_verified' : 'unchecked',
			verification_message: !this.contracts() ? CONTRACT_MESSAGE : !this.configured() ? '请通过受保护部署渠道配置所需密钥'
				: blocked || row.paused ? '存在待确认批次或暂停状态；只能正向对账，不可重发'
					: !active ? '赞助功能或此方案尚未启用，禁止生成及补货'
						: !readVerified ? '请先只读核对五个型号的映射、名称与价格'
							: !verified ? '只读核对通过；填写原因后可手动追加 1 个兑换码验证，自动补货仍关闭' : '追加批次已有正向证据；自动补货须由管理员另行启用',
			can_refill: ready && fresh, can_enable: ready && verified && fresh,
		}
	}

	/** Return safe settings with current catalog/secret/contract gates applied. */
	async list(): Promise<{ credentials: ReturnType<typeof sponsorStockCredentials>; items: StockSetting[] }> {
		const plans = await this.plans()
		const config = await (this.deps.getConfig ?? getSponsorConfig)(this.env)
		const rows = await this.db().prepare('SELECT * FROM sponsor_stock_settings ORDER BY plan_id').all<SettingRow>()
		const items = await Promise.all(rows.results.map(async row => this.view(row, this.fingerprint(plans), config.enabled && this.selectPlan(plans, row.plan_id).enabled, Boolean(await this.unresolved(row.plan_id)))))
		return { credentials: sponsorStockCredentials(this.env), items }
	}

	private async acquire(skuId: string): Promise<Lease> {
		const owner = crypto.randomUUID()
		const now = this.now()
		const result = await this.db().prepare(`INSERT INTO sponsor_stock_leases (sku_id,owner,expires_at) VALUES (?,?,?)
			ON CONFLICT(sku_id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE sponsor_stock_leases.expires_at <= ?`)
			.bind(skuId, owner, now + LEASE_SECONDS, now).run()
		if (result.meta.changes !== 1) throw new SponsorStockError('stock_busy', '该型号正由另一库存任务处理')
		return { skuId, owner }
	}
	private async release(lease: Lease) {
		await this.db().prepare('DELETE FROM sponsor_stock_leases WHERE sku_id = ? AND owner = ?').bind(lease.skuId, lease.owner).run()
	}
	private async assertLease(lease: Lease) {
		const row = await this.db().prepare('SELECT owner FROM sponsor_stock_leases WHERE sku_id = ? AND owner = ? AND expires_at > ?').bind(lease.skuId, lease.owner, this.now()).first()
		if (!row) throw new SponsorStockError('stock_lease_lost', '库存处理租约已失效，禁止继续写入')
	}
	private async fenced(lease: Lease, sql: string, values: (string | number | null)[]) {
		const result = await this.db().prepare(`${sql} AND EXISTS (SELECT 1 FROM sponsor_stock_leases WHERE sku_id = ? AND owner = ? AND expires_at > ?)`)
			.bind(...values, lease.skuId, lease.owner, this.now()).run()
		if (result.meta.changes !== 1) throw new SponsorStockError('stock_lease_lost', '库存状态已变化或租约失效，禁止继续写入')
	}
	private async recover(lease: Lease, planId: string) {
		const row = await this.unresolved(planId)
		if (!row) return
		if (row.state === 'sending') {
			await this.fenced(lease, "UPDATE sponsor_stock_batches SET state='unknown',last_error=? WHERE id=? AND state='sending'", ['上次发送未留下确认结果；即使租约到期也绝不重发', row.id])
		}
		if (row.state === 'prepared') {
			// This state proves append was not started. Abandon, never resume with new codes.
			await this.fenced(lease, "UPDATE sponsor_stock_batches SET state='rejected',last_error=? WHERE id=? AND state='prepared'", ['准备阶段中断，未执行外部追加；请审核核心码批次', row.id])
		} else {
			await this.fenced(lease, 'UPDATE sponsor_stock_settings SET paused=1,enabled=0,last_error=? WHERE plan_id=?', ['存在未确认发送批次，必须人工正向对账', planId])
		}
	}
	private async refresh(lease: Lease, planId: string, plans: Plan[]) {
		try {
			const observed = await this.client.queryPlans(plans)
			const item = observed.find(p => p.planId === planId)
			if (!item) throw new AfdianError('afdian_mapping')
			const fingerprint = this.fingerprint(plans)
			await this.fenced(lease, `UPDATE sponsor_stock_settings SET product_stock=?,observed_line_count=?,last_stock=?,last_checked_at=?,
				next_check_at=?+check_interval_seconds,last_error=NULL,read_fingerprint=?,
				enabled=CASE WHEN verified_fingerprint=? THEN enabled ELSE 0 END,
				verified=CASE WHEN verified_fingerprint=? THEN verified ELSE 0 END WHERE plan_id=?`,
			[item.productStock, item.lines.length, this.env.AFDIAN_STOCK_POOL_VERIFIED === 'true' ? item.lines.length : null, this.now(), this.now(), fingerprint, fingerprint, fingerprint, planId])
			return item
		} catch (error) {
			await this.fenced(lease, 'UPDATE sponsor_stock_settings SET last_stock=NULL,last_checked_at=?,next_check_at=?+check_interval_seconds,last_error=?,read_fingerprint=NULL,enabled=0 WHERE plan_id=?', [this.now(), this.now(), safeError(error), planId])
			throw error
		}
	}

	/** Read-only external validation; it never sets verified=true or starts a refill. */
	async check(planId: string, reason: string, actorId: string): Promise<StockSetting> {
		requireReason(reason)
		const plans = await this.plans()
		const plan = this.selectPlan(plans, planId)
		const lease = await this.acquire(plan.afdian_sku_id)
		try {
			await this.audit(actorId, `stock.check:${planId}`, reason)
			await this.recover(lease, planId)
			try { await this.refresh(lease, planId, plans) } catch (error) {
				if (error instanceof SponsorStockError) throw error
			}
			return (await this.list()).items.find(item => item.plan_id === planId)!
		} finally { await this.release(lease) }
	}

	/** Update only operator controls. All verification evidence remains server-owned. */
	async update(planId: string, setting: Partial<StockSetting>, reason: string, actorId: string): Promise<StockSetting> {
		requireReason(reason)
		if (!setting || typeof setting !== 'object' || Array.isArray(setting)) throw new SponsorStockError('invalid_setting', '库存设置格式错误', 400)
		const plans = await this.plans()
		const plan = this.selectPlan(plans, planId)
		const lease = await this.acquire(plan.afdian_sku_id)
		try {
			await this.recover(lease, planId)
			const row = await this.row(planId)
			const config = await (this.deps.getConfig ?? getSponsorConfig)(this.env)
			const current = this.view(row, this.fingerprint(plans), config.enabled && plan.enabled, Boolean(await this.unresolved(planId)))
			if (setting.verified !== undefined && setting.verified !== current.verified) throw new SponsorStockError('stock_verification_readonly', '验证状态只能由服务器根据正向证据更新')
			if (setting.plan_id !== undefined && setting.plan_id !== planId) throw new SponsorStockError('invalid_setting', '方案编号不匹配', 400)
			const enabled = setting.enabled ?? current.enabled
			const paused = setting.paused ?? current.paused
			const low = setting.low_water ?? row.low_water
			const target = setting.target_stock ?? row.target_stock
			const size = setting.batch_size ?? row.batch_size
			const interval = setting.check_interval_seconds ?? row.check_interval_seconds
			if (typeof enabled !== 'boolean' || typeof paused !== 'boolean' || !integer(low, 0, 199) || !integer(target, 1, 200) || low >= target || !integer(size, 1, 200) || !integer(interval, 300, 86400)) throw new SponsorStockError('invalid_setting', '库存阈值、批量或检查间隔不合法', 400)
			if (!paused && await this.unresolved(planId)) throw new SponsorStockError('stock_unknown_blocked', '存在未确认批次，不能取消暂停')
			if (enabled && (!current.can_enable || paused)) throw new SponsorStockError('stock_not_verified', current.verification_message)
			await this.audit(actorId, `stock.setting:${planId}`, reason)
			await this.fenced(lease, 'UPDATE sponsor_stock_settings SET enabled=?,paused=?,low_water=?,target_stock=?,batch_size=?,check_interval_seconds=? WHERE plan_id=?', [Number(enabled), Number(paused), low, target, size, interval, planId])
			return (await this.list()).items.find(item => item.plan_id === planId)!
		} finally { await this.release(lease) }
	}

	private async markUnknown(lease: Lease, batch: BatchRow, message: string) {
		await this.fenced(lease, "UPDATE sponsor_stock_batches SET state='unknown',last_error=? WHERE id=? AND state IN ('sending','unknown')", [message, batch.id])
		await this.fenced(lease, 'UPDATE sponsor_stock_settings SET paused=1,enabled=0,last_error=? WHERE plan_id=?', [message, batch.plan_id])
	}
	private async confirm(lease: Lease, batch: BatchRow, plans: Plan[]) {
		await this.fenced(lease, "UPDATE sponsor_stock_batches SET state='confirmed',confirmed_at=?,last_error=NULL WHERE id=? AND state IN ('sending','unknown')", [this.now(), batch.id])
		// Never auto-unpause/enable after uncertainty; an admin must explicitly resume.
		if (batch.fingerprint === this.fingerprint(plans) && this.contracts()) {
			await this.fenced(lease, 'UPDATE sponsor_stock_settings SET verified=1,verified_fingerprint=?,last_error=NULL WHERE plan_id=?', [batch.fingerprint, batch.plan_id])
		}
	}
	private response(batch: StockBatch) { return { batch_id: batch.id, state: batch.state } }

	private async refillLocked(lease: Lease, planId: string, operationId: string, count: number | undefined, reason: string, actorId: string | null, plans: Plan[], automatic: boolean) {
		const replay = await this.db().prepare('SELECT * FROM sponsor_stock_batches WHERE operation_id=?').bind(operationId).first<BatchRow>()
		if (replay) {
			if (replay.plan_id !== planId || (count !== undefined && count !== replay.count)) throw new SponsorStockError('idempotency_conflict', '操作编号已用于不同补货请求')
			return this.response(replay) // never retransmit any prior operation, including prepared
		}
		const plan = this.selectPlan(plans, planId)
		const config = await (this.deps.getConfig ?? getSponsorConfig)(this.env)
		if (!config.enabled || !plan.enabled) throw new SponsorStockError('sponsors_disabled', '赞助功能或方案尚未启用', 503)
		if (!this.configured() || !this.contracts()) throw new SponsorStockError('stock_contract_unverified', CONTRACT_MESSAGE, 503)
		const row = await this.row(planId)
		const fingerprint = this.fingerprint(plans)
		if (row.paused || await this.unresolved(planId)) throw new SponsorStockError('stock_unknown_blocked', '存在暂停或未确认批次，禁止补货')
		if (row.read_fingerprint !== fingerprint || row.last_error !== null || row.last_checked_at === null || this.now() - row.last_checked_at > row.check_interval_seconds) throw new SponsorStockError('stock_check_required', '请先执行当前配置的只读核对')
		const verified = Boolean(row.verified && row.verified_fingerprint === fingerprint)
		if (automatic && (!row.enabled || !verified)) throw new SponsorStockError('stock_not_verified', '自动补货未启用或未验证')
		if (!verified && (automatic || count !== 1)) throw new SponsorStockError('stock_probe_required', '首次验证仅允许管理员手动补充 1 个兑换码')
		const observed = await this.refresh(lease, planId, plans)
		const amount = count ?? Math.min(row.batch_size, row.target_stock - observed.lines.length)
		if (automatic && observed.lines.length >= row.low_water) return null
		if (!integer(amount, 1, Math.min(200, row.batch_size)) || observed.lines.length + amount > row.target_stock) throw new SponsorStockError('invalid_stock_count', '补货数量超过批量或目标上限', 400)
		await this.audit(actorId, `stock.refill:${planId}`, reason)
		const id = crypto.randomUUID()
		await this.assertLease(lease)
		const inserted = await this.db().prepare(`INSERT INTO sponsor_stock_batches
			(id,operation_id,plan_id,afdian_plan_id,sku_id,fingerprint,state,count,initial_probe,actor_id,reason,created_at)
			SELECT ?,?,?,?,?,?,'prepared',?,?,?,?,? WHERE EXISTS
			(SELECT 1 FROM sponsor_stock_leases WHERE sku_id=? AND owner=? AND expires_at>?)`)
			.bind(id, operationId, planId, plan.afdian_plan_id, plan.afdian_sku_id, fingerprint, amount, Number(!verified), actorId, reason, this.now(), lease.skuId, lease.owner, this.now()).run()
		if (inserted.meta.changes !== 1) throw new SponsorStockError('stock_lease_lost', '库存租约已失效')
		let batch = (await this.db().prepare('SELECT * FROM sponsor_stock_batches WHERE id=?').bind(id).first<BatchRow>())!
		try {
			const created = await (this.deps.createBatch ?? createSponsorCodeBatch)(this.env, { planId, count: amount, expiresAt: null, operationId, reason, actorId, source: 'afdian' })
			await this.fenced(lease, "UPDATE sponsor_stock_batches SET code_batch_id=? WHERE id=? AND state='prepared'", [created.id, id])
			batch = { ...batch, code_batch_id: created.id }
			const codes = await (this.deps.exportBatch ?? exportSponsorCodeBatch)(this.env, created.id)
			if (codes.length !== amount || codes.some(code => observed.lines.includes(code))) throw new SponsorStockError('stock_code_batch_invalid', '生成的兑换码批次无法安全追加')
			// Recheck server switches/catalog after asynchronous encryption, before the one-way send fence.
			if (!(await (this.deps.getConfig ?? getSponsorConfig)(this.env)).enabled || this.fingerprint(await this.plans()) !== fingerprint) throw new SponsorStockError('stock_catalog_changed', '后台方案已变化，禁止继续追加')
			await this.fenced(lease, "UPDATE sponsor_stock_batches SET state='sending',sent_at=? WHERE id=? AND state='prepared' AND code_batch_id IS NOT NULL", [this.now(), id])
			batch.state = 'sending'
			try { await this.client.append(plan.afdian_sku_id, codes) } catch (error) {
				if (error instanceof AfdianError && error.definitelyRejected) {
					await this.fenced(lease, "UPDATE sponsor_stock_batches SET state='rejected',last_error=? WHERE id=? AND state='sending'", ['接口在执行前明确拒绝请求；原批次不会重发', id])
					return { batch_id: id, state: 'rejected' as const }
				}
				await this.markUnknown(lease, batch, safeError(error))
				return { batch_id: id, state: 'unknown' as const }
			}
			const after = await this.refresh(lease, planId, plans)
			if (!codes.every(code => after.lines.includes(code))) {
				await this.markUnknown(lease, batch, '追加响应不能证明全部兑换码已入池；缺失不代表失败，禁止重发')
				return { batch_id: id, state: 'unknown' as const }
			}
			await this.confirm(lease, batch, plans)
			return { batch_id: id, state: 'confirmed' as const }
		} catch (error) {
			if (batch.state === 'sending') {
				await this.markUnknown(lease, batch, safeError(error))
				return { batch_id: id, state: 'unknown' as const }
			}
			await this.fenced(lease, "UPDATE sponsor_stock_batches SET state='rejected',last_error=? WHERE id=? AND state='prepared'", ['本地准备未完成，未执行追加；请审核核心码批次', id])
			throw error instanceof SponsorStockError ? error : new SponsorStockError('stock_prepare_failed', '兑换码批次准备失败，未执行追加', 503)
		}
	}

	/** Explicit audited refill. Initial contract probe is exactly one code; retries return state only. */
	async refill(planId: string, operationId: string, count: number | undefined, reason: string, actorId: string) {
		requireReason(reason); requireOperation(operationId)
		if (count !== undefined && !integer(count, 1, 200)) throw new SponsorStockError('invalid_stock_count', '补货数量必须为 1 至 200 的整数', 400)
		const plans = await this.plans()
		const lease = await this.acquire(this.selectPlan(plans, planId).afdian_sku_id)
		try {
			await this.recover(lease, planId)
			return await this.refillLocked(lease, planId, operationId, count, reason, actorId, plans, false)
		} finally { await this.release(lease) }
	}

	/** Paginated metadata only. Raw code export belongs to the audited core admin endpoint. */
	async batches(limit = 20, offset = 0) {
		if (!integer(limit, 1, 100) || !integer(offset, 0, 100000)) throw new SponsorStockError('invalid_pagination', '分页参数不合法', 400)
		const items = await this.db().prepare('SELECT id,plan_id,code_batch_id,state,count,created_at,last_error FROM sponsor_stock_batches ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').bind(limit, offset).all<StockBatch>()
		const total = await this.db().prepare('SELECT COUNT(*) AS total FROM sponsor_stock_batches').first<{ total: number }>()
		return { items: items.results, total: total?.total ?? 0 }
	}

	/** Reconcile only from exact positive remaining-pool lines or official queried order replies. */
	async reconcile(id: string, reason: string, actorId: string, outTradeNos: string[] = []) {
		requireReason(reason)
		if (!Array.isArray(outTradeNos) || outTradeNos.length > 20 || outTradeNos.some(value => typeof value !== 'string' || !/^\d{8,64}$/.test(value))) throw new SponsorStockError('invalid_orders', '最多提供 20 个有效订单号', 400)
		const batch = await this.db().prepare('SELECT * FROM sponsor_stock_batches WHERE id=?').bind(id).first<BatchRow>()
		if (!batch) throw new SponsorStockError('stock_batch_not_found', '未找到库存批次', 404)
		const lease = await this.acquire(batch.sku_id)
		try {
			await this.audit(actorId, `stock.reconcile:${id}`, reason)
			await this.recover(lease, batch.plan_id)
			if (batch.state === 'confirmed' || batch.state === 'rejected') return this.response(batch)
			if (batch.state === 'prepared') return { batch_id: id, state: 'rejected' as const }
			if (!batch.code_batch_id) throw new SponsorStockError('stock_batch_missing_codes', '批次缺少持久化码记录，不能确认')
			const codes = await (this.deps.exportBatch ?? exportSponsorCodeBatch)(this.env, batch.code_batch_id)
			const plans = await this.plans()
			const evidence = new Set<string>()
			try {
				if (this.env.AFDIAN_STOCK_POOL_VERIFIED === 'true' && batch.fingerprint === this.fingerprint(plans)) {
					const observed = await this.refresh(lease, batch.plan_id, plans)
					observed.lines.forEach(line => evidence.add(line))
				}
			} catch (error) { if (error instanceof SponsorStockError) throw error }
			try {
				if (outTradeNos.length) (await this.client.queryReplies(outTradeNos)).forEach(line => evidence.add(line))
			} catch (error) { if (error instanceof SponsorStockError) throw error }
			if (codes.length === batch.count && codes.every(code => evidence.has(code))) {
				await this.confirm(lease, batch, plans)
				return { batch_id: id, state: 'confirmed' as const }
			}
			await this.markUnknown(lease, batch, '正向证据尚未覆盖全部兑换码；缺失不代表失败，批次仍暂停且禁止重发')
			return { batch_id: id, state: 'unknown' as const }
		} finally { await this.release(lease) }
	}

	/** Safe cron: no secrets/flags/global switch means no external calls and no code creation. */
	async cron(): Promise<{ checked: number; refilled: number; skipped: number }> {
		const result = { checked: 0, refilled: 0, skipped: 0 }
		if (!this.configured() || !this.contracts()) return { ...result, skipped: 5 }
		if (!(await (this.deps.getConfig ?? getSponsorConfig)(this.env)).enabled) return { ...result, skipped: 5 }
		const plans = await this.plans()
		const due = await this.db().prepare(`SELECT plan_id FROM sponsor_stock_settings WHERE enabled=1 AND verified=1 AND paused=0 AND (next_check_at IS NULL OR next_check_at<=?) LIMIT 5`).bind(this.now()).all<{ plan_id: string }>()
		for (const item of due.results) {
			const plan = this.selectPlan(plans, item.plan_id)
			if (!plan.enabled) { result.skipped++; continue }
			let lease: Lease | undefined
			try {
				lease = await this.acquire(plan.afdian_sku_id)
				await this.recover(lease, plan.id)
				const row = await this.row(plan.id)
				if (!row.enabled || row.paused || (row.next_check_at !== null && row.next_check_at > this.now()) || await this.unresolved(plan.id)) { result.skipped++; continue }
				await this.refresh(lease, plan.id, plans)
				result.checked++
				const state = await this.refillLocked(lease, plan.id, crypto.randomUUID(), undefined, '定时检查低水位补货', null, plans, true)
				if (state?.state === 'confirmed') result.refilled++
			} catch { result.skipped++ } // no exception/raw upstream/secret/code logging
			finally { if (lease) await this.release(lease) }
		}
		return result
	}
}

/** Main scheduled handler should await this function, or pass its promise to ctx.waitUntil. */
export async function runSponsorStockCron(env: SponsorStockEnv): Promise<{ checked: number; refilled: number; skipped: number }> {
	return new SponsorStockService(env).cron()
}
