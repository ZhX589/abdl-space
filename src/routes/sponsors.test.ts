import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { Hono } from 'hono'

import { signJWT } from '../lib/auth.ts'
import type { PublicSponsor, SponsorMe } from '../types/index.ts'
import { cleanupSponsorRateLimits, createSponsorCodeBatch, exportSponsorCodeBatch, getSponsorConfig, getSponsorMe, redeemSponsorCode, sponsorAccountProjectionMiddleware } from '../lib/sponsors.ts'
import sponsorsRoutes from './sponsors.ts'
import adminSponsorsRoutes from './admin-sponsors.ts'
import adminSponsorStockRoutes from './admin-sponsor-stock.ts'

const jwtSecret = crypto.randomUUID()
const randomCodeKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')

function loadScript(relative: string): string {
	return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

const SCHEMA_SQL = loadScript('../../schemas/schema.sql')
const SPONSORS_SQL = loadScript('../../migrations/0062_sponsors.sql')
const STOCK_SQL = loadScript('../../migrations/0063_sponsor_stock.sql')
const VALID_CONFIG = JSON.parse(SPONSORS_SQL.match(/VALUES \(1, 1, '(.*)'\);/)![1])

type Statement = { _sql: string, _params: unknown[] }

function makeD1(database: DatabaseSync) {
	const makeStatement = (sql: string) => {
		const bound = database.prepare(sql)
		return {
			_sql: sql,
			async all<T>() {
				return { success: true, results: bound.all() as T[] }
			},
			async first<T>() {
				return (bound.get() ?? null) as T | null
			},
			async run() {
				const result = bound.run()
				return { success: true, meta: { changes: Number(result.changes) } }
			},
			bind: (...params: unknown[]) => ({
				_sql: sql,
				_params: params,
				async all<T>() {
					return { success: true, results: bound.all(...params) as T[] }
				},
				async first<T>() {
					return (bound.get(...params) ?? null) as T | null
				},
				async run() {
					const result = bound.run(...params)
					return { success: true, meta: { changes: Number(result.changes) } }
				},
			}),
		}
	}
	const d1 = {
		prepare: makeStatement,
		async batch(statements: Statement[]) {
			database.exec('BEGIN IMMEDIATE')
			try {
				const results = statements.map(statement => {
					const result = database.prepare(statement._sql).run(...statement._params)
					return { success: true, meta: { changes: Number(result.changes) } }
				})
				database.exec('COMMIT')
				return results
			} catch (error) {
				database.exec('ROLLBACK')
				throw error
			}
		},
	}
	return d1
}

function createDb(options: { codeKey?: string } = {}) {
	const database = new DatabaseSync(':memory:')
	database.exec('PRAGMA foreign_keys = ON;')
	database.exec(SCHEMA_SQL)
	database.exec(loadScript('../../migrations/oauth.sql'))
	database.exec(SPONSORS_SQL)
	database.exec(STOCK_SQL)
	return {
		database,
		env: {
			abdl_space_db: makeD1(database),
			JWT_SECRET: jwtSecret,
			SPONSOR_CODE_KEY: options.codeKey,
		},
	}
}

function createApp() {
	const app = new Hono()
	app.route('/api/v1/sponsors', sponsorsRoutes)
	app.route('/api/admin/sponsors/stock', adminSponsorStockRoutes)
	app.route('/api/admin/sponsors', adminSponsorsRoutes)
	return app
}

async function bearer(db: ReturnType<typeof createDb>, sub: number, role = 'user') {
	db.database.prepare("INSERT INTO users (id, username, email, password_hash, role) VALUES (?, ?, ?, 'x', ?) ON CONFLICT(id) DO UPDATE SET role=excluded.role")
		.run(sub, `user${sub}`, `user${sub}@example.test`, role)
	return `Bearer ${await signJWT({ sub, username: `user${sub}`, email: `user${sub}@example.test`, role }, jwtSecret)}`
}

async function userRequest(db: ReturnType<typeof createDb>, sub: number, method: string, path: string, body?: unknown, token?: string) {
	return createApp().request(`/api/v1/sponsors${path}`, {
		method,
		headers: {
			Authorization: token ?? await bearer(db, sub),
			...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	}, db.env as never)
}

async function adminRequest(db: ReturnType<typeof createDb>, method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
	return createApp().request(`/api/admin/sponsors${path}`, {
		method,
		headers: {
			Authorization: await bearer(db, 1, 'admin'),
			...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
			...extraHeaders,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	}, db.env as never)
}

function getConfigRow(db: ReturnType<typeof createDb>): Record<string, unknown> {
	return JSON.parse(String(db.database.prepare('SELECT config_json FROM sponsor_settings WHERE id=1').get()!.config_json))
}

function setConfig(db: ReturnType<typeof createDb>, config: Record<string, unknown>) {
	db.database.prepare('UPDATE sponsor_settings SET config_json = ? WHERE id = 1').run(JSON.stringify(config))
}

async function enableConfig(db: ReturnType<typeof createDb>) {
	const config = getConfigRow(db)
	config.enabled = true
	setConfig(db, config)
}

async function mintCode(db: ReturnType<typeof createDb>, planId: string): Promise<string> {
	await enableConfig(db)
	const created = await createSponsorCodeBatch(db.env as never, {
		planId, count: 1, expiresAt: null, operationId: crypto.randomUUID(),
		reason: '测试发码', actorId: '1', source: 'admin',
	})
	return (await exportSponsorCodeBatch(db.env as never, created.id))[0]
}

test('迁移与种子：五个初始方案、总开关默认关闭', async () => {
	const db = createDb()
	const config = await getSponsorConfig(db.env as never)
	assert.equal(config.enabled, false)
	assert.equal(config.free_daily_limit, 3)
	assert.equal(config.sponsor_daily_limit, 25)
	assert.deepEqual(config.colors.map(color => color.name), ['宝宝蓝', '宝宝粉', '金色'])
	assert.match(config.notice_body, /运营成本/)
	db.database.exec(SPONSORS_SQL)
	assert.deepEqual(await getSponsorConfig(db.env as never), config)
	const plans = db.database.prepare('SELECT plan_json FROM sponsor_plans ORDER BY sort_order').all() as { plan_json: string }[]
	assert.deepEqual(plans.map(row => JSON.parse(row.plan_json).id), ['week', 'month', 'quarter', 'year', 'permanent'])
	const permanent = JSON.parse(plans[4].plan_json)
	assert.equal(permanent.price_minor, 9900)
	assert.equal(permanent.duration_unit, 'permanent')
})

test('catalog 在开关关闭时仍可读取；未鉴权 me 返回 401', async () => {
	const db = createDb()
	const app = createApp()
	const catalog = await app.request('/api/v1/sponsors/catalog', {}, db.env as never)
	assert.equal(catalog.status, 200)
	const body = await catalog.json() as { config: { enabled: boolean }, plans: unknown[] }
	assert.equal(body.config.enabled, false)
	assert.equal(body.plans.length, 5)

	const me = await app.request('/api/v1/sponsors/me', {}, db.env as never)
	assert.equal(me.status, 401)
	const err = await me.json() as { code: string }
	assert.equal(err.code, 'unauthenticated')
})

test('普通用户兑换：身份激活，重复 operation_id 幂等重放，二次兑换失败', async () => {
	const db = createDb({ codeKey: randomCodeKey() })
	await enableConfig(db)
	const raw = await mintCode(db, 'month')
	const app = createApp()
	const token = await bearer(db, 7)
	const operationId = crypto.randomUUID()
	const redeem = await app.request('/api/v1/sponsors/redeem', {
		method: 'POST',
		headers: { Authorization: token, 'Content-Type': 'application/json' },
		body: JSON.stringify({ code: raw, operation_id: operationId }),
	}, db.env as never)
	assert.equal(redeem.status, 200)
	const me = await redeem.json() as { sponsor: { active: boolean } }
	assert.equal(me.sponsor.active, true)

	const retry = await app.request('/api/v1/sponsors/redeem', {
		method: 'POST',
		headers: { Authorization: token, 'Content-Type': 'application/json' },
		body: JSON.stringify({ code: raw, operation_id: operationId }),
	}, db.env as never)
	assert.equal(retry.status, 200)
	const retryBody = await retry.json() as { sponsor: { active: boolean } }
	assert.equal(retryBody.sponsor.active, true)

	const second = await app.request('/api/v1/sponsors/redeem', {
		method: 'POST',
		headers: { Authorization: token, 'Content-Type': 'application/json' },
		body: JSON.stringify({ code: raw, operation_id: crypto.randomUUID() }),
	}, db.env as never)
	assert.equal(second.status, 409)
	const err = await second.json() as { code: string }
	assert.equal(err.code, 'code_unavailable')
})

test('同一码并发兑换只成功一次（触发器条件消费）', async () => {
	const db = createDb({ codeKey: randomCodeKey() })
	await enableConfig(db)
	const raw = await mintCode(db, 'week')
	const app = createApp()
	const results = await Promise.all([2, 3, 4].map(async userId => {
		const token = await bearer(db, userId)
		const response = await app.request('/api/v1/sponsors/redeem', {
			method: 'POST',
			headers: { Authorization: token, 'Content-Type': 'application/json' },
			body: JSON.stringify({ code: raw, operation_id: crypto.randomUUID() }),
		}, db.env as never)
		return response.status
	}))
	assert.equal(results.filter(status => status === 200).length, 1)
	assert.equal(results.filter(status => status === 409).length, 2)
	const redeemed = db.database.prepare('SELECT COUNT(*) AS c FROM sponsor_codes WHERE redeemed_at IS NOT NULL').get() as { c: number }
	assert.equal(redeemed.c, 1)
})

test('原图授权：同 UUID 并发重试仅扣一次、换媒体冲突、同媒体新 UUID 按次计费、跨日拒绝', async () => {
	const db = createDb()
	await enableConfig(db)
	const token = await bearer(db, 11)
	const operationId = crypto.randomUUID()
	const payload = { operation_id: operationId, media_key: 'a'.repeat(64) }
	const first = await userRequest(db, 11, 'POST', '/original-authorizations', payload, token)
	assert.equal(first.status, 409)
	assert.equal((await first.json() as { code: string }).code, 'notice_required')
	assert.equal(db.database.prepare('SELECT COUNT(*) AS n FROM sponsor_notice_acks').get()!.n, 0)
	const accepted = await Promise.all([0, 1].map(() => userRequest(db, 11, 'POST', '/original-authorizations', { ...payload, notice_version: 1 }, token)))
	for (const response of accepted) assert.equal(response.status, 200)
	const results = await Promise.all(accepted.map(response => response.json() as Promise<{ replayed: boolean; quota: SponsorMe['quota'] }>))
	assert.deepEqual(results.map(result => result.replayed).sort(), [false, true])
	assert.ok(results.every(result => result.quota.used === 1))
	const conflict = await userRequest(db, 11, 'POST', '/original-authorizations', { ...payload, media_key: 'b'.repeat(64) }, token)
	assert.equal(conflict.status, 409)
	assert.equal((await conflict.json() as { code: string }).code, 'idempotency_conflict')
	for (const used of [2, 3]) {
		const response = await userRequest(db, 11, 'POST', '/original-authorizations', { ...payload, operation_id: crypto.randomUUID() }, token)
		assert.equal(response.status, 200)
		assert.equal((await response.json() as { quota: SponsorMe['quota'] }).quota.used, used)
	}
	const exhausted = await userRequest(db, 11, 'POST', '/original-authorizations', { ...payload, operation_id: crypto.randomUUID() }, token)
	assert.equal(exhausted.status, 402)
	const replay = await userRequest(db, 11, 'POST', '/original-authorizations', payload, token)
	assert.equal(replay.status, 200)
	assert.equal((await replay.json() as { replayed: boolean }).replayed, true)
	assert.equal((await getSponsorMe(db.env as never, 11)).quota.used, 3)
	assert.equal(db.database.prepare("SELECT COUNT(*) AS n FROM sponsor_audit WHERE action='original'").get()!.n, 3)
	db.database.prepare("UPDATE sponsor_operations SET day_key=date('now','+8 hours','-1 day') WHERE operation_id=?").run(operationId)
	const stale = await userRequest(db, 11, 'POST', '/original-authorizations', payload, token)
	assert.equal(stale.status, 409)
	assert.equal((await stale.json() as { code: string }).code, 'operation_expired')
	assert.equal((await getSponsorMe(db.env as never, 11)).quota.used, 3)
})

test('管理：配置乐观版本、授予与撤销、审计留痕', async () => {
	const db = createDb()
	await enableConfig(db)
	const current = await adminRequest(db, 'GET', '/config')
	assert.equal(current.status, 200)
	const config = await current.json() as { version: number, enabled: boolean }
	assert.equal(config.enabled, true)

	const update = await adminRequest(db, 'PUT', '/config', {
		config: { ...config, center_title: 'ABDL Space 赞助者中心' },
		expected_version: config.version,
		reason: '改标题测试',
	})
	assert.equal(update.status, 200)

	const conflict = await adminRequest(db, 'PUT', '/config', {
		config: { ...config, center_title: '旧版本冲突' },
		expected_version: config.version,
		reason: '版本冲突测试',
	})
	assert.equal(conflict.status, 409)

	await bearer(db, 12)
	const grant = await adminRequest(db, 'POST', '/users/12/grants', {
		plan_id: 'year', operation_id: crypto.randomUUID(), reason: '客服补偿',
	})
	assert.equal(grant.status, 200)
	const granted = await grant.json() as { sponsor: { active: boolean, plan_name: string } }
	assert.equal(granted.sponsor.active, true)
	assert.equal(granted.sponsor.plan_name, '年赞助者')

	const revoke = await adminRequest(db, 'POST', '/users/12/revoke', {
		operation_id: crypto.randomUUID(), reason: '退款撤销',
	})
	assert.equal(revoke.status, 200)
	const revoked = await revoke.json() as { sponsor: { active: boolean } }
	assert.equal(revoked.sponsor.active, false)

	const audit = await adminRequest(db, 'GET', '/audit?limit=50')
	const auditBody = await audit.json() as { items: { action: string }[] }
	assert.ok(auditBody.items.some(item => item.action === 'grant'))
	assert.ok(auditBody.items.some(item => item.action === 'revoke'))
})

test('管理：无 Origin 的 cookie 写入被拒绝、非管理员 403', async () => {
	const db = createDb()
	await enableConfig(db)
	const userToken = await bearer(db, 21)
	const app = createApp()
	const forbidden = await app.request('/api/admin/sponsors/config', { headers: { Authorization: userToken } }, db.env as never)
	assert.equal(forbidden.status, 403)

	const adminToken = await bearer(db, 1, 'admin')
	const csrf = await app.request('/api/admin/sponsors/config', {
		method: 'PUT',
		headers: { Authorization: adminToken, 'Content-Type': 'application/json', Cookie: `token=${adminToken}` },
		body: JSON.stringify({ config: getConfigRow(db), expected_version: 1, reason: 'csrf 测试' }),
	}, db.env as never)
	assert.equal(csrf.status, 403)
})

test('并发续期：同一用户不同码不丢失更新', async () => {
	const db = createDb({ codeKey: randomCodeKey() })
	await enableConfig(db)
	const raw1 = await mintCode(db, 'month')
	const raw2 = await mintCode(db, 'month')
	const app = createApp()
	const token = await bearer(db, 31)
	db.database.prepare('INSERT INTO sponsor_memberships(user_id,expires_at) VALUES(31,?)').run(Date.parse('2028-01-15T23:45:12+08:00') / 1000)
	const results = await Promise.all([raw1, raw2].map(async code => {
		const response = await app.request('/api/v1/sponsors/redeem', {
			method: 'POST',
			headers: { Authorization: token, 'Content-Type': 'application/json' },
			body: JSON.stringify({ code, operation_id: crypto.randomUUID() }),
		}, db.env as never)
		return response.status
	}))
	assert.deepEqual(results.sort(), [200, 200])
	const membership = db.database.prepare('SELECT expires_at FROM sponsor_memberships WHERE user_id=31').get() as { expires_at: number }
	assert.equal(membership.expires_at, Date.parse('2028-03-15T23:45:12+08:00') / 1000)
	assert.equal(db.database.prepare('SELECT COUNT(*) AS n FROM sponsor_redemptions WHERE user_id=31').get()!.n, 2)
})

test('管理：兑换码列表只返回脱敏码，状态枚举正确', async () => {
	const db = createDb({ codeKey: randomCodeKey() })
	await enableConfig(db)
	const raw = await mintCode(db, 'quarter')
	assert.ok(raw.startsWith('ABDL-'))
	const list = await adminRequest(db, 'GET', '/codes?plan_id=quarter')
	const body = await list.json() as { items: { masked_code: string, state: string }[] }
	assert.equal(body.items.length, 1)
	assert.equal(body.items[0].state, 'active')
	assert.ok(body.items[0].masked_code.includes('••••'))
	assert.ok(!JSON.stringify(body.items).includes(raw))

	await bearer(db, 41)
	const redeem = await redeemSponsorCode(db.env as never, 41, { code: raw, operation_id: crypto.randomUUID() })
	assert.equal(redeem.sponsor.active, true)
	const afterList = await adminRequest(db, 'GET', '/codes?state=redeemed')
	const afterBody = await afterList.json() as { items: { state: string }[] }
	assert.equal(afterBody.items.length, 1)
	assert.equal(afterBody.items[0].state, 'redeemed')
})

test('stock：默认全部未验证且关闭，凭据缺失时 check 不崩溃', async () => {
	const db = createDb()
	const list = await adminRequest(db, 'GET', '/stock')
	const body = await list.json() as { credentials: Record<string, boolean>, items: { plan_id: string, enabled: boolean, verified: boolean }[] }
	assert.equal(body.credentials.user_id_configured, false)
	assert.equal(body.items.length, 5)
	assert.ok(body.items.every(item => !item.enabled && !item.verified))

	const check = await adminRequest(db, 'POST', '/stock/week/check', { reason: '只读核对测试' })
	assert.equal(check.status, 200)
	const checkBody = await check.json() as { last_error: string | null }
	assert.ok(checkBody.last_error !== null)
})

test('永久用户再兑换被拒绝且码不被消耗', async () => {
	const db = createDb({ codeKey: randomCodeKey() })
	await enableConfig(db)
	const app = createApp()
	await bearer(db, 51)
	const permanent = await adminRequest(db, 'POST', '/users/51/grants', {
		plan_id: 'permanent', operation_id: crypto.randomUUID(), reason: '永久授予测试',
	})
	assert.equal(permanent.status, 200)
	const raw = await mintCode(db, 'month')
	const token = await bearer(db, 51)
	const denied = await app.request('/api/v1/sponsors/redeem', {
		method: 'POST',
		headers: { Authorization: token, 'Content-Type': 'application/json' },
		body: JSON.stringify({ code: raw, operation_id: crypto.randomUUID() }),
	}, db.env as never)
	assert.equal(denied.status, 409)
	const err = await denied.json() as { code: string }
	assert.equal(err.code, 'already_permanent')
	const code = db.database.prepare('SELECT redeemed_at FROM sponsor_codes LIMIT 1').get() as { redeemed_at: number | null }
	assert.equal(code.redeemed_at, null)
})

test('导出批次的码可以完成兑换（加密往返）', async () => {
	const db = createDb({ codeKey: randomCodeKey() })
	await enableConfig(db)
	const batch = await adminRequest(db, 'POST', '/code-batches', {
		plan_id: 'year', count: 3, operation_id: crypto.randomUUID(), reason: '导出测试',
	})
	assert.equal(batch.status, 201)
	const { id } = await batch.json() as { id: string }
	const exported = await adminRequest(db, 'POST', `/code-batches/${id}/export`, { reason: '导出测试' })
	assert.equal(exported.status, 200)
	const { codes } = await exported.json() as { codes: string[] }
	assert.equal(codes.length, 3)
	await bearer(db, 61)
	const me = await redeemSponsorCode(db.env as never, 61, { code: codes[0], operation_id: crypto.randomUUID() })
	assert.equal(me.sponsor.active, true)
	const remaining = await adminRequest(db, 'GET', '/codes?plan_id=year&state=active')
	const body = await remaining.json() as { items: unknown[] }
	assert.equal(body.items.length, 2)
})

test('配置校验：最小阅读秒数不能低于 5、颜色必须 #RRGGBB', async () => {
	const db = createDb()
	await enableConfig(db)
	const config = await adminRequest(db, 'GET', '/config')
	const current = await config.json() as { version: number }
	const bad = await adminRequest(db, 'PUT', '/config', {
		config: { ...VALID_CONFIG, version: current.version, minimum_read_seconds: 3, enabled: true },
		expected_version: current.version,
		reason: '低于最小时长测试',
	})
	assert.equal(bad.status, 422)
	const badColors = await adminRequest(db, 'PUT', '/config', {
		config: { ...VALID_CONFIG, version: current.version, enabled: true, colors: [{ key: 'x', name: 'X', light: 'red', dark: '#000000', permanent_only: false }] },
		expected_version: current.version,
		reason: '非法颜色测试',
	})
	assert.equal(badColors.status, 422)
})

test('origin 防护：非 JSON 写入被拒绝', async () => {
	const db = createDb()
	await enableConfig(db)
	const adminToken = await bearer(db, 1, 'admin')
	const app = createApp()
	const wrongType = await app.request('/api/admin/sponsors/config', {
		method: 'PUT',
		headers: { Authorization: adminToken, 'Content-Type': 'text/plain' },
		body: 'config',
	}, db.env as never)
	// text/plain 命中 CSRF 防护（cookie 缺失时 content-type 校验先返回 400 或 403 均为拒绝）
	assert.ok([400, 403].includes(wrongType.status), `expected 400 or 403, got ${wrongType.status}`)
})

test('永久身份自动使用首个专属色，不沿用粉色；普通身份仅允许普通色，过期恢复', async () => {
	const db = createDb()
	await enableConfig(db)
	const token = await bearer(db, 71)
	assert.equal((await adminRequest(db, 'POST', '/users/71/grants', { plan_id: 'month', operation_id: crypto.randomUUID(), reason: '测试普通色' })).status, 200)
	assert.equal((await userRequest(db, 71, 'PUT', '/color', { color_key: 'gold' }, token)).status, 422)
	assert.equal((await userRequest(db, 71, 'PUT', '/color', { color_key: 'pink' }, token)).status, 200)
	const upgraded = await adminRequest(db, 'POST', '/users/71/grants', { plan_id: 'permanent', operation_id: crypto.randomUUID(), reason: '测试永久色' })
	assert.equal(upgraded.status, 200)
	const me = await upgraded.json() as SponsorMe
	assert.equal(me.sponsor.color_key, 'gold')
	assert.equal(me.sponsor.expires_at, null)
	assert.equal(me.quota.limit, 25)
	for (const color_key of ['blue', 'pink']) assert.equal((await userRequest(db, 71, 'PUT', '/color', { color_key }, token)).status, 422)
	assert.equal((await userRequest(db, 71, 'PUT', '/color', { color_key: 'gold' }, token)).status, 200)
	const config = await getSponsorConfig(db.env as never)
	config.colors = config.colors.map(color => color.permanent_only ? { ...color, key: 'permanent-new', light: '#765432' } : color)
	setConfig(db, config as unknown as Record<string, unknown>)
	assert.equal((await getSponsorMe(db.env as never, 71)).sponsor.color_key, 'permanent-new')
	// Replaying migration must not erase operator settings or membership/history.
	const before = await getSponsorMe(db.env as never, 71)
	db.database.exec(SPONSORS_SQL)
	assert.deepEqual(await getSponsorMe(db.env as never, 71), before)
	assert.equal((await getSponsorConfig(db.env as never)).colors[2].key, 'permanent-new')
	db.database.prepare('UPDATE sponsor_memberships SET permanent=0,expires_at=unixepoch()-1 WHERE user_id=71').run()
	const expired = await getSponsorMe(db.env as never, 71)
	assert.equal(expired.sponsor.active, false)
	assert.equal(expired.sponsor.color_key, null)
	assert.equal(expired.sponsor.color_light, null)
	assert.equal(expired.quota.limit, 3)
})

test('自然月续期精确截到闰年/平年月底，保留上海时分秒', async () => {
	for (const [start, expected] of [
		['2028-01-31T23:45:12+08:00', '2028-02-29T23:45:12+08:00'],
		['2029-01-31T23:45:12+08:00', '2029-02-28T23:45:12+08:00'],
		['2028-02-29T23:45:12+08:00', '2028-03-29T23:45:12+08:00'],
	]) {
		const db = createDb()
		await enableConfig(db)
		await bearer(db, 72)
		db.database.prepare('INSERT INTO sponsor_memberships(user_id,expires_at) VALUES(72,?)').run(Date.parse(start) / 1000)
		const grant = await adminRequest(db, 'POST', '/users/72/grants', { plan_id: 'month', operation_id: crypto.randomUUID(), reason: '月末续期' })
		assert.equal(grant.status, 200)
		assert.equal((await grant.json() as SponsorMe).sponsor.expires_at, Date.parse(expected) / 1000)
	}
})

test('配置拒绝缺少永久色/普通默认色、空原因和超长原因，通知额度变化必须升版本', async () => {
	const db = createDb()
	const config = await getSponsorConfig(db.env as never)
	for (const invalid of [
		{ ...config, colors: config.colors.filter(color => !color.permanent_only) },
		{ ...config, default_color_key: 'gold' },
		{ ...config, free_daily_limit: 4 },
	]) {
		assert.equal((await adminRequest(db, 'PUT', '/config', { config: invalid, expected_version: 1, reason: '校验' })).status, 422)
	}
	for (const reason of ['', 'x'.repeat(501)]) assert.equal((await adminRequest(db, 'PUT', '/config', { config, expected_version: 1, reason })).status, 422)
	assert.equal(db.database.prepare('SELECT COUNT(*) AS n FROM sponsor_audit').get()!.n, 0)
})

test('管理发码必须 UUID、同请求重放一次、列表保留方案快照、导出原因总长有界', async () => {
	const db = createDb({ codeKey: randomCodeKey() })
	await enableConfig(db)
	const payload = { plan_id: 'month', count: 1, reason: '发码校验' }
	for (const operation_id of [undefined, 42, 'invalid']) assert.equal((await adminRequest(db, 'POST', '/code-batches', { ...payload, operation_id })).status, 422)
	assert.equal(db.database.prepare('SELECT COUNT(*) AS n FROM sponsor_code_batches').get()!.n, 0)
	const request = { ...payload, operation_id: crypto.randomUUID() }
	const first = await adminRequest(db, 'POST', '/code-batches', request)
	assert.equal(first.status, 201)
	const batch = await first.json() as { id: string; count: number }
	assert.deepEqual(await (await adminRequest(db, 'POST', '/code-batches', request)).json(), batch)
	assert.equal((await adminRequest(db, 'POST', '/code-batches', { ...request, count: 2 })).status, 409)
	db.database.prepare("UPDATE sponsor_plans SET plan_json=json_set(plan_json,'$.name','改名后方案') WHERE id='month'").run()
	const list = await (await adminRequest(db, 'GET', '/codes')).json() as { items: { plan_name: string }[] }
	assert.equal(list.items[0].plan_name, '月赞助者')
	const exportPath = `/code-batches/${batch.id}/export`
	assert.equal((await adminRequest(db, 'POST', exportPath, { reason: 'x'.repeat(500) })).status, 422)
	const suffix = `（批次 ${batch.id}）`
	assert.equal((await adminRequest(db, 'POST', exportPath, { reason: 'x'.repeat(500 - suffix.length) })).status, 200)
	assert.equal(db.database.prepare("SELECT length(reason) AS n FROM sponsor_audit WHERE action='code_batch_export'").get()!.n, 500)
})

test('兑换码状态与审计原子提交、过期码启用仍显示 expired', async () => {
	const db = createDb({ codeKey: randomCodeKey() })
	await mintCode(db, 'week')
	const id = String(db.database.prepare('SELECT id FROM sponsor_codes').get()!.id)
	db.database.exec("CREATE TRIGGER test_audit_failure BEFORE INSERT ON sponsor_audit WHEN NEW.action='code_disable' BEGIN SELECT RAISE(ABORT,'test failure'); END;")
	assert.equal((await adminRequest(db, 'POST', `/codes/${id}/state`, { disabled: true, reason: '回滚验证' })).status, 503)
	assert.equal(db.database.prepare('SELECT disabled FROM sponsor_codes WHERE id=?').get(id)!.disabled, 0)
	assert.equal(db.database.prepare("SELECT COUNT(*) AS n FROM sponsor_audit WHERE action='code_disable'").get()!.n, 0)
	db.database.exec('DROP TRIGGER test_audit_failure;')
	assert.equal((await adminRequest(db, 'POST', `/codes/${id}/state`, { disabled: true, reason: '停用' })).status, 200)
	db.database.prepare('UPDATE sponsor_codes SET expires_at=unixepoch()-1 WHERE id=?').run(id)
	const enabled = await adminRequest(db, 'POST', `/codes/${id}/state`, { disabled: false, reason: '重新启用' })
	assert.equal(enabled.status, 200)
	assert.equal((await enabled.json() as { state: string }).state, 'expired')
	assert.equal(db.database.prepare("SELECT COUNT(*) AS n FROM sponsor_audit WHERE action IN ('code_disable','code_enable')").get()!.n, 2)
})

test('用户搜索按字面匹配百分号下划线反斜线并限制长度', async () => {
	const db = createDb()
	await bearer(db, 81)
	db.database.prepare('UPDATE users SET username=? WHERE id=81').run('literal%_\\name')
	for (const q of ['%', '_', '\\']) {
		const response = await adminRequest(db, 'GET', `/users?q=${encodeURIComponent(q)}`)
		assert.equal(response.status, 200)
		const body = await response.json() as { total: number; items: { id: number }[] }
		assert.equal(body.total, 1)
		assert.equal(body.items[0].id, 81)
	}
	assert.equal((await adminRequest(db, 'GET', `/users?q=${'a'.repeat(101)}`)).status, 422)
})

test('OAuth 限制读写、审计 scope、实时角色和授权用户；JWT cookie 保持可用', async () => {
	const db = createDb()
	await enableConfig(db)
	await bearer(db, 91)
	await bearer(db, 92, 'admin')
	const app = createApp()
	const token = crypto.randomUUID()
	db.database.prepare('INSERT INTO oauth_tokens(access_token,client_id,user_id,scopes,access_expires_at,created_at) VALUES(?,?,?,?,unixepoch()+3600,unixepoch())').run(token, 'test-client', 91, 'read')
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
	const original = { operation_id: crypto.randomUUID(), media_key: 'a'.repeat(64), notice_version: 1, user_id: 92 }
	const call = (path: string, method = 'GET', body?: unknown) => app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, db.env as never)
	assert.equal((await call('/api/v1/sponsors/me')).status, 200)
	const denied = await call('/api/v1/sponsors/original-authorizations', 'POST', original)
	assert.equal(denied.status, 403)
	assert.equal((await denied.json() as { code: string }).code, 'insufficient_scope')
	db.database.prepare("UPDATE oauth_tokens SET scopes='write' WHERE access_token=?").run(token)
	assert.equal((await call('/api/v1/sponsors/original-authorizations', 'POST', original)).status, 200)
	assert.equal((await getSponsorMe(db.env as never, 91)).quota.used, 1)
	assert.equal((await getSponsorMe(db.env as never, 92)).quota.used, 0)
	db.database.prepare('UPDATE oauth_tokens SET user_id=92 WHERE access_token=?').run(token)
	assert.equal((await call('/api/admin/sponsors/audit')).status, 403)
	db.database.prepare("UPDATE oauth_tokens SET scopes='read write' WHERE access_token=?").run(token)
	assert.equal((await call('/api/admin/sponsors/audit')).status, 200)
	db.database.prepare("UPDATE users SET role='user' WHERE id=92").run()
	assert.equal((await call('/api/admin/sponsors/audit')).status, 403)
	db.database.prepare('UPDATE oauth_tokens SET revoked=1 WHERE access_token=?').run(token)
	assert.equal((await call('/api/v1/sponsors/me')).status, 401)
	const jwt = await bearer(db, 93, 'admin')
	const cookieWrite = await app.request('/api/admin/sponsors/users/91/quota', { method: 'POST', headers: { Cookie: `token=${jwt.slice(7)}`, Origin: 'https://abdl-space.top', 'Content-Type': 'application/json' }, body: JSON.stringify({ adjustment: 1, operation_id: crypto.randomUUID(), reason: 'cookie 测试' }) }, db.env as never)
	assert.equal(cookieWrite.status, 200)
})

test('外观仅投影有限 Mastodon 帐号响应（无 roles 也支持），不污染 me 或超大/非法 JSON', async () => {
	const db = createDb()
	await enableConfig(db)
	await bearer(db, 94)
	assert.equal((await adminRequest(db, 'POST', '/users/94/grants', { plan_id: 'permanent', operation_id: crypto.randomUUID(), reason: '外观' })).status, 200)
	const account = { id: '94', acct: 'user94', username: 'user94', url: 'https://abdl-space.top/@user94', avatar: '' }
	const app = new Hono()
	app.use('*', sponsorAccountProjectionMiddleware)
	app.get('/api/v1/accounts/94', c => c.json(account))
	app.get('/api/v2/search', c => c.json({ accounts: [account], statuses: [{ account }] }))
	app.get('/api/v1/sponsors/me', c => c.json({ ...account, sponsor: { private: true } }))
	app.get('/api/v1/accounts/oversized', () => new Response(JSON.stringify({ ...account, note: 'x'.repeat(2 * 1024 * 1024) }), { headers: { 'Content-Type': 'application/json' } }))
	app.get('/api/v1/accounts/malformed', () => new Response('{', { headers: { 'Content-Type': 'application/json' } }))
	const projected = await (await app.request('/api/v1/accounts/94', {}, db.env as never)).json() as { sponsor: PublicSponsor }
	assert.deepEqual(Object.keys(projected.sponsor).sort(), ['active', 'color_dark', 'color_light', 'permanent', 'valid_until'])
	assert.equal(projected.sponsor.color_light, VALID_CONFIG.colors[2].light)
	assert.equal('roles' in projected, false)
	const search = await (await app.request('/api/v2/search', {}, db.env as never)).json() as { statuses: { account: { sponsor: PublicSponsor } }[] }
	assert.equal(search.statuses[0].account.sponsor.permanent, true)
	const untouched = await (await app.request('/api/v1/sponsors/me', {}, db.env as never)).json() as { sponsor: { private: boolean } }
	assert.deepEqual(untouched.sponsor, { private: true })
	const large = await app.request('/api/v1/accounts/oversized', {}, db.env as never)
	assert.equal('sponsor' in (await large.json() as Record<string, unknown>), false)
	assert.equal(await (await app.request('/api/v1/accounts/malformed', {}, db.env as never)).text(), '{')
})

test('限流清理只移除过期记录', async () => {
	const db = createDb()
	db.database.exec("INSERT INTO sponsor_rate_limits VALUES('old',unixepoch()-86401,1),('current',unixepoch(),1);")
	await cleanupSponsorRateLimits(db.env as never)
	assert.deepEqual(db.database.prepare('SELECT bucket FROM sponsor_rate_limits').all().map(row => row.bucket), ['current'])
})
