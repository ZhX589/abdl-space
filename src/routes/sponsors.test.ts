import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { Hono } from 'hono'

import { signJWT } from '../lib/auth.ts'
import { createSponsorCodeBatch, exportSponsorCodeBatch, getSponsorConfig, redeemSponsorCode } from '../lib/sponsors.ts'
import sponsorsRoutes from './sponsors.ts'
import adminSponsorsRoutes from './admin-sponsors.ts'
import adminSponsorStockRoutes from './admin-sponsor-stock.ts'

const jwtSecret = 'sponsor-routes-test-secret'

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
	db.database.prepare("INSERT OR REPLACE INTO users (id, username, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)")
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
	assert.equal(config.free_daily_limit, 10)
	assert.equal(config.sponsor_daily_limit, 100)
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
	const db = createDb({ codeKey: 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=' })
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
	const db = createDb({ codeKey: 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=' })
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

test('原图授权：普通用户须知、额度耗尽、重复 media_key 幂等', async () => {
	const db = createDb()
	const config = getConfigRow(db)
	config.enabled = true
	config.free_daily_limit = 2
	setConfig(db, config)
	const token = await bearer(db, 11)
	const first = await userRequest(db, 11, 'POST', '/original-authorizations', { operation_id: crypto.randomUUID(), media_key: 'a'.repeat(64) })
	assert.equal(first.status, 409)
	const notice = await first.json() as { code: string, notice_version: number }
	assert.equal(notice.code, 'notice_required')

	const withNotice = await userRequest(db, 11, 'POST', '/original-authorizations', { operation_id: crypto.randomUUID(), media_key: 'a'.repeat(64), notice_version: notice.notice_version }, token)
	assert.equal(withNotice.status, 200)

	const replay = await userRequest(db, 11, 'POST', '/original-authorizations', { operation_id: crypto.randomUUID(), media_key: 'a'.repeat(64) }, token)
	assert.equal(replay.status, 200)

	const exhausted1 = await userRequest(db, 11, 'POST', '/original-authorizations', { operation_id: crypto.randomUUID(), media_key: 'b'.repeat(64) }, token)
	assert.equal(exhausted1.status, 402)
	const exhausted2 = await userRequest(db, 11, 'POST', '/original-authorizations', { operation_id: crypto.randomUUID(), media_key: 'c'.repeat(64) }, token)
	assert.equal(exhausted2.status, 402)
	const body = await exhausted2.json() as { code: string }
	assert.equal(body.code, 'quota_exhausted')
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
	const db = createDb({ codeKey: 'Q0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0M=' })
	await enableConfig(db)
	const raw1 = await mintCode(db, 'month')
	const raw2 = await mintCode(db, 'month')
	const app = createApp()
	const token = await bearer(db, 31)
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
	assert.ok(membership.expires_at > Math.floor(Date.now() / 1000))
})

test('管理：兑换码列表只返回脱敏码，状态枚举正确', async () => {
	const db = createDb({ codeKey: 'REREREREREREREREREREREREREREREREREREREREREQ=' })
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
	const db = createDb({ codeKey: 'RUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUU=' })
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
	const db = createDb({ codeKey: 'RkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkY=' })
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
