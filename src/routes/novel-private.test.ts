import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { Hono } from 'hono'

import { signJWT } from '../lib/auth.ts'
import novelPrivate, { cleanupPrivateNovelObjects, MAX_PRIVATE_BOOK_SIZE, PRIVATE_BOOK_INSERT_SQL } from './novel-private.ts'

const jwtSecret = 'test-jwt-secret'
const env = {
	JWT_SECRET: jwtSecret,
	COS_SECRET_ID: 'PUBLIC-KEY-MUST-NOT-BE-USED',
	COS_SECRET_KEY: 'public-secret-must-not-be-used',
	COS_BUCKET: 'public-books-123',
	COS_REGION: 'ap-shanghai',
	COS_PUBLIC_ORIGIN: 'https://public.example.test',
	NOVEL_COS_SECRET_ID: 'AKIDEXAMPLEFAKE',
	NOVEL_COS_SECRET_KEY: 'fake-secret-key-for-tests-only',
	NOVEL_PRIVATE_COS_BUCKET: 'private-books-123',
	NOVEL_PRIVATE_COS_REGION: 'ap-shanghai',
}

const EMPTY_123_SHA256 = '409a7f83ac6b31dc8c77e3ec18038f209bd2f545e0f4177c2e2381aa4e067b49'

interface BookRow {
	id: string
	owner_id: number
	title: string
	author: string
	format: 'txt' | 'epub'
	object_key: string
	content_hash: string
	content_md5: string
	declared_size: number
	verified_size: number | null
	parse_status: 'pending' | 'parsing' | 'ready' | 'failed'
	upload_expires_at: number
	verification_started_at: number | null
	cleanup_status: 'pending' | 'deleting' | 'monitoring' | 'failed'
	cleanup_attempted_at: number | null
	deleted_at: number | null
}

interface OAuthToken {
	accessToken: string
	userId: number
	scopes: string
}

function bookRow(overrides: Partial<BookRow> = {}): BookRow {
	const id = overrides.id ?? crypto.randomUUID()
	return {
		id,
		owner_id: 42,
		title: 'Private book',
		author: 'Author',
		format: 'epub',
		object_key: `novels/private/42/${id}.epub`,
		content_hash: EMPTY_123_SHA256,
		content_md5: 'kAFQmDzST7DWlj99KOF/cg==',
		declared_size: 123,
		verified_size: null,
		parse_status: 'pending',
		upload_expires_at: Math.floor(Date.now() / 1000) + 300,
		verification_started_at: null,
		cleanup_status: 'pending',
		cleanup_attempted_at: null,
		deleted_at: null,
		...overrides,
	}
}

function validHeadHeaders(row: BookRow, overrides: Record<string, string> = {}): Record<string, string> {
	return {
		'Content-Length': String(row.declared_size),
		'Content-Type': row.format === 'txt' ? 'text/plain' : 'application/epub+zip',
		'x-cos-meta-sha256': row.content_hash,
		...overrides,
	}
}

function validGetResponse(row: BookRow, overrides: { body?: Uint8Array, headers?: Record<string, string>, status?: number } = {}): Response {
	const body = overrides.body ?? new Uint8Array(row.declared_size)
	return new Response(body, {
		status: overrides.status ?? 200,
		headers: { 'Content-Length': String(body.byteLength), ...overrides.headers },
	})
}

function verifiedObjectFetch(row: BookRow, headOverrides: Record<string, string> = {}) {
	return async (_input: string | URL | Request, init?: RequestInit) => {
		if (init?.method === 'HEAD') return new Response(null, { status: 200, headers: validHeadHeaders(row, headOverrides) })
		if (init?.method === 'GET') return validGetResponse(row)
		throw new Error(`Unexpected COS method: ${init?.method}`)
	}
}

function createDb(initialRows: BookRow[] = [], options: {
	oauthTokens?: OAuthToken[]
	passwordChangedAt?: Record<number, string | null>
	failRun?: (sql: string, call: number) => boolean
	beforeRun?: (sql: string, params: unknown[], rows: Map<string, BookRow>) => void
} = {}) {
	const rows = new Map(initialRows.map(row => [`${row.owner_id}:${row.id}`, { ...row }]))
	const oauthTokens = new Map((options.oauthTokens ?? []).map(token => [token.accessToken, token]))
	const passwordChangedAt = new Map(Object.entries(options.passwordChangedAt ?? {}).map(([id, value]) => [Number(id), value]))
	let runCalls = 0

	return {
		rows,
		prepare(sql: string) {
			return {
				bind(...params: unknown[]) {
					return {
						async all() {
							if (sql.includes('FROM oauth_tokens')) {
								const token = oauthTokens.get(String(params[0]))
								return { success: true, results: token ? [{ client_id: 'novel-client', user_id: token.userId, scopes: token.scopes, access_expires_at: Math.floor(Date.now() / 1000) + 300, revoked: 0 }] : [] }
							}
							if (sql.includes('SELECT password_changed_at FROM users')) {
								const id = Number(params[0])
								return { success: true, results: [{ password_changed_at: passwordChangedAt.get(id) ?? null }] }
							}
							if (sql.includes('FROM users')) {
								const id = Number(params[0])
								return { success: true, results: [{ id, username: `user${id}`, email: `user${id}@example.test`, role: 'user' }] }
							}
							if (sql.includes('COUNT(*) AS book_count')) {
								const ownerId = Number(params[0])
								const active = [...rows.values()].filter(row => row.owner_id === ownerId && row.deleted_at === null)
								return { success: true, results: [{ book_count: active.length, total_size: active.reduce((sum, row) => sum + row.declared_size, 0) }] }
							}
							if (sql.includes('cleanup_status IN') && sql.includes('upload_expires_at <= ?')) {
								const [now, , , staleCleanupBefore, limit] = params.map(Number)
								return {
									success: true,
									results: [...rows.values()]
										.filter(row => (row.deleted_at === null && row.parse_status === 'pending' && row.upload_expires_at <= now)
											|| (row.deleted_at !== null && ['failed', 'pending'].includes(row.cleanup_status))
											|| (row.deleted_at !== null && row.cleanup_status === 'deleting'
												&& (row.cleanup_attempted_at === null || row.cleanup_attempted_at <= staleCleanupBefore)))
										.slice(0, limit)
										.map(row => ({ ...row })),
								}
							}
							if (sql.includes('content_hash = ?') && sql.includes('deleted_at IS NULL')) {
								const ownerId = Number(params[0])
								const hash = String(params[1])
								const row = [...rows.values()].find(value => value.owner_id === ownerId && value.content_hash === hash && value.deleted_at === null)
								return { success: true, results: row ? [{ ...row }] : [] }
							}
							if (sql.includes('FROM private_books')) {
								const id = String(params[0])
								const ownerId = Number(params[1])
								const row = rows.get(`${ownerId}:${id}`)
								return { success: true, results: row ? [{ ...row }] : [] }
							}
							return { success: true, results: [] }
						},
						async run() {
							runCalls++
							options.beforeRun?.(sql, params, rows)
							if (options.failRun?.(sql, runCalls)) return { success: false, meta: { changes: 0 } }
							if (sql.includes('INSERT INTO private_books')) {
								const [id, ownerId, title, author, format, objectKey, contentHash, contentMd5, declaredSize, uploadExpiresAt] = params
								const active = [...rows.values()].filter(row => row.owner_id === Number(ownerId) && row.deleted_at === null)
								if (active.length >= 500 || active.reduce((sum, row) => sum + row.declared_size, 0) + Number(declaredSize) > 2 * 1024 * 1024 * 1024
									|| active.some(row => row.content_hash === String(contentHash))) return { success: true, meta: { changes: 0 } }
								rows.set(`${ownerId}:${id}`, {
									id: String(id), owner_id: Number(ownerId), title: String(title), author: String(author),
									format: String(format) as BookRow['format'], object_key: String(objectKey), content_hash: String(contentHash),
									content_md5: String(contentMd5),
									declared_size: Number(declaredSize), verified_size: null, parse_status: 'pending',
									upload_expires_at: Number(uploadExpiresAt), deleted_at: null,
									verification_started_at: null,
									cleanup_status: 'pending', cleanup_attempted_at: null,
								})
								return { success: true, meta: { changes: 1 } }
							}
							if (sql.includes('SET upload_expires_at = ?')) {
								const [expiresAt, id, ownerId, previousExpiresAt] = params
								const row = rows.get(`${ownerId}:${id}`)
								if (!row || row.deleted_at !== null || row.parse_status !== 'pending'
									|| (previousExpiresAt !== undefined && row.upload_expires_at !== Number(previousExpiresAt))) return { success: true, meta: { changes: 0 } }
								row.upload_expires_at = Number(expiresAt)
								return { success: true, meta: { changes: 1 } }
							}
							if (sql.includes("SET parse_status = 'parsing'")) {
								const [verificationStartedAt, id, ownerId, expectedStatus, expectedToken, , staleBefore] = params
								const row = rows.get(`${ownerId}:${id}`)
								if (!row || row.deleted_at !== null || row.parse_status !== expectedStatus
									|| (expectedStatus === 'pending' && row.upload_expires_at !== Number(expectedToken))
									|| (expectedStatus === 'parsing' && (row.verification_started_at !== Number(expectedToken) || Number(expectedToken) > Number(staleBefore)))) return { success: true, meta: { changes: 0 } }
								row.parse_status = 'parsing'
								row.verification_started_at = Number(verificationStartedAt)
								return { success: true, meta: { changes: 1 } }
							}
							if (sql.includes("SET parse_status = 'pending'")) {
								const [id, ownerId, verificationStartedAt] = params
								const row = rows.get(`${ownerId}:${id}`)
								if (!row || row.parse_status !== 'parsing' || row.verification_started_at !== Number(verificationStartedAt)) return { success: true, meta: { changes: 0 } }
								row.parse_status = 'pending'
								row.verification_started_at = null
								return { success: true, meta: { changes: 1 } }
							}
							if (sql.includes("parse_status = 'failed'") && sql.includes('deleted_at = unixepoch()')) {
								const [cleanupToken, id, ownerId, verificationStartedAt] = params
								const row = rows.get(`${ownerId}:${id}`)
								if (!row || row.deleted_at !== null || row.parse_status !== 'parsing' || row.verification_started_at !== Number(verificationStartedAt)) return { success: true, meta: { changes: 0 } }
								row.parse_status = 'failed'
								row.deleted_at = Math.floor(Date.now() / 1000)
								row.verification_started_at = null
								row.cleanup_status = 'deleting'
								row.cleanup_attempted_at = Number(cleanupToken)
								return { success: true, meta: { changes: 1 } }
							}
							if (sql.includes("SET parse_status = 'failed', deleted_at = ?") && sql.includes("cleanup_status = 'deleting'")) {
								const [deletedAt, cleanupToken, id, ownerId, uploadExpiresAt] = params
								const row = rows.get(`${ownerId}:${id}`)
								if (!row || row.deleted_at !== null || row.parse_status !== 'pending' || row.upload_expires_at !== Number(uploadExpiresAt) || row.upload_expires_at > Number(deletedAt)) return { success: true, meta: { changes: 0 } }
								row.parse_status = 'failed'
								row.deleted_at = Number(deletedAt)
								row.cleanup_status = 'deleting'
								row.cleanup_attempted_at = Number(cleanupToken)
								return { success: true, meta: { changes: 1 } }
							}
							if (sql.includes("SET cleanup_status = 'deleting'") && sql.includes('cleanup_attempted_at = ?')) {
								const [cleanupToken, id, ownerId, expectedStatus, expectedToken] = params
								const row = rows.get(`${ownerId}:${id}`)
								if (!row || row.deleted_at === null || row.cleanup_status !== expectedStatus || row.cleanup_attempted_at !== expectedToken) return { success: true, meta: { changes: 0 } }
								row.cleanup_status = 'deleting'
								row.cleanup_attempted_at = Number(cleanupToken)
								return { success: true, meta: { changes: 1 } }
							}
							if (sql.includes('SET cleanup_status = ?')) {
								const [cleanupStatus, id, ownerId, cleanupToken] = params
								const row = rows.get(`${ownerId}:${id}`)
								if (!row || row.deleted_at === null || row.cleanup_status !== 'deleting'
									|| (cleanupToken !== undefined && row.cleanup_attempted_at !== Number(cleanupToken))) return { success: true, meta: { changes: 0 } }
								row.cleanup_status = String(cleanupStatus) as BookRow['cleanup_status']
								return { success: true, meta: { changes: 1 } }
							}
							if (sql.includes('SET verified_size = ?') && sql.includes("parse_status = 'ready'")) {
								const [verifiedSize, id, ownerId, verificationStartedAt] = params
								const row = rows.get(`${ownerId}:${id}`)
								if (!row || row.parse_status !== 'parsing' || row.verification_started_at !== Number(verificationStartedAt) || row.deleted_at !== null) return { success: true, meta: { changes: 0 } }
								row.verified_size = Number(verifiedSize)
								row.parse_status = 'ready'
								row.verification_started_at = null
								return { success: true, meta: { changes: 1 } }
							}
							return { success: true, meta: { changes: 0 } }
						},
					}
				},
			}
		},
	}
}

function createApp() {
	const app = new Hono()
	app.route('/api/v1/novels/private', novelPrivate)
	return app
}

async function bearer(sub = 42): Promise<string> {
	return `Bearer ${await signJWT({ sub, username: `user${sub}`, email: `user${sub}@example.test`, role: 'user' }, jwtSecret)}`
}

async function request(path: string, options: { body?: unknown, sub?: number, authenticated?: boolean, authorization?: string, db?: ReturnType<typeof createDb>, env?: Record<string, unknown> } = {}) {
	const db = options.db ?? createDb()
	const headers: Record<string, string> = { 'Content-Type': 'application/json' }
	if (options.authenticated !== false) headers.Authorization = options.authorization ?? await bearer(options.sub)
	const response = await createApp().request(`/api/v1/novels/private${path}`, {
		method: 'POST',
		headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	}, { ...env, ...options.env, abdl_space_db: db } as never)
	return { response, db }
}

function createSqliteD1() {
	const database = new DatabaseSync(':memory:')
	database.exec('PRAGMA foreign_keys = ON;')
	database.exec(readFileSync(new URL('../../schemas/schema.sql', import.meta.url), 'utf8'))
	database.exec(readFileSync(new URL('../../migrations/oauth.sql', import.meta.url), 'utf8'))
	database.prepare(`INSERT INTO users (id, email, password_hash, username) VALUES
		(42, 'user42@example.test', 'hash', 'user42'),
		(7, 'user7@example.test', 'hash', 'user7')`).run()

	const prepare = (sql: string) => ({
		bind: (...params: unknown[]) => ({
			async all() {
				const results = database.prepare(sql).all(...params)
				return { success: true, results }
			},
			async first() {
				return database.prepare(sql).get(...params) ?? null
			},
			async run() {
				const result = database.prepare(sql).run(...params)
				return { success: true, meta: { changes: Number(result.changes) } }
			},
		}),
	})

	return { database, prepare }
}

async function phase2Request(db: ReturnType<typeof createSqliteD1>, method: string, path: string, options: {
	body?: unknown
	sub?: number
	authorization?: string
	headers?: Record<string, string>
} = {}) {
	const headers: Record<string, string> = { Authorization: options.authorization ?? await bearer(options.sub), ...options.headers }
	if (options.body !== undefined) headers['Content-Type'] = 'application/json'
	return createApp().request(`/api/v1/novels/private${path}`, {
		method,
		headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	}, { ...env, abdl_space_db: db } as never)
}

function insertReadyBook(db: ReturnType<typeof createSqliteD1>, overrides: Partial<BookRow & { created_at: number, updated_at: number }> = {}) {
	const row = bookRow({ parse_status: 'ready', verified_size: 123, ...overrides })
	db.database.prepare(`
		INSERT INTO private_books (
			id, owner_id, title, author, format, object_key, content_hash, declared_size,
			content_md5, verified_size, parse_status, upload_expires_at, verification_started_at, cleanup_status, created_at, updated_at, deleted_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(row.id, row.owner_id, row.title, row.author, row.format, row.object_key, row.content_hash,
		row.declared_size, row.content_md5, row.verified_size, row.parse_status, row.upload_expires_at, row.verification_started_at, row.cleanup_status,
		overrides.created_at ?? 100, overrides.updated_at ?? 100, row.deleted_at)
	return row
}

const validAuthorize = {
	title: 'My private book',
	author: 'Writer',
	mime_type: 'application/epub+zip',
	declared_size: 123,
	content_hash: 'b'.repeat(64),
	content_md5: 'kAFQmDzST7DWlj99KOF/cg==',
}

test('all private novel protocol endpoints require authentication', async () => {
	for (const [path, body] of [['/authorize', validAuthorize], ['/missing/complete', undefined], ['/missing/download/authorize', undefined]] as const) {
		const { response } = await request(path, { body, authenticated: false })
		assert.equal(response.status, 401, path)
	}
})

test('OAuth authorize and complete require write while download requires read', async () => {
	for (const [path, scopes, expected] of [
		['/authorize', 'read', 403], ['/authorize', 'write', 200],
		['/book/complete', 'read', 403], ['/book/complete', 'write', 200],
		['/book/download/authorize', 'write', 403], ['/book/download/authorize', 'read', 200],
	] as const) {
		const ready = path.includes('download') || (path.includes('complete') && scopes === 'write')
		const row = bookRow({ id: 'book', parse_status: ready ? 'ready' : 'pending', verified_size: ready ? 123 : null })
		const db = createDb([row], { oauthTokens: [{ accessToken: 'oauth', userId: 42, scopes }] })
		const { response } = await request(path, { body: path === '/authorize' ? validAuthorize : undefined, db, authorization: 'Bearer oauth' })
		assert.equal(response.status, expected, `${path} ${scopes}`)
	}
})

test('JWT authentication rejects tokens issued before password_changed_at', async () => {
	const token = await bearer()
	const db = createDb([], { passwordChangedAt: { 42: new Date(Date.now() + 60_000).toISOString() } })
	const { response } = await request('/authorize', { body: validAuthorize, db, authorization: token })
	assert.equal(response.status, 401)
})

test('private COS configuration fails closed and never falls back to public credentials or bucket', async () => {
	for (const override of [
		{ NOVEL_COS_SECRET_ID: '' }, { NOVEL_COS_SECRET_KEY: '' }, { NOVEL_PRIVATE_COS_BUCKET: '' },
		{ NOVEL_PRIVATE_COS_REGION: '' }, { NOVEL_PRIVATE_COS_BUCKET: env.COS_BUCKET },
		{ NOVEL_COS_SECRET_ID: env.COS_SECRET_ID }, { NOVEL_COS_SECRET_KEY: env.COS_SECRET_KEY },
	]) {
		const { response } = await request('/authorize', { body: validAuthorize, env: override })
		assert.equal(response.status, 503, JSON.stringify(override))
	}
})

test('authorize validates format and size and creates a pending upload with expiry', async () => {
	for (const body of [
		{ ...validAuthorize, mime_type: 'application/pdf' }, { ...validAuthorize, declared_size: 0 },
		{ ...validAuthorize, declared_size: 0, content_md5: '1B2M2Y8AsgTpgAmY7PhCfg==' },
		{ ...validAuthorize, declared_size: MAX_PRIVATE_BOOK_SIZE + 1 }, { ...validAuthorize, object_key: 'client/chosen.epub' },
	]) {
		const { response } = await request('/authorize', { body })
		assert.equal(response.status, 400, JSON.stringify(body))
	}
	const { response, db } = await request('/authorize', { body: validAuthorize })
	assert.equal(response.status, 200, await response.clone().text())
	const result = await response.json() as Record<string, unknown>
	const row = db.rows.get(`42:${result.upload_id}`)
	assert.equal(row?.parse_status, 'pending')
	assert.equal(row?.upload_expires_at, result.expires_at)
	assert.match((result.required_headers as Record<string, string>).Authorization, /q-ak=AKIDEXAMPLEFAKE(?:&|$)/)
	assert.doesNotMatch((result.required_headers as Record<string, string>).Authorization, /PUBLIC-KEY-MUST-NOT-BE-USED/)
	assert.equal((result.required_headers as Record<string, string>)['x-cos-meta-sha256'], validAuthorize.content_hash)
	assert.equal((result.required_headers as Record<string, string>)['Content-Length'], String(validAuthorize.declared_size))
	assert.equal((result.required_headers as Record<string, string>)['Content-MD5'], validAuthorize.content_md5)
	assert.match((result.required_headers as Record<string, string>).Authorization, /q-header-list=content-length;content-md5;content-type;host;x-cos-forbid-overwrite;x-cos-meta-sha256(?:&|$)/)
})

test('authorize strictly validates standard Base64 MD5 and treats it as idempotency metadata', async () => {
	for (const content_md5 of ['', 'not-base64', 'kAFQmDzST7DWlj99KOF/cg', 'kAFQmDzST7DWlj99KOF/cg===', 'kAFQmDzST7DWlj99KOF/ch==']) {
		assert.equal((await request('/authorize', { body: { ...validAuthorize, content_md5 } })).response.status, 400)
	}
	const existing = bookRow({ title: validAuthorize.title, author: validAuthorize.author, content_hash: validAuthorize.content_hash, content_md5: 'AAAAAAAAAAAAAAAAAAAAAA==' })
	assert.equal((await request('/authorize', { body: validAuthorize, db: createDb([existing]) })).response.status, 409)
	const ready = bookRow({ title: validAuthorize.title, author: validAuthorize.author, content_hash: validAuthorize.content_hash, content_md5: 'AAAAAAAAAAAAAAAAAAAAAA==', parse_status: 'ready', verified_size: 123 })
	assert.equal((await request('/authorize', { body: validAuthorize, db: createDb([ready]) })).response.status, 409)
})

test('authorize returns ready hash idempotently without PUT authorization', async () => {
	const row = bookRow({ id: 'ready-book', title: validAuthorize.title, author: validAuthorize.author, content_hash: validAuthorize.content_hash, parse_status: 'ready', verified_size: 123 })
	const { response, db } = await request('/authorize', { body: validAuthorize, db: createDb([row]) })
	assert.equal(response.status, 200, await response.clone().text())
	assert.deepEqual(await response.json(), { upload_id: row.id, already_uploaded: true, parse_status: 'ready' })
	assert.equal(db.rows.get(`42:${row.id}`)?.upload_expires_at, row.upload_expires_at)
})

test('authorize re-signs only an exactly matching pending hash and rejects metadata conflicts', async () => {
	const matching = bookRow({ id: 'pending-book', title: validAuthorize.title, author: validAuthorize.author, content_hash: validAuthorize.content_hash, upload_expires_at: 1 })
	const { response, db } = await request('/authorize', { body: validAuthorize, db: createDb([matching]) })
	assert.equal(response.status, 200, await response.clone().text())
	const result = await response.json() as Record<string, unknown>
	assert.equal(result.upload_id, matching.id)
	assert.equal(result.upload_url, `https://${env.NOVEL_PRIVATE_COS_BUCKET}.cos.${env.NOVEL_PRIVATE_COS_REGION}.myqcloud.com/${matching.object_key}`)
	assert.equal(db.rows.get(`42:${matching.id}`)?.upload_expires_at, result.expires_at)

	for (const override of [
		{ title: 'Other title' }, { author: 'Other author' }, { declared_size: 124 },
		{ mime_type: 'text/plain' },
	]) {
		const conflict = bookRow({ title: validAuthorize.title, author: validAuthorize.author, content_hash: validAuthorize.content_hash })
		assert.equal((await request('/authorize', { body: { ...validAuthorize, ...override }, db: createDb([conflict]) })).response.status, 409)
	}
})

test('authorize renewal uses the previous expiry as a lease token', async () => {
	const row = bookRow({ id: 'renewed-book', title: validAuthorize.title, author: validAuthorize.author, content_hash: validAuthorize.content_hash, upload_expires_at: 1 })
	const renewedExpiry = Math.floor(Date.now() / 1000) + 600
	let raced = false
	const db = createDb([row], { beforeRun(sql, _params, rows) {
		if (!raced && sql.includes('SET upload_expires_at = ?')) {
			raced = true
			rows.get(`42:${row.id}`)!.upload_expires_at = renewedExpiry
		}
	} })
	const { response } = await request('/authorize', { body: validAuthorize, db })
	assert.equal(response.status, 409)
	assert.equal(db.rows.get(`42:${row.id}`)?.upload_expires_at, renewedExpiry)
})

test('authorize enforces 500 active books and 2 GiB declared-size quotas', async () => {
	const fiveHundred = Array.from({ length: 500 }, (_, index) => bookRow({ id: `book-${index}`, content_hash: index.toString(16).padStart(64, '0'), declared_size: 1 }))
	assert.equal((await request('/authorize', { body: validAuthorize, db: createDb(fiveHundred) })).response.status, 429)
	const nearLimit = bookRow({ declared_size: 2 * 1024 * 1024 * 1024 - 100 })
	assert.equal((await request('/authorize', { body: validAuthorize, db: createDb([nearLimit]) })).response.status, 429)
})

test('concurrent authorize calls for the same hash converge without a server error', async () => {
	const db = createDb()
	const [first, second] = await Promise.all([
		request('/authorize', { body: validAuthorize, db }),
		request('/authorize', { body: validAuthorize, db }),
	])
	assert.equal(first.response.status, 200, await first.response.clone().text())
	assert.equal(second.response.status, 200, await second.response.clone().text())
	const firstBody = await first.response.json() as { upload_id: string }
	const secondBody = await second.response.json() as { upload_id: string }
	assert.equal(firstBody.upload_id, secondBody.upload_id)
	assert.equal(db.rows.size, 1)
})

test('conditional INSERT gives one winner for the same hash in real SQLite', () => {
	const database = new DatabaseSync(':memory:')
	try {
		database.exec(`
			CREATE TABLE novel_object_cleanup_jobs (object_key TEXT PRIMARY KEY NOT NULL);
			CREATE TABLE private_books (
				id TEXT NOT NULL, owner_id INTEGER NOT NULL, title TEXT NOT NULL, author TEXT NOT NULL,
				format TEXT NOT NULL, object_key TEXT NOT NULL, content_hash TEXT NOT NULL,
				content_md5 TEXT NOT NULL,
				declared_size INTEGER NOT NULL, verified_size INTEGER, parse_status TEXT NOT NULL,
				upload_expires_at INTEGER NOT NULL, verification_started_at INTEGER, deleted_at INTEGER,
				PRIMARY KEY (owner_id, id)
			);
			CREATE UNIQUE INDEX active_hash ON private_books(owner_id, content_hash) WHERE deleted_at IS NULL;
		`)
		const statement = database.prepare(PRIVATE_BOOK_INSERT_SQL)
		const bind = (id: string, key: string) => [id, 42, validAuthorize.title, validAuthorize.author, 'epub', key, validAuthorize.content_hash, validAuthorize.content_md5, validAuthorize.declared_size, 12345]
		assert.equal(statement.run(...bind('first', 'first.epub')).changes, 1)
		assert.equal(statement.run(...bind('second', 'second.epub')).changes, 0)
		assert.equal(database.prepare('SELECT COUNT(*) AS count FROM private_books').get()?.count, 1)
	} finally {
		database.close()
	}
})

test('complete atomically claims pending before COS verification and concurrent callers do not duplicate reads', async () => {
	const row = bookRow()
	const db = createDb([row])
	const originalFetch = globalThis.fetch
	let releaseHead!: () => void
	const headGate = new Promise<void>(resolve => { releaseHead = resolve })
	const methods: string[] = []
	globalThis.fetch = async (_input, init) => {
		methods.push(String(init?.method))
		if (init?.method === 'HEAD') {
			await headGate
			return new Response(null, { status: 200, headers: validHeadHeaders(row) })
		}
		if (init?.method === 'GET') return validGetResponse(row)
		throw new Error(`Unexpected COS method: ${init?.method}`)
	}
	try {
		const first = request(`/${row.id}/complete`, { db })
		while (db.rows.get(`42:${row.id}`)?.parse_status !== 'parsing') await new Promise(resolve => setTimeout(resolve, 0))
		while (methods.length !== 1) await new Promise(resolve => setTimeout(resolve, 0))
		const second = await request(`/${row.id}/complete`, { db })
		assert.equal(second.response.status, 202)
		assert.deepEqual(methods, ['HEAD'])
		releaseHead()
		assert.equal((await first).response.status, 200)
		assert.deepEqual(methods, ['HEAD', 'GET'])
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('complete returns 202 for a live parsing lease and reclaims one older than five minutes', async () => {
	const now = Date.now() * 1000
	const live = bookRow({ parse_status: 'parsing', verification_started_at: now - 299_000_000 })
	let calls = 0
	const originalFetch = globalThis.fetch
	globalThis.fetch = async (input, init) => { calls++; return verifiedObjectFetch(live)(input, init) }
	try {
		assert.equal((await request(`/${live.id}/complete`, { db: createDb([live]) })).response.status, 202)
		assert.equal(calls, 0)
		const stale = bookRow({ parse_status: 'parsing', verification_started_at: now - 301_000_000 })
		const { response, db } = await request(`/${stale.id}/complete`, { db: createDb([stale]) })
		assert.equal(response.status, 200, await response.clone().text())
		assert.equal(calls, 2)
		assert.equal(db.rows.get(`42:${stale.id}`)?.parse_status, 'ready')
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('complete expires uploads before HEAD, enqueues cleanup at expiry, and permits reauthorization', async () => {
	const expired = bookRow({ content_hash: validAuthorize.content_hash, upload_expires_at: Math.floor(Date.now() / 1000) - 1 })
	let calls = 0
	const originalFetch = globalThis.fetch
	globalThis.fetch = async (_input, init) => {
		calls++
		assert.equal(init?.method, 'DELETE')
		return new Response(null, { status: 204 })
	}
	try {
		const { response, db } = await request(`/${expired.id}/complete`, { db: createDb([expired]) })
		assert.equal(response.status, 410)
		assert.equal(calls, 0)
		assert.equal(db.rows.get(`42:${expired.id}`)?.parse_status, 'failed')
		assert.notEqual(db.rows.get(`42:${expired.id}`)?.deleted_at, null)
		assert.equal(db.rows.get(`42:${expired.id}`)?.cleanup_status, 'deleting')
		const reauthorized = await request('/authorize', { body: validAuthorize, db })
		assert.equal(reauthorized.response.status, 200)
		assert.notEqual((await reauthorized.response.json() as { upload_id: string }).upload_id, expired.id)
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('expired complete cannot delete an upload concurrently renewed by authorize', async () => {
	const expired = bookRow({ upload_expires_at: Math.floor(Date.now() / 1000) - 1 })
	const renewedExpiry = Math.floor(Date.now() / 1000) + 300
	let raced = false
	const db = createDb([expired], { beforeRun(sql, _params, rows) {
		if (!raced && sql.includes("SET parse_status = 'parsing'")) {
			raced = true
			rows.get(`42:${expired.id}`)!.upload_expires_at = renewedExpiry
		}
	} })
	let calls = 0
	const originalFetch = globalThis.fetch
	globalThis.fetch = async () => { calls++; throw new Error('must not delete') }
	try {
		const { response } = await request(`/${expired.id}/complete`, { db })
		assert.equal(response.status, 409)
		assert.equal(calls, 0)
		assert.equal(db.rows.get(`42:${expired.id}`)?.parse_status, 'pending')
		assert.equal(db.rows.get(`42:${expired.id}`)?.deleted_at, null)
		assert.equal(db.rows.get(`42:${expired.id}`)?.upload_expires_at, renewedExpiry)
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('complete returns ready without HEAD, restores missing objects, and rejects bad metadata permanently', async () => {
	const ready = bookRow({ parse_status: 'ready', verified_size: 123 })
	let calls = 0
	const originalFetch = globalThis.fetch
	globalThis.fetch = async () => { calls++; throw new Error('must not run') }
	try {
		assert.equal((await request(`/${ready.id}/complete`, { db: createDb([ready]) })).response.status, 200)
		assert.equal(calls, 0)
	} finally {
		globalThis.fetch = originalFetch
	}

	for (const [outcome, expectedStatus] of [
		[new Response(null, { status: 404 }), 'pending'],
		[new Response(null, { status: 200, headers: validHeadHeaders(bookRow(), { 'Content-Type': 'application/epub+zip; charset=utf-8' }) }), 'failed'],
	] as const) {
		const row = bookRow()
		const db = createDb([row])
		globalThis.fetch = async (_input, init) => {
			if (init?.method === 'HEAD') return outcome
			if (init?.method === 'GET') return validGetResponse(row)
			return new Response(null, { status: 204 })
		}
		try {
			assert.equal((await request(`/${row.id}/complete`, { db })).response.status, 422)
			assert.equal(db.rows.get(`42:${row.id}`)?.parse_status, expectedStatus)
		} finally {
			globalThis.fetch = originalFetch
		}
	}
})

test('complete soft-deletes a record when an existing object has the wrong metadata and a retry gets a new key', async () => {
	const row = bookRow({ title: validAuthorize.title, author: validAuthorize.author, content_hash: validAuthorize.content_hash })
	const db = createDb([row])
	const originalFetch = globalThis.fetch
	globalThis.fetch = async () => new Response(null, { status: 200, headers: { 'Content-Length': '124', 'Content-Type': 'application/epub+zip' } })
	try {
		assert.equal((await request(`/${row.id}/complete`, { db })).response.status, 422)
		assert.equal(db.rows.get(`42:${row.id}`)?.parse_status, 'failed')
		assert.notEqual(db.rows.get(`42:${row.id}`)?.deleted_at, null)
		const response = (await request('/authorize', { body: validAuthorize, db })).response
		assert.equal(response.status, 200)
		const replacement = await response.json() as { upload_id: string, upload_url: string }
		assert.notEqual(replacement.upload_id, row.id)
		assert.notEqual(replacement.upload_url, `https://${env.NOVEL_PRIVATE_COS_BUCKET}.cos.${env.NOVEL_PRIVATE_COS_REGION}.myqcloud.com/${row.object_key}`)
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('an old verification lease cannot soft-delete a newer ready result', async () => {
	const row = bookRow()
	const db = createDb([row])
	const originalFetch = globalThis.fetch
	globalThis.fetch = async (_input, init) => {
		assert.equal(init?.method, 'HEAD')
		const current = db.rows.get(`42:${row.id}`)!
		current.parse_status = 'ready'
		current.verified_size = 123
		current.verification_started_at = null
		return new Response(null, { status: 200, headers: validHeadHeaders(row, { 'Content-Length': '124' }) })
	}
	try {
		const { response } = await request(`/${row.id}/complete`, { db })
		assert.equal(response.status, 200, await response.clone().text())
		assert.equal(db.rows.get(`42:${row.id}`)?.parse_status, 'ready')
		assert.equal(db.rows.get(`42:${row.id}`)?.deleted_at, null)
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('complete safely restores its lease after post-HEAD exceptions and final UPDATE failure', async () => {
	const originalFetch = globalThis.fetch
	try {
		const headersFailure = bookRow()
		globalThis.fetch = async () => ({ ok: true, headers: { get() { throw new Error('header failure') } } }) as Response
		const firstDb = createDb([headersFailure])
		assert.equal((await request(`/${headersFailure.id}/complete`, { db: firstDb })).response.status, 500)
		assert.equal(firstDb.rows.get(`42:${headersFailure.id}`)?.parse_status, 'pending')

		const updateFailure = bookRow()
		globalThis.fetch = verifiedObjectFetch(updateFailure)
		const secondDb = createDb([updateFailure], { failRun: sql => sql.includes("parse_status = 'ready'") })
		assert.equal((await request(`/${updateFailure.id}/complete`, { db: secondDb })).response.status, 500)
		assert.equal(secondDb.rows.get(`42:${updateFailure.id}`)?.parse_status, 'pending')
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('complete accepts trimmed case-insensitive exact MIME but rejects parameters', async () => {
	for (const [contentType, expected] of [['  Application/EPUB+ZIP  ', 200], ['application/epub+zip; charset=utf-8', 422]] as const) {
		const row = bookRow()
		const db = createDb([row])
		const originalFetch = globalThis.fetch
		globalThis.fetch = async (input, init) => {
			if (init?.method === 'HEAD') return new Response(null, { status: 200, headers: validHeadHeaders(row, { 'Content-Type': contentType }) })
			return verifiedObjectFetch(row)(input, init)
		}
		try {
			assert.equal((await request(`/${row.id}/complete`, { db })).response.status, expected)
		} finally {
			globalThis.fetch = originalFetch
		}
	}
})

test('complete maps private HEAD status safely and never leaks authorization', async () => {
	for (const [headResult, expected] of [
		[new Response(null, { status: 404 }), 422], [new Response(null, { status: 401 }), 502],
		[new Response(null, { status: 403 }), 502], [new Response(null, { status: 429 }), 502],
		[new Response(null, { status: 500 }), 502], [new Response(null, { status: 302, headers: { Location: 'https://attacker.test' } }), 502],
	] as const) {
		const row = bookRow()
		const originalFetch = globalThis.fetch
		globalThis.fetch = async () => headResult
		try {
			const { response } = await request(`/${row.id}/complete`, { db: createDb([row]) })
			assert.equal(response.status, expected)
			assert.doesNotMatch(await response.text(), /Authorization|q-signature|AKIDEXAMPLEFAKE|attacker/)
		} finally {
			globalThis.fetch = originalFetch
		}
	}
	const row = bookRow()
	const originalFetch = globalThis.fetch
	globalThis.fetch = async () => { throw new Error('network contains Authorization secret') }
	try {
		const { response } = await request(`/${row.id}/complete`, { db: createDb([row]) })
		assert.equal(response.status, 502)
		assert.doesNotMatch(await response.text(), /Authorization|secret/)
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('complete trusts actual SHA-256 bytes instead of object metadata', async () => {
	for (const [body, metadataHash, expected] of [
		[new Uint8Array(123).fill(1), EMPTY_123_SHA256, 422],
		[new Uint8Array(123), 'f'.repeat(64), 200],
	] as const) {
		const row = bookRow()
		const db = createDb([row])
		const originalFetch = globalThis.fetch
		globalThis.fetch = async (_input, init) => {
			if (init?.method === 'HEAD') return new Response(null, { status: 200, headers: validHeadHeaders(row, { 'x-cos-meta-sha256': metadataHash }) })
			if (init?.method === 'GET') return validGetResponse(row, { body })
			if (init?.method === 'DELETE') return new Response(null, { status: 204 })
			throw new Error(`Unexpected COS method: ${init?.method}`)
		}
		try {
			const response = (await request(`/${row.id}/complete`, { db })).response
			assert.equal(response.status, expected)
			assert.doesNotMatch(await response.clone().text(), /Authorization|q-signature|AKIDEXAMPLEFAKE/)
			assert.equal(db.rows.get(`42:${row.id}`)?.parse_status, expected === 200 ? 'ready' : 'failed')
		} finally {
			globalThis.fetch = originalFetch
		}
	}
})

test('complete validates GET lengths before and after reading object bytes', async () => {
	for (const [headers, body] of [
		[{ 'Content-Length': '124' }, new Uint8Array(123)],
		[{}, new Uint8Array(124)],
	] as const) {
		const row = bookRow()
		const db = createDb([row])
		const originalFetch = globalThis.fetch
		globalThis.fetch = async (_input, init) => {
			if (init?.method === 'HEAD') return new Response(null, { status: 200, headers: validHeadHeaders(row) })
			if (init?.method === 'GET') return new Response(body, { status: 200, headers })
			if (init?.method === 'DELETE') return new Response(null, { status: 204 })
			throw new Error(`Unexpected COS method: ${init?.method}`)
		}
		try {
			assert.equal((await request(`/${row.id}/complete`, { db })).response.status, 422)
			assert.equal(db.rows.get(`42:${row.id}`)?.parse_status, 'failed')
		} finally {
			globalThis.fetch = originalFetch
		}
	}
})

test('complete maps private GET failures safely and restores pending', async () => {
	for (const outcome of [
		new Response(null, { status: 404 }), new Response(null, { status: 401 }), new Response(null, { status: 403 }),
		new Response(null, { status: 429 }), new Response(null, { status: 500 }),
		new Response(null, { status: 302, headers: { Location: 'https://attacker.test/?Authorization=secret' } }),
	] as const) {
		const row = bookRow()
		const db = createDb([row])
		const originalFetch = globalThis.fetch
		globalThis.fetch = async (_input, init) => init?.method === 'HEAD'
			? new Response(null, { status: 200, headers: validHeadHeaders(row) })
			: outcome
		try {
			const response = (await request(`/${row.id}/complete`, { db })).response
			assert.equal(response.status, outcome.status === 404 ? 422 : 502)
			assert.equal(db.rows.get(`42:${row.id}`)?.parse_status, 'pending')
			assert.doesNotMatch(await response.text(), /Authorization|secret|q-signature|AKIDEXAMPLEFAKE|attacker/)
		} finally {
			globalThis.fetch = originalFetch
		}
	}

	const row = bookRow()
	const db = createDb([row])
	const originalFetch = globalThis.fetch
	globalThis.fetch = async (_input, init) => {
		if (init?.method === 'HEAD') return new Response(null, { status: 200, headers: validHeadHeaders(row) })
		throw new Error('network Authorization secret')
	}
	try {
		const response = (await request(`/${row.id}/complete`, { db })).response
		assert.equal(response.status, 502)
		assert.equal(db.rows.get(`42:${row.id}`)?.parse_status, 'pending')
		assert.doesNotMatch(await response.text(), /Authorization|secret/)
	} finally {
		globalThis.fetch = originalFetch
	}

	const readFailure = bookRow()
	const readFailureDb = createDb([readFailure])
	globalThis.fetch = async (_input, init) => {
		if (init?.method === 'HEAD') return new Response(null, { status: 200, headers: validHeadHeaders(readFailure) })
		return {
			ok: true,
			status: 200,
			headers: new Headers({ 'Content-Length': String(readFailure.declared_size) }),
			async arrayBuffer() { throw new Error('stream Authorization secret') },
		} as Response
	}
	try {
		const response = (await request(`/${readFailure.id}/complete`, { db: readFailureDb })).response
		assert.equal(response.status, 502)
		assert.equal(readFailureDb.rows.get(`42:${readFailure.id}`)?.parse_status, 'pending')
		assert.doesNotMatch(await response.text(), /Authorization|secret/)
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('scheduled cleanup soft-deletes expired pending books and starts DELETE at upload expiry', async () => {
	const db = createSqliteD1()
	const now = Math.floor(Date.now() / 1000)
	const row = insertReadyBook(db, { id: 'expired', parse_status: 'pending', verified_size: null, upload_expires_at: now - 1 })
	const originalFetch = globalThis.fetch
	let calls = 0
	globalThis.fetch = async (_input, init) => {
		calls++
		assert.equal(init?.method, 'DELETE')
		return new Response(null, { status: 204 })
	}
	try {
		assert.equal(await cleanupPrivateNovelObjects({ ...env, abdl_space_db: db } as never, now, 50), 1)
		assert.equal(calls, 1)
		assert.equal(db.database.prepare('SELECT parse_status FROM private_books WHERE owner_id = 42 AND id = ?').get(row.id)?.parse_status, 'failed')
		assert.equal(db.database.prepare('SELECT status FROM novel_object_cleanup_jobs WHERE object_key = ?').get(row.object_key)?.status, 'monitoring')
	} finally {
		globalThis.fetch = originalFetch
		db.database.close()
	}
})

test('scheduled cleanup atomically removes a parsing lease stale by over five minutes and releases quota', async () => {
	const db = createSqliteD1()
	const now = Math.floor(Date.now() / 1000)
	const row = insertReadyBook(db, {
		id: 'stale-parsing', parse_status: 'parsing', verified_size: null, declared_size: 2_000_000_000,
		upload_expires_at: now + 300, verification_started_at: (now * 1_000_000) - 301_000_000,
	})
	assert.equal(await cleanupPrivateNovelObjects({ ...env, abdl_space_db: db } as never, now, 50), 0)
	assert.notEqual(db.database.prepare('SELECT deleted_at FROM private_books WHERE owner_id = 42 AND id = ?').get(row.id)?.deleted_at, null)
	assert.equal(db.database.prepare('SELECT status FROM novel_object_cleanup_jobs WHERE object_key = ?').get(row.object_key)?.status, 'pending')
	const authorized = await phase2Request(db, 'POST', '/authorize', { body: { ...validAuthorize, declared_size: 40_000_000, content_hash: 'e'.repeat(64) } })
	assert.equal(authorized.status, 200)
	db.database.close()
})

test('scheduled cleanup keeps successful and missing deletes monitoring and backs off failures without starving later jobs', async () => {
	for (const [status, expected] of [[404, 'monitoring'], [204, 'monitoring'], [500, 'failed']] as const) {
		const db = createSqliteD1()
		db.database.prepare("INSERT INTO novel_object_cleanup_jobs (object_key, not_before, status, next_attempt_at) VALUES ('first', 1, 'pending', 1), ('second', 1, 'pending', 1)").run()
		const originalFetch = globalThis.fetch
		let authorization = ''
		const keys: string[] = []
		globalThis.fetch = async (_input, init) => {
			authorization = (init?.headers as Record<string, string>).Authorization
			keys.push(String(_input))
			return new Response(null, { status: keys.length === 1 ? status : 204 })
		}
		try {
			assert.equal(await cleanupPrivateNovelObjects({ ...env, abdl_space_db: db } as never, 100, 50), 2)
			assert.equal(db.database.prepare("SELECT status FROM novel_object_cleanup_jobs WHERE object_key = 'first'").get()?.status, expected)
			assert.equal(db.database.prepare("SELECT status FROM novel_object_cleanup_jobs WHERE object_key = 'second'").get()?.status, 'monitoring')
			assert.match(authorization, /q-ak=AKIDEXAMPLEFAKE(?:&|$)/)
			assert.doesNotMatch(authorization, /PUBLIC-KEY-MUST-NOT-BE-USED|public-secret-must-not-be-used/)
		} finally {
			globalThis.fetch = originalFetch
			db.database.close()
		}
	}
})

test('scheduled cleanup conditionally claims each object once', async () => {
	const db = createSqliteD1()
	db.database.prepare("INSERT INTO novel_object_cleanup_jobs (object_key, not_before, status, next_attempt_at) VALUES ('once', 1, 'pending', 1)").run()
	const originalFetch = globalThis.fetch
	let releaseDelete!: () => void
	const deleteGate = new Promise<void>(resolve => { releaseDelete = resolve })
	let calls = 0
	globalThis.fetch = async () => { calls++; await deleteGate; return new Response(null, { status: 204 }) }
	try {
		const first = cleanupPrivateNovelObjects({ ...env, abdl_space_db: db } as never, 100, 50)
		while (calls !== 1) await new Promise(resolve => setTimeout(resolve, 0))
		assert.equal(await cleanupPrivateNovelObjects({ ...env, abdl_space_db: db } as never, 100, 50), 0)
		assert.equal(calls, 1)
		releaseDelete()
		assert.equal(await first, 1)
	} finally {
		globalThis.fetch = originalFetch
		db.database.close()
	}
})

test('scheduled cleanup processes at most 50 due jobs per invocation', async () => {
	const db = createSqliteD1()
	for (let index = 0; index < 51; index++) {
		db.database.prepare('INSERT INTO novel_object_cleanup_jobs (object_key, not_before, status, next_attempt_at) VALUES (?, 1, \'pending\', 1)').run(`batch-${index}`)
	}
	const originalFetch = globalThis.fetch
	let calls = 0
	globalThis.fetch = async () => { calls++; return new Response(null, { status: 204 }) }
	try {
		assert.equal(await cleanupPrivateNovelObjects({ ...env, abdl_space_db: db } as never, 100, 500), 50)
		assert.equal(calls, 50)
		assert.equal(db.database.prepare("SELECT COUNT(*) AS count FROM novel_object_cleanup_jobs WHERE status = 'pending'").get()?.count, 1)
	} finally {
		globalThis.fetch = originalFetch
		db.database.close()
	}
})

test('paste cleanup monitors forever across DELETE 404, a late PUT, DELETE 204, and later 404', async () => {
	const db = createSqliteD1()
	const originalFetch = globalThis.fetch
	let releasePut!: () => void
	const putGate = new Promise<void>(resolve => { releasePut = resolve })
	let putStarted = false
	let objectExists = false
	let deleteCalls = 0
	globalThis.fetch = async (_input, init) => {
		if (init?.method === 'PUT') {
			putStarted = true
			await putGate
			objectExists = true
			return new Response(null, { status: 200 })
		}
		if (init?.method === 'DELETE') {
			deleteCalls++
			if (!objectExists) return new Response(null, { status: 404 })
			objectExists = false
			return new Response(null, { status: 204 })
		}
		if (init?.method === 'HEAD') return new Response(null, { status: 200, headers: { 'Content-Length': '5', 'Content-Type': 'text/plain' } })
		if (init?.method === 'GET') return new Response('late\n', { status: 200, headers: { 'Content-Length': '5' } })
		throw new Error(`unexpected ${init?.method}`)
	}
	try {
		const paste = phase2Request(db, 'POST', '/paste', { body: { title: 'Late paste', author: 'Writer', text: 'late' } })
		while (!putStarted) await new Promise(resolve => setTimeout(resolve, 0))
		const row = db.database.prepare("SELECT id, upload_expires_at FROM private_books WHERE owner_id = 42 AND title = 'Late paste'").get() as { id: string, upload_expires_at: number }
		assert.equal((await phase2Request(db, 'DELETE', `/books/${row.id}`)).status, 200)
		assert.equal(db.database.prepare('SELECT status FROM novel_object_cleanup_jobs WHERE object_key = (SELECT object_key FROM private_books WHERE owner_id = 42 AND id = ?)').get(row.id)?.status, 'pending')
		assert.equal(await cleanupPrivateNovelObjects({ ...env, abdl_space_db: db } as never, row.upload_expires_at - 1, 50), 0)
		assert.equal(await cleanupPrivateNovelObjects({ ...env, abdl_space_db: db } as never, row.upload_expires_at, 50), 1)
		assert.equal(db.database.prepare('SELECT status FROM novel_object_cleanup_jobs WHERE object_key = (SELECT object_key FROM private_books WHERE owner_id = 42 AND id = ?)').get(row.id)?.status, 'monitoring')
		releasePut()
		assert.equal((await paste).status, 502)
		assert.equal(objectExists, true)
		assert.equal(await cleanupPrivateNovelObjects({ ...env, abdl_space_db: db } as never, row.upload_expires_at + 86_399, 50), 0)
		assert.equal(await cleanupPrivateNovelObjects({ ...env, abdl_space_db: db } as never, row.upload_expires_at + 86_400, 50), 1)
		assert.equal(objectExists, false)
		assert.equal(await cleanupPrivateNovelObjects({ ...env, abdl_space_db: db } as never, row.upload_expires_at + 172_800, 50), 1)
		assert.equal(deleteCalls, 3)
		assert.equal(db.database.prepare('SELECT status FROM novel_object_cleanup_jobs WHERE object_key = (SELECT object_key FROM private_books WHERE owner_id = 42 AND id = ?)').get(row.id)?.status, 'monitoring')
	} finally {
		globalThis.fetch = originalFetch
		db.database.close()
	}
})

test('authorize cleanup starts at expiry and keeps monitoring after deleting a late PUT', async () => {
	const db = createSqliteD1()
	const originalFetch = globalThis.fetch
	let objectExists = false
	let deleteCalls = 0
	globalThis.fetch = async (_input, init) => {
		assert.equal(init?.method, 'DELETE')
		deleteCalls++
		if (!objectExists) return new Response(null, { status: 404 })
		objectExists = false
		return new Response(null, { status: 204 })
	}
	try {
		const authorized = await phase2Request(db, 'POST', '/authorize', { body: validAuthorize })
		const body = await authorized.json() as { upload_id: string, expires_at: number }
		assert.equal((await phase2Request(db, 'DELETE', `/books/${body.upload_id}`)).status, 200)
		assert.equal(db.database.prepare('SELECT status FROM novel_object_cleanup_jobs WHERE object_key = (SELECT object_key FROM private_books WHERE owner_id = 42 AND id = ?)').get(body.upload_id)?.status, 'pending')
		objectExists = true
		assert.equal(await cleanupPrivateNovelObjects({ ...env, abdl_space_db: db } as never, body.expires_at - 1, 50), 0)
		assert.equal(objectExists, true)
		assert.equal(await cleanupPrivateNovelObjects({ ...env, abdl_space_db: db } as never, body.expires_at, 50), 1)
		assert.equal(objectExists, false)
		assert.equal(deleteCalls, 1)
		assert.equal(db.database.prepare('SELECT status FROM novel_object_cleanup_jobs WHERE object_key = (SELECT object_key FROM private_books WHERE owner_id = 42 AND id = ?)').get(body.upload_id)?.status, 'monitoring')
	} finally {
		globalThis.fetch = originalFetch
		db.database.close()
	}
})

test('download authorization is owner-only, ready-only, and excludes deleted books', async () => {
	for (const [row, sub] of [
		[bookRow({ parse_status: 'pending' }), 42], [bookRow({ parse_status: 'ready', verified_size: 123 }), 7],
		[bookRow({ parse_status: 'ready', verified_size: 123, deleted_at: 1 }), 42],
	] as const) {
		assert.equal((await request(`/${row.id}/download/authorize`, { db: createDb([row]), sub })).response.status, 404)
	}
})

test('download authorization returns a short-lived private signed GET URL', async () => {
	const row = bookRow({ parse_status: 'ready', verified_size: 123 })
	const { response } = await request(`/${row.id}/download/authorize`, { db: createDb([row]) })
	assert.equal(response.status, 200, await response.clone().text())
	const result = await response.json() as Record<string, unknown>
	assert.match(String(result.download_url), /^https:\/\/private-books-123\.cos\.ap-shanghai\.myqcloud\.com\//)
	assert.match(String(result.download_url), /q-ak=AKIDEXAMPLEFAKE(?:&|$)/)
	assert.doesNotMatch(String(result.download_url), /PUBLIC-KEY-MUST-NOT-BE-USED|public\.example/)
})

test('Phase 2 read and write endpoints enforce OAuth scopes and stale JWT rejection', async () => {
	const db = createSqliteD1()
	insertReadyBook(db, { id: 'book' })
	db.database.prepare(`INSERT INTO oauth_tokens (access_token, refresh_token, client_id, user_id, scopes, access_expires_at, refresh_expires_at, created_at)
		VALUES ('read-token', 'rr', 'client', 42, 'read', ?, ?, 1), ('write-token', 'rw', 'client', 42, 'write', ?, ?, 1)`)
		.run(2_000_000_000, 2_000_000_000, 2_000_000_000, 2_000_000_000)
	for (const [method, path, token, expected] of [
		['GET', '/books', 'write-token', 403], ['GET', '/books', 'read-token', 200],
		['GET', '/books/book', 'write-token', 403], ['GET', '/sync', 'read-token', 200],
		['DELETE', '/books/book', 'read-token', 403], ['PUT', '/sync/items/item', 'read-token', 403],
	] as const) {
		const response = await phase2Request(db, method, path, { authorization: `Bearer ${token}`, body: method === 'PUT' ? { book_id: 'book', item_type: 'bookmark', payload: {}, updated_at: 1 } : undefined })
		assert.equal(response.status, expected, `${method} ${path}`)
	}
	const oldJwt = await bearer()
	db.database.prepare('UPDATE users SET password_changed_at = ? WHERE id = 42').run(new Date(Date.now() + 60_000).toISOString())
	assert.equal((await phase2Request(db, 'GET', '/books', { authorization: oldJwt })).status, 401)
	db.database.close()
})

test('GET books is owner-only, excludes deleted books, returns safe DTOs, and paginates equal timestamps without gaps', async () => {
	const db = createSqliteD1()
	for (const [id, ownerId, updatedAt, deletedAt] of [
		['a', 42, 300, null], ['b', 42, 300, null], ['c', 42, 200, null], ['deleted', 42, 400, 1], ['other', 7, 500, null],
	] as const) insertReadyBook(db, { id, owner_id: ownerId, content_hash: id.padEnd(64, '0'), created_at: updatedAt, updated_at: updatedAt, deleted_at: deletedAt })

	const first = await phase2Request(db, 'GET', '/books?limit=1')
	assert.equal(first.status, 200)
	const firstBody = await first.json() as { items: Array<Record<string, unknown>>, next_cursor: string | null }
	assert.equal(firstBody.items.length, 1)
	assert.equal(firstBody.items[0].id, 'b')
	assert.deepEqual(Object.keys(firstBody.items[0]).sort(), ['author', 'content_hash', 'created_at', 'format', 'id', 'parse_status', 'title', 'updated_at', 'verified_size'])
	assert.ok(firstBody.next_cursor)
	const second = await phase2Request(db, 'GET', `/books?limit=2&cursor=${encodeURIComponent(firstBody.next_cursor!)}`)
	assert.deepEqual((await second.json() as { items: Array<{ id: string }> }).items.map(item => item.id), ['a', 'c'])
	assert.equal((await phase2Request(db, 'GET', '/books?limit=51')).status, 400)
	assert.equal((await phase2Request(db, 'GET', '/books?cursor=not-a-cursor')).status, 400)
	db.database.close()
})

test('GET books uses immutable created_at and UTF-8 id cursors despite updates and page-between inserts', async () => {
	const db = createSqliteD1()
	insertReadyBook(db, { id: '书-a', content_hash: '1'.repeat(64), created_at: 100, updated_at: 100 })
	insertReadyBook(db, { id: '书-b', content_hash: '2'.repeat(64), created_at: 100, updated_at: 100 })
	insertReadyBook(db, { id: 'older', content_hash: '3'.repeat(64), created_at: 90, updated_at: 90 })
	const first = await phase2Request(db, 'GET', '/books?limit=1')
	const firstBody = await first.json() as { items: Array<{ id: string }>, next_cursor: string }
	assert.equal(first.status, 200)
	assert.equal(firstBody.items[0].id, '书-b')
	db.database.prepare("UPDATE private_books SET updated_at = unixepoch() + 60 WHERE owner_id = 42 AND id = 'older'").run()
	insertReadyBook(db, { id: 'newer', content_hash: '4'.repeat(64), created_at: 110, updated_at: 110 })
	const second = await phase2Request(db, 'GET', `/books?limit=2&cursor=${encodeURIComponent(firstBody.next_cursor)}`)
	assert.deepEqual((await second.json() as { items: Array<{ id: string }> }).items.map(item => item.id), ['书-a', 'older'])
	db.database.close()
})

test('GET book and DELETE book never cross owners; delete is idempotent, immediately invisible, and failed COS cleanup is retryable', async () => {
	const db = createSqliteD1()
	const row = insertReadyBook(db, { id: 'owned', declared_size: 2_000_000_000, content_hash: 'd'.repeat(64) })
	assert.equal((await phase2Request(db, 'GET', '/books/owned', { sub: 7 })).status, 404)
	assert.equal((await phase2Request(db, 'DELETE', '/books/owned', { sub: 7 })).status, 404)

	const originalFetch = globalThis.fetch
	globalThis.fetch = async (_input, init) => {
		assert.equal(init?.method, 'DELETE')
		return new Response(null, { status: 500 })
	}
	try {
		const deleted = await phase2Request(db, 'DELETE', '/books/owned', { headers: { 'Idempotency-Key': 'delete-owned' } })
		assert.equal(deleted.status, 200)
		assert.equal((await phase2Request(db, 'GET', '/books/owned')).status, 404)
		const stored = db.database.prepare('SELECT deleted_at, cleanup_status FROM private_books WHERE owner_id = 42 AND id = ?').get(row.id) as { deleted_at: number | null, cleanup_status: string }
		assert.notEqual(stored.deleted_at, null)
		assert.equal(stored.cleanup_status, 'pending')
		assert.equal(db.database.prepare('SELECT status FROM novel_object_cleanup_jobs WHERE object_key = ?').get(row.object_key)?.status, 'pending')
		assert.equal((await phase2Request(db, 'DELETE', '/books/owned', { headers: { 'Idempotency-Key': 'delete-owned' } })).status, 200)
		assert.equal((await phase2Request(db, 'POST', '/authorize', { body: { ...validAuthorize, declared_size: 40_000_000, content_hash: 'e'.repeat(64) } })).status, 200)
	} finally {
		globalThis.fetch = originalFetch
		db.database.close()
	}
})

test('POST paste validates JSON and text, normalizes content, deduplicates by hash, writes private COS without overwrite, and never returns a URL', async () => {
	const db = createSqliteD1()
	for (const body of [[], { title: 'x', author: 'y', text: '' }, { title: 'x', author: 'y', text: 'ok\u0000bad' }, { title: 'x', author: 'y', text: 'a'.repeat(200_001) }]) {
		const response = await createApp().request('/api/v1/novels/private/paste', {
			method: 'POST', headers: { Authorization: await bearer(), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
		}, { ...env, abdl_space_db: db } as never)
		assert.equal(response.status, 400)
	}

	const originalFetch = globalThis.fetch
	const calls: Array<{ method: string, body?: string, headers: Headers }> = []
	globalThis.fetch = async (_input, init) => {
		const headers = new Headers(init?.headers)
		calls.push({ method: String(init?.method), body: typeof init?.body === 'string' ? init.body : undefined, headers })
		if (init?.method === 'PUT') return new Response(null, { status: 200 })
		if (init?.method === 'HEAD') return new Response(null, { status: 200, headers: { 'Content-Length': '12', 'Content-Type': 'text/plain' } })
		if (init?.method === 'GET') return new Response('hello\nworld\n', { status: 200, headers: { 'Content-Length': '12' } })
		throw new Error(`unexpected ${init?.method}`)
	}
	try {
		const input = { title: '  Pasted  ', author: '  Writer  ', text: 'hello\r\nworld  ' }
		const first = await phase2Request(db, 'POST', '/paste', { body: input, headers: { 'Idempotency-Key': 'paste-1' } })
		assert.equal(first.status, 200, await first.clone().text())
		const firstBody = await first.json() as Record<string, unknown>
		assert.equal(firstBody.parse_status, 'ready')
		assert.equal(firstBody.verified_size, 12)
		assert.equal('url' in firstBody || 'upload_url' in firstBody || 'object_key' in firstBody, false)
		assert.equal(calls[0].method, 'PUT')
		assert.equal(calls[0].body, 'hello\nworld\n')
		assert.equal(calls[0].headers.get('x-cos-forbid-overwrite'), 'true')
		assert.equal(calls[0].headers.get('Content-Length'), '12')
		assert.equal(calls[0].headers.get('Content-MD5'), 'D3I65/m/B3RERek6xVlRVg==')
		assert.match(calls[0].headers.get('Authorization') ?? '', /q-header-list=content-length;content-md5;content-type;host;x-cos-forbid-overwrite;x-cos-meta-sha256/)
		assert.match(calls[0].headers.get('Authorization') ?? '', /q-ak=AKIDEXAMPLEFAKE/)
		const duplicate = await phase2Request(db, 'POST', '/paste', { body: { ...input, text: 'hello\nworld\n' }, headers: { 'Idempotency-Key': 'paste-2' } })
		assert.equal(duplicate.status, 200)
		assert.equal((await duplicate.json() as { id: string }).id, firstBody.id)
		assert.equal(calls.filter(call => call.method === 'PUT').length, 1)
	} finally {
		globalThis.fetch = originalFetch
		db.database.close()
	}
})

test('JSON request limits reject oversized declared and streamed bodies without consuming the full stream', async () => {
	const db = createSqliteD1()
	const declared = await createApp().request('/api/v1/novels/private/authorize', {
		method: 'POST', headers: { Authorization: await bearer(), 'Content-Type': 'application/json', 'Content-Length': String(64 * 1024 + 1) }, body: '{}',
	}, { ...env, abdl_space_db: db } as never)
	assert.equal(declared.status, 413)

	let pulls = 0
	let cancelled = false
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			pulls++
			controller.enqueue(new Uint8Array(40 * 1024).fill(97))
			if (pulls > 100) controller.close()
		},
		cancel() { cancelled = true },
	})
	const streamed = await createApp().fetch(new Request('https://example.test/api/v1/novels/private/sync/items/item', {
		method: 'PUT', headers: { Authorization: await bearer(), 'Content-Type': 'application/json' }, body: stream, duplex: 'half',
	} as RequestInit & { duplex: 'half' }), { ...env, abdl_space_db: db } as never)
	assert.equal(streamed.status, 413)
	assert.equal(cancelled, true)
	assert.ok(pulls < 100)
	db.database.close()
})

test('sync PUT validates stable identity and payload, enforces active owner book, and applies trusted LWW rules', async () => {
	const db = createSqliteD1()
	insertReadyBook(db, { id: 'book' })
	insertReadyBook(db, { id: 'deleted-book', content_hash: '8'.repeat(64), deleted_at: 1 })
	insertReadyBook(db, { id: 'other-book', owner_id: 7, content_hash: 'f'.repeat(64) })
	const now = Date.now()
	for (const [id, body, expected] of [
		['item', [], 400], ['item', { book_id: 'book', item_type: 'bad', payload: {}, client_updated_at: 1 }, 400],
		['item', { book_id: 'book', item_type: 'bookmark', payload: [], client_updated_at: 1 }, 400],
		['item', { book_id: 'book', item_type: 'bookmark', payload: { value: 'x'.repeat(70_000) }, client_updated_at: 1 }, 400],
		['item', { book_id: 'other-book', item_type: 'bookmark', payload: {}, client_updated_at: 1 }, 404],
		['item', { book_id: 'deleted-book', item_type: 'bookmark', payload: {}, client_updated_at: 1 }, 404],
		['item', { book_id: 'book', item_type: 'bookmark', payload: {}, client_updated_at: now + 301_000 }, 400],
		['url-id', { book_id: 'book', item_type: 'bookmark', item_id: 'body-id', payload: {}, client_updated_at: 1 }, 400],
	] as const) assert.equal((await phase2Request(db, 'PUT', `/sync/items/${id}`, { body })).status, expected)

	const base = { book_id: 'book', item_type: 'bookmark', payload: { chapter: 2 }, client_updated_at: 100 }
	assert.equal((await phase2Request(db, 'PUT', '/sync/items/stable', { body: base })).status, 200)
	assert.equal((await phase2Request(db, 'PUT', '/sync/items/stable', { body: { ...base, payload: { chapter: 1 }, client_updated_at: 99 } })).status, 200)
	assert.equal((await phase2Request(db, 'PUT', '/sync/items/stable', { body: { ...base, payload: {}, deleted_at: 100 } })).status, 200)
	assert.equal((await phase2Request(db, 'PUT', '/sync/items/stable', { body: { ...base, payload: { chapter: 3 } } })).status, 200)
	assert.equal((await phase2Request(db, 'PUT', '/sync/items/stable', { body: { ...base, payload: { chapter: 4 }, client_updated_at: 101 } })).status, 200)
	const row = db.database.prepare("SELECT payload_json, client_updated_at, server_updated_at, deleted_at FROM novel_sync_items WHERE owner_id = 42 AND item_type = 'bookmark' AND item_id = 'stable'").get() as { payload_json: string, client_updated_at: number, server_updated_at: number, deleted_at: number | null }
	assert.deepEqual(JSON.parse(row.payload_json), {})
	assert.equal(row.client_updated_at, 100)
	assert.ok(row.server_updated_at > 0)
	assert.equal(row.deleted_at, 100)
	assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM novel_sync_changes').get()?.count, 2)
	db.database.close()
})

test('GET sync paginates immutable seq changes without omissions when an item changes between pages', async () => {
	const db = createSqliteD1()
	insertReadyBook(db, { id: 'book' })
	insertReadyBook(db, { id: 'other-book', owner_id: 7, content_hash: '9'.repeat(64) })
	for (const [owner, book, type, id, updated, deleted] of [[42, 'book', 'bookmark', 'a', 100, null], [42, 'book', 'note', 'b', 100, null], [7, 'other-book', 'bookmark', 'secret', 200, null]] as const) {
		db.database.prepare('INSERT INTO novel_sync_items (book_id, owner_id, item_type, item_id, payload_json, client_updated_at, server_updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(book, owner, type, id, '{}', updated, 1, deleted)
	}
	const first = await phase2Request(db, 'GET', '/sync?limit=1')
	const firstBody = await first.json() as { items: Array<Record<string, unknown>>, next_cursor: string, checkpoint_cursor: string }
	assert.equal(first.status, 200)
	assert.deepEqual(Object.keys(firstBody.items[0]).sort(), ['book_id', 'client_updated_at', 'deleted_at', 'item_id', 'item_type', 'payload', 'seq'])
	db.database.prepare("UPDATE novel_sync_items SET payload_json = '{\"chapter\":2}', client_updated_at = 101, server_updated_at = 2 WHERE owner_id = 42 AND item_type = 'bookmark' AND item_id = 'a'").run()
	assert.equal(firstBody.checkpoint_cursor, firstBody.next_cursor)
	const second = await phase2Request(db, 'GET', `/sync?limit=10&cursor=${encodeURIComponent(firstBody.checkpoint_cursor)}`)
	const secondBody = await second.json() as { items: Array<{ seq: number, item_id: string, payload: Record<string, unknown> }>, checkpoint_cursor: string, next_cursor: null }
	assert.deepEqual(secondBody.items.map(item => [item.seq, item.item_id, item.payload]), [[2, 'b', {}], [4, 'a', { chapter: 2 }]])
	assert.equal(secondBody.next_cursor, null)
	const unchanged = await phase2Request(db, 'GET', `/sync?cursor=${encodeURIComponent(secondBody.checkpoint_cursor)}`)
	assert.deepEqual(await unchanged.json(), { items: [], next_cursor: null, checkpoint_cursor: secondBody.checkpoint_cursor })
	db.database.prepare("UPDATE novel_sync_items SET payload_json = '{\"chapter\":3}', client_updated_at = 102, server_updated_at = 3 WHERE owner_id = 42 AND item_type = 'bookmark' AND item_id = 'a'").run()
	const incremental = await phase2Request(db, 'GET', `/sync?cursor=${encodeURIComponent(secondBody.checkpoint_cursor)}`)
	assert.deepEqual((await incremental.json() as { items: Array<{ payload: Record<string, unknown> }> }).items.map(item => item.payload), [{ chapter: 3 }])
	assert.equal((await phase2Request(db, 'GET', '/sync?limit=201')).status, 400)
	assert.equal((await phase2Request(db, 'GET', '/sync?cursor=bad')).status, 400)
	db.database.close()
})

test('GET sync returns an encoded zero checkpoint for an initially empty account', async () => {
	const db = createSqliteD1()
	const response = await phase2Request(db, 'GET', '/sync')
	const body = await response.json() as { items: unknown[], next_cursor: null, checkpoint_cursor: string }
	assert.deepEqual(body.items, [])
	assert.equal(body.next_cursor, null)
	assert.ok(body.checkpoint_cursor)
	db.database.close()
})

test('Phase 2 CORS preflight allows GET, DELETE, PUT, and Idempotency-Key', async () => {
	for (const method of ['GET', 'DELETE', 'PUT']) {
		const response = await createApp().request('/api/v1/novels/private/books', {
			method: 'OPTIONS', headers: { Origin: 'https://client.test', 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'Idempotency-Key' },
		}, { ...env, abdl_space_db: createDb() } as never)
		assert.equal(response.status, 204)
		assert.match(response.headers.get('Access-Control-Allow-Methods') ?? '', new RegExp(method))
		assert.match(response.headers.get('Access-Control-Allow-Headers') ?? '', /Idempotency-Key/i)
	}
})
