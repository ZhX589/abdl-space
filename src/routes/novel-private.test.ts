import assert from 'node:assert/strict'
import test from 'node:test'

import { Hono } from 'hono'

import { signJWT } from '../lib/auth.ts'
import novelPrivate, { MAX_PRIVATE_BOOK_SIZE } from './novel-private.ts'

const jwtSecret = 'test-jwt-secret'
const env = {
	JWT_SECRET: jwtSecret,
	COS_SECRET_ID: 'AKIDEXAMPLEFAKE',
	COS_SECRET_KEY: 'fake-secret-key-for-tests-only',
	COS_BUCKET: 'private-books-123',
	COS_REGION: 'ap-shanghai',
	COS_PUBLIC_ORIGIN: 'https://public.example.test',
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
	parse_status: 'pending' | 'ready' | 'failed'
	deleted_at: number | null
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
		deleted_at: null,
		...overrides,
	}
}

function createDb(initialRows: BookRow[] = []) {
	const rows = new Map(initialRows.map(row => [`${row.owner_id}:${row.id}`, { ...row }]))
	let beforeReadyUpdate: (() => void) | undefined

	return {
		rows,
		setBeforeReadyUpdate(callback: () => void) {
			beforeReadyUpdate = callback
		},
		prepare(sql: string) {
			return {
				bind(...params: unknown[]) {
					return {
						async all() {
							if (sql.includes('FROM private_books')) {
								const id = String(params[0])
								const ownerId = Number(params[1])
								const row = rows.get(`${ownerId}:${id}`)
								return { success: true, results: row ? [{ ...row }] : [] }
							}
							return { success: true, results: [] }
						},
						async run() {
							if (sql.includes('INSERT INTO private_books')) {
								const [id, ownerId, title, author, format, objectKey, contentHash, declaredSize] = params
								rows.set(`${ownerId}:${id}`, {
									id: String(id), owner_id: Number(ownerId), title: String(title), author: String(author),
									format: String(format) as BookRow['format'], object_key: String(objectKey), content_hash: String(contentHash),
									declared_size: Number(declaredSize), verified_size: null, parse_status: 'pending', deleted_at: null,
								})
								return { success: true, meta: { changes: 1 } }
							}
							if (sql.includes("SET verified_size = ?") && sql.includes("parse_status = 'ready'")) {
								beforeReadyUpdate?.()
								beforeReadyUpdate = undefined
								const [verifiedSize, id, ownerId] = params
								const row = rows.get(`${ownerId}:${id}`)
								if (!row || row.parse_status !== 'pending' || row.deleted_at !== null) return { success: true, meta: { changes: 0 } }
								row.verified_size = Number(verifiedSize)
								row.parse_status = 'ready'
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

async function request(path: string, options: { body?: unknown, sub?: number, authenticated?: boolean, db?: ReturnType<typeof createDb> } = {}) {
	const db = options.db ?? createDb()
	const headers: Record<string, string> = { 'Content-Type': 'application/json' }
	if (options.authenticated !== false) headers.Authorization = await bearer(options.sub)
	const response = await createApp().request(`/api/v1/novels/private${path}`, {
		method: 'POST',
		headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	}, { ...env, abdl_space_db: db } as never)
	return { response, db }
}

const validAuthorize = {
	title: 'My private book',
	author: 'Writer',
	mime_type: 'application/epub+zip',
	declared_size: 123,
	content_hash: 'b'.repeat(64),
}

test('all private novel protocol endpoints require a trusted authenticated session', async () => {
	for (const [path, body] of [
		['/authorize', validAuthorize],
		['/missing/complete', undefined],
		['/missing/download/authorize', undefined],
	] as const) {
		const { response } = await request(path, { body, authenticated: false })
		assert.equal(response.status, 401, path)
	}
})

test('authorize accepts only TXT and EPUB and enforces the private book size limit', async () => {
	for (const body of [
		{ ...validAuthorize, mime_type: 'application/pdf' },
		{ ...validAuthorize, declared_size: 0 },
		{ ...validAuthorize, declared_size: MAX_PRIVATE_BOOK_SIZE + 1 },
		{ ...validAuthorize, object_key: 'client/chosen.epub' },
	]) {
		const { response } = await request('/authorize', { body })
		assert.equal(response.status, 400, JSON.stringify(body))
	}
	for (const mime_type of ['text/plain', 'application/epub+zip']) {
		const { response } = await request('/authorize', { body: { ...validAuthorize, mime_type, declared_size: MAX_PRIVATE_BOOK_SIZE } })
		assert.equal(response.status, 200, await response.clone().text())
	}
})

test('authorize creates a pending owner-scoped book and returns only short-lived PUT instructions', async () => {
	const { response, db } = await request('/authorize', { body: validAuthorize })
	assert.equal(response.status, 200, await response.clone().text())
	const result = await response.json() as Record<string, unknown>
	assert.deepEqual(Object.keys(result).sort(), ['expires_at', 'required_headers', 'upload_id', 'upload_url'])
	assert.match(String(result.upload_id), /^[0-9a-f-]{36}$/i)
	assert.match(String(result.upload_url), new RegExp(`^https://${env.COS_BUCKET}\\.cos\\.${env.COS_REGION}\\.myqcloud\\.com/novels/private/42/[0-9a-f-]{36}\\.epub$`, 'i'))
	assert.equal(String(result.upload_url).includes(env.COS_PUBLIC_ORIGIN), false)
	const requiredHeaders = result.required_headers as Record<string, string>
	assert.equal(requiredHeaders['Content-Type'], 'application/epub+zip')
	assert.equal(requiredHeaders['x-cos-forbid-overwrite'], 'true')
	assert.match(requiredHeaders.Authorization, /q-header-list=content-type;host;x-cos-forbid-overwrite(?:&|$)/)
	const row = db.rows.get(`42:${result.upload_id}`)
	assert.equal(row?.parse_status, 'pending')
	assert.equal(row?.object_key, `novels/private/42/${result.upload_id}.epub`)
})

test('complete hides other owners as not found and does not issue HEAD', async () => {
	const row = bookRow()
	const db = createDb([row])
	let headCalls = 0
	const originalFetch = globalThis.fetch
	globalThis.fetch = async () => {
		headCalls++
		throw new Error('HEAD must not run')
	}
	try {
		const { response } = await request(`/${row.id}/complete`, { db, sub: 7 })
		assert.equal(response.status, 404)
		assert.equal(headCalls, 0)
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('complete performs an authorized HEAD against the server-recorded key', async () => {
	const row = bookRow()
	const db = createDb([row])
	const originalFetch = globalThis.fetch
	let calls = 0
	globalThis.fetch = async (input, init) => {
		calls++
		assert.equal(input, `https://${env.COS_BUCKET}.cos.${env.COS_REGION}.myqcloud.com/${row.object_key}`)
		assert.equal(init?.method, 'HEAD')
		assert.equal(init?.redirect, 'manual')
		assert.match(new Headers(init?.headers).get('Authorization') ?? '', /q-sign-algorithm=sha1/)
		return new Response(null, { status: 200, headers: { 'Content-Length': '123', 'Content-Type': 'application/epub+zip' } })
	}
	try {
		const { response } = await request(`/${row.id}/complete`, { db, body: { object_key: 'attacker/key.epub' } })
		assert.equal(response.status, 200, await response.clone().text())
		assert.deepEqual(await response.json(), { id: row.id, format: 'epub', verified_size: 123, parse_status: 'ready' })
		assert.equal(calls, 1)
		assert.equal(db.rows.get(`42:${row.id}`)?.verified_size, 123)
		assert.equal(db.rows.get(`42:${row.id}`)?.parse_status, 'ready')
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('complete strictly rejects missing or mismatched COS size and MIME with 422', async () => {
	for (const headResponse of [
		new Response(null, { status: 200, headers: { 'Content-Type': 'application/epub+zip' } }),
		new Response(null, { status: 200, headers: { 'Content-Length': '122', 'Content-Type': 'application/epub+zip' } }),
		new Response(null, { status: 200, headers: { 'Content-Length': '123' } }),
		new Response(null, { status: 200, headers: { 'Content-Length': '123', 'Content-Type': 'text/plain; charset=utf-8' } }),
	]) {
		const row = bookRow()
		const originalFetch = globalThis.fetch
		globalThis.fetch = async () => headResponse
		try {
			const { response } = await request(`/${row.id}/complete`, { db: createDb([row]) })
			assert.equal(response.status, 422)
		} finally {
			globalThis.fetch = originalFetch
		}
	}
})

test('complete maps a missing or inaccessible private COS object to 422', async () => {
	const row = bookRow()
	const originalFetch = globalThis.fetch
	globalThis.fetch = async () => new Response(null, { status: 404 })
	try {
		const { response } = await request(`/${row.id}/complete`, { db: createDb([row]) })
		assert.equal(response.status, 422)
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('complete is idempotent and never repeats HEAD once ready', async () => {
	const row = bookRow()
	const db = createDb([row])
	const originalFetch = globalThis.fetch
	let calls = 0
	globalThis.fetch = async () => {
		calls++
		return new Response(null, { status: 200, headers: { 'Content-Length': '123', 'Content-Type': 'application/epub+zip' } })
	}
	try {
		const first = await request(`/${row.id}/complete`, { db })
		const second = await request(`/${row.id}/complete`, { db })
		assert.equal(first.response.status, 200)
		assert.equal(second.response.status, 200)
		assert.deepEqual(await second.response.json(), await first.response.json())
		assert.equal(calls, 1)
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('download authorization is owner-only, ready-only, and excludes deleted books', async () => {
	for (const [row, sub] of [
		[bookRow({ parse_status: 'pending' }), 42],
		[bookRow({ parse_status: 'ready', verified_size: 123 }), 7],
		[bookRow({ parse_status: 'ready', verified_size: 123, deleted_at: 1 }), 42],
	] as const) {
		const { response } = await request(`/${row.id}/download/authorize`, { db: createDb([row]), sub })
		assert.equal(response.status, 404)
	}
})

test('download authorization returns a short-lived signed GET URL without a public bucket URL', async () => {
	const row = bookRow({ parse_status: 'ready', verified_size: 123 })
	const { response } = await request(`/${row.id}/download/authorize`, { db: createDb([row]) })
	assert.equal(response.status, 200, await response.clone().text())
	const result = await response.json() as Record<string, unknown>
	assert.deepEqual(Object.keys(result).sort(), ['download_url', 'expires_at'])
	assert.match(String(result.download_url), /^https:\/\/private-books-123\.cos\.ap-shanghai\.myqcloud\.com\/novels\/private\/42\/.+\.epub\?q-sign-algorithm=sha1&/)
	assert.equal(String(result.download_url).includes(env.COS_PUBLIC_ORIGIN), false)
	assert.equal(typeof result.expires_at, 'number')
})
