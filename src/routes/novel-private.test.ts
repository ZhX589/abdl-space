import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { Hono } from 'hono'

import { signJWT } from '../lib/auth.ts'
import novelPrivate, { MAX_PRIVATE_BOOK_SIZE, PRIVATE_BOOK_INSERT_SQL } from './novel-private.ts'

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

interface BookRow {
	id: string
	owner_id: number
	title: string
	author: string
	format: 'txt' | 'epub'
	object_key: string
	content_hash: string
	declared_size: number
	verified_size: number | null
	parse_status: 'pending' | 'parsing' | 'ready' | 'failed'
	upload_expires_at: number
	verification_started_at: number | null
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
		content_hash: 'a'.repeat(64),
		declared_size: 123,
		verified_size: null,
		parse_status: 'pending',
		upload_expires_at: Math.floor(Date.now() / 1000) + 300,
		verification_started_at: null,
		deleted_at: null,
		...overrides,
	}
}

function createDb(initialRows: BookRow[] = [], options: {
	oauthTokens?: OAuthToken[]
	passwordChangedAt?: Record<number, string | null>
	failRun?: (sql: string, call: number) => boolean
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
							if (options.failRun?.(sql, runCalls)) return { success: false, meta: { changes: 0 } }
							if (sql.includes('INSERT INTO private_books')) {
								const [id, ownerId, title, author, format, objectKey, contentHash, declaredSize, uploadExpiresAt] = params
								const active = [...rows.values()].filter(row => row.owner_id === Number(ownerId) && row.deleted_at === null)
								if (active.length >= 500 || active.reduce((sum, row) => sum + row.declared_size, 0) + Number(declaredSize) > 2 * 1024 * 1024 * 1024
									|| active.some(row => row.content_hash === String(contentHash))) return { success: true, meta: { changes: 0 } }
								rows.set(`${ownerId}:${id}`, {
									id: String(id), owner_id: Number(ownerId), title: String(title), author: String(author),
									format: String(format) as BookRow['format'], object_key: String(objectKey), content_hash: String(contentHash),
									declared_size: Number(declaredSize), verified_size: null, parse_status: 'pending',
									upload_expires_at: Number(uploadExpiresAt), deleted_at: null,
									verification_started_at: null,
								})
								return { success: true, meta: { changes: 1 } }
							}
							if (sql.includes('SET upload_expires_at = ?')) {
								const [expiresAt, id, ownerId] = params
								const row = rows.get(`${ownerId}:${id}`)
								if (!row || row.deleted_at !== null) return { success: true, meta: { changes: 0 } }
								row.upload_expires_at = Number(expiresAt)
								return { success: true, meta: { changes: 1 } }
							}
							if (sql.includes("SET parse_status = 'parsing'")) {
								const [verificationStartedAt, id, ownerId, staleBefore] = params
								const row = rows.get(`${ownerId}:${id}`)
								if (!row || row.deleted_at !== null || (row.parse_status !== 'pending'
									&& !(row.parse_status === 'parsing' && (row.verification_started_at === null || row.verification_started_at <= Number(staleBefore))))) return { success: true, meta: { changes: 0 } }
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
							if (sql.includes("parse_status = 'failed'") && sql.includes('deleted_at')) {
								const [id, ownerId] = params
								const row = rows.get(`${ownerId}:${id}`)
								if (!row || row.deleted_at !== null) return { success: true, meta: { changes: 0 } }
								row.parse_status = 'failed'
								row.deleted_at = Math.floor(Date.now() / 1000)
								row.verification_started_at = null
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

const validAuthorize = {
	title: 'My private book',
	author: 'Writer',
	mime_type: 'application/epub+zip',
	declared_size: 123,
	content_hash: 'b'.repeat(64),
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
			CREATE TABLE private_books (
				id TEXT NOT NULL, owner_id INTEGER NOT NULL, title TEXT NOT NULL, author TEXT NOT NULL,
				format TEXT NOT NULL, object_key TEXT NOT NULL, content_hash TEXT NOT NULL,
				declared_size INTEGER NOT NULL, verified_size INTEGER, parse_status TEXT NOT NULL,
				upload_expires_at INTEGER NOT NULL, verification_started_at INTEGER, deleted_at INTEGER,
				PRIMARY KEY (owner_id, id)
			);
			CREATE UNIQUE INDEX active_hash ON private_books(owner_id, content_hash) WHERE deleted_at IS NULL;
		`)
		const statement = database.prepare(PRIVATE_BOOK_INSERT_SQL)
		const bind = (id: string, key: string) => [id, 42, validAuthorize.title, validAuthorize.author, 'epub', key, validAuthorize.content_hash, validAuthorize.declared_size, 12345]
		assert.equal(statement.run(...bind('first', 'first.epub')).changes, 1)
		assert.equal(statement.run(...bind('second', 'second.epub')).changes, 0)
		assert.equal(database.prepare('SELECT COUNT(*) AS count FROM private_books').get()?.count, 1)
	} finally {
		database.close()
	}
})

test('complete atomically claims pending before HEAD and concurrent callers do not duplicate HEAD', async () => {
	const row = bookRow()
	const db = createDb([row])
	const originalFetch = globalThis.fetch
	let releaseHead!: () => void
	const headGate = new Promise<void>(resolve => { releaseHead = resolve })
	let calls = 0
	globalThis.fetch = async () => {
		calls++
		await headGate
		return new Response(null, { status: 200, headers: { 'Content-Length': '123', 'Content-Type': 'application/epub+zip' } })
	}
	try {
		const first = request(`/${row.id}/complete`, { db })
		while (db.rows.get(`42:${row.id}`)?.parse_status !== 'parsing') await new Promise(resolve => setTimeout(resolve, 0))
		while (calls !== 1) await new Promise(resolve => setTimeout(resolve, 0))
		const second = await request(`/${row.id}/complete`, { db })
		assert.equal(second.response.status, 202)
		assert.equal(calls, 1)
		releaseHead()
		assert.equal((await first).response.status, 200)
		assert.equal(calls, 1)
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('complete returns 202 for a live parsing lease and reclaims one older than five minutes', async () => {
	const now = Date.now() * 1000
	const live = bookRow({ parse_status: 'parsing', verification_started_at: now - 299_000_000 })
	let calls = 0
	const originalFetch = globalThis.fetch
	globalThis.fetch = async () => { calls++; return new Response(null, { status: 200, headers: { 'Content-Length': '123', 'Content-Type': 'application/epub+zip' } }) }
	try {
		assert.equal((await request(`/${live.id}/complete`, { db: createDb([live]) })).response.status, 202)
		assert.equal(calls, 0)
		const stale = bookRow({ parse_status: 'parsing', verification_started_at: now - 301_000_000 })
		const { response, db } = await request(`/${stale.id}/complete`, { db: createDb([stale]) })
		assert.equal(response.status, 200, await response.clone().text())
		assert.equal(calls, 1)
		assert.equal(db.rows.get(`42:${stale.id}`)?.parse_status, 'ready')
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('complete expires uploads before HEAD and soft-deletes them for reauthorization', async () => {
	const expired = bookRow({ content_hash: validAuthorize.content_hash, upload_expires_at: Math.floor(Date.now() / 1000) - 1 })
	let calls = 0
	const originalFetch = globalThis.fetch
	globalThis.fetch = async () => { calls++; throw new Error('must not run') }
	try {
		const { response, db } = await request(`/${expired.id}/complete`, { db: createDb([expired]) })
		assert.equal(response.status, 410)
		assert.equal(calls, 0)
		assert.equal(db.rows.get(`42:${expired.id}`)?.parse_status, 'failed')
		assert.notEqual(db.rows.get(`42:${expired.id}`)?.deleted_at, null)
		const reauthorized = await request('/authorize', { body: validAuthorize, db })
		assert.equal(reauthorized.response.status, 200)
		assert.notEqual((await reauthorized.response.json() as { upload_id: string }).upload_id, expired.id)
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
		[new Response(null, { status: 200, headers: { 'Content-Length': '123', 'Content-Type': 'application/epub+zip; charset=utf-8' } }), 'failed'],
	] as const) {
		const row = bookRow()
		const db = createDb([row])
		globalThis.fetch = async () => outcome
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

test('complete safely restores its lease after post-HEAD exceptions and final UPDATE failure', async () => {
	const originalFetch = globalThis.fetch
	try {
		const headersFailure = bookRow()
		globalThis.fetch = async () => ({ ok: true, headers: { get() { throw new Error('header failure') } } }) as Response
		const firstDb = createDb([headersFailure])
		assert.equal((await request(`/${headersFailure.id}/complete`, { db: firstDb })).response.status, 500)
		assert.equal(firstDb.rows.get(`42:${headersFailure.id}`)?.parse_status, 'pending')

		const updateFailure = bookRow()
		globalThis.fetch = async () => new Response(null, { status: 200, headers: { 'Content-Length': '123', 'Content-Type': 'application/epub+zip' } })
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
		globalThis.fetch = async () => new Response(null, { status: 200, headers: { 'Content-Length': '123', 'Content-Type': contentType } })
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
