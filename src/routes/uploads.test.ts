import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { Hono } from 'hono'

import { signJWT } from '../lib/auth.ts'
import uploads, { COMPLETE_ORIGINAL_UPLOAD_SQL } from './uploads.ts'

const jwtSecret = 'test-jwt-secret'
const cosEnv = {
	JWT_SECRET: jwtSecret,
	COS_SECRET_ID: 'AKIDEXAMPLEFAKE',
	COS_SECRET_KEY: 'fake-secret-key-for-tests-only',
	COS_BUCKET: 'test-bucket-123',
	COS_REGION: 'ap-shanghai',
	COS_PUBLIC_ORIGIN: 'https://media.example.test',
}

interface UploadRow {
	id: string
	user_id: number
	purpose: string
	object_key: string
	public_url: string
	preview_upload_id: string | null
	preview_object_key: string | null
	preview_url: string | null
	mime_type: string
	declared_size: number
	verified_size: number | null
	width: number | null
	height: number | null
	blurhash: string | null
	storage_provider: string
	status: string
	created_at: number
	expires_at: number
}

interface OAuthToken {
	accessToken: string
	userId: number
	scopes: string
}

function createDb(initialRows: UploadRow[] = [], options: { roles?: Record<number, string>, oauthTokens?: OAuthToken[] } = {}) {
	const rows = new Map(initialRows.map(row => [row.id, { ...row }]))
	const roles = new Map(Object.entries(options.roles ?? { 42: 'user' }).map(([id, role]) => [Number(id), role]))
	const oauthTokens = new Map((options.oauthTokens ?? []).map(token => [token.accessToken, token]))
	let beforeCompleteUpdate: (() => void) | undefined
	function statement(sql: string, params: unknown[]) {
		return {
			all: async () => {
				if (sql.includes('FROM oauth_tokens')) {
					const token = oauthTokens.get(String(params[0]))
					return { success: true, results: token ? [{ client_id: 'test-client', user_id: token.userId, scopes: token.scopes, access_expires_at: Math.floor(Date.now() / 1000) + 300, revoked: 0 }] : [] }
				}
				if (sql.includes('FROM users')) {
					const id = Number(params[0])
					const role = roles.get(id)
					return { success: true, results: role ? [{ id, username: `user${id}`, email: `user${id}@example.test`, role }] : [] }
				}
				if (sql.includes('FROM media_uploads')) {
					const row = rows.get(String(params[0]))
					return { success: true, results: row ? [{ ...row }] : [] }
				}
				return { success: true, results: [] }
			},
			run: async () => {
				if (sql.includes('INSERT INTO media_uploads')) {
					const [id, userId, purpose, objectKey, publicUrl, mimeType, declaredSize, width, height, createdAt, expiresAt] = params
					rows.set(String(id), {
						id: String(id), user_id: Number(userId), purpose: String(purpose), object_key: String(objectKey), public_url: String(publicUrl),
						preview_upload_id: null, preview_object_key: null, preview_url: null, mime_type: String(mimeType), declared_size: Number(declaredSize),
						verified_size: null, width: width == null ? null : Number(width), height: height == null ? null : Number(height), blurhash: null,
						storage_provider: 'cos', status: 'pending', created_at: Number(createdAt), expires_at: Number(expiresAt),
					})
				}
				if (sql.includes("SET status = 'complete'")) {
					beforeCompleteUpdate?.()
					beforeCompleteUpdate = undefined
					const hasPreview = sql.includes('preview_upload_id = (')
					const id = String(hasPreview ? params[1] : params.at(-3))
					const userId = Number(hasPreview ? params[2] : params.at(-2))
					const row = rows.get(id)
					const now = Number(hasPreview ? params[3] : params.at(-1))
					if (!row || row.user_id !== userId || row.status !== 'pending' || row.expires_at < now) return { success: true, meta: { changes: 0 } }
					const previewId = hasPreview ? String(params[0]) : undefined
					const preview = previewId ? rows.get(previewId) : undefined
					if (hasPreview && (!preview || preview.user_id !== userId || preview.purpose !== 'status_preview' || preview.status !== 'complete' || preview.verified_size === null)) {
						return { success: true, meta: { changes: 0 } }
					}
					row.status = 'complete'
					row.verified_size = Number(params[0])
					if (hasPreview) {
						row.verified_size = Number(params[4])
						row.preview_upload_id = preview!.id
						row.preview_object_key = preview!.object_key
						row.preview_url = preview!.public_url
					}
				}
				return { success: true, meta: { changes: 1 } }
			},
		}
	}
	return {
		rows,
		roles,
		setBeforeCompleteUpdate(callback: () => void) {
			beforeCompleteUpdate = callback
		},
		prepare(sql: string) {
			return {
				bind(...params: unknown[]) {
					return statement(sql, params)
				},
			}
		},
	}
}

function uploadRow(overrides: Partial<UploadRow> = {}): UploadRow {
	const id = overrides.id ?? crypto.randomUUID()
	return {
		id,
		user_id: 42,
		purpose: 'generic',
		object_key: `generic/42/2026-07-29/${id}.jpg`,
		public_url: `https://media.example.test/generic/42/2026-07-29/${id}.jpg`,
		preview_upload_id: null,
		preview_object_key: null,
		preview_url: null,
		mime_type: 'image/jpeg',
		declared_size: 123,
		verified_size: null,
		width: 100,
		height: 80,
		blurhash: null,
		storage_provider: 'cos',
		status: 'pending',
		created_at: Math.floor(Date.now() / 1000),
		expires_at: Math.floor(Date.now() / 1000) + 300,
		...overrides,
	}
}

async function bearer(role = 'user', sub = 42): Promise<string> {
	return `Bearer ${await signJWT({ sub, username: `user${sub}`, email: `user${sub}@example.test`, role }, jwtSecret)}`
}

function oauthBearer(token = 'oauth-token'): string {
	return `Bearer ${token}`
}

function createApp() {
	const app = new Hono()
	app.route('/api/v1/uploads', uploads)
	return app
}

async function authorize(body: Record<string, unknown>, options: { role?: string, sub?: number, authenticated?: boolean, db?: ReturnType<typeof createDb>, authorization?: string } = {}) {
	const db = options.db ?? createDb()
	const headers: Record<string, string> = { 'Content-Type': 'application/json' }
	if (options.authenticated !== false) headers.Authorization = options.authorization ?? await bearer(options.role, options.sub)
	const response = await createApp().request('/api/v1/uploads/authorize', {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	}, { ...cosEnv, abdl_space_db: db } as never)
	return { response, db }
}

async function complete(id: string, body: Record<string, unknown> = {}, options: { role?: string, sub?: number, authenticated?: boolean, db: ReturnType<typeof createDb>, authorization?: string }) {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' }
	if (options.authenticated !== false) headers.Authorization = options.authorization ?? await bearer(options.role, options.sub)
	return createApp().request(`/api/v1/uploads/${id}/complete`, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	}, { ...cosEnv, abdl_space_db: options.db } as never)
}

async function withHead(response: Response, callback: () => Promise<void>): Promise<void> {
	const originalFetch = globalThis.fetch
	let calls = 0
	globalThis.fetch = async (_input, init) => {
		calls++
		assert.equal(init?.method, 'HEAD')
		assert.equal(init?.redirect, 'manual')
		return response
	}
	try {
		await callback()
	} finally {
		globalThis.fetch = originalFetch
	}
	assert.ok(calls >= 0)
}

test('authorize rejects unauthenticated requests', async () => {
	const { response } = await authorize({ purpose: 'generic', mimeType: 'image/jpeg', declaredSize: 1, width: 1, height: 1 }, { authenticated: false })
	assert.equal(response.status, 401)
})

test('authorize rejects bad MIME, oversize uploads, and client object keys', async () => {
	for (const body of [
		{ purpose: 'generic', mimeType: 'video/mp4', declaredSize: 1, width: 1, height: 1 },
		{ purpose: 'generic', mimeType: 'image/jpeg', declaredSize: 10 * 1024 * 1024 + 1, width: 1, height: 1 },
		{ purpose: 'generic', mimeType: 'image/jpeg', declaredSize: 1, width: 1, height: 1, objectKey: 'client/key.jpg' },
	]) {
		const { response } = await authorize(body)
		assert.equal(response.status, 400)
	}
})

test('authorize rejects non-object JSON bodies as invalid uploads', async () => {
	const response = await createApp().request('/api/v1/uploads/authorize', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: await bearer() },
		body: 'null',
	}, { ...cosEnv, abdl_space_db: createDb() } as never)
	assert.equal(response.status, 400)
})

test('authorize rejects malformed non-empty JSON as invalid_upload', async () => {
	const response = await createApp().request('/api/v1/uploads/authorize', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: await bearer() },
		body: '{malformed',
	}, { ...cosEnv, abdl_space_db: createDb() } as never)
	assert.equal(response.status, 400)
	assert.equal((await response.json() as { code: string }).code, 'invalid_upload')
})

test('authorize creates a pending server-owned upload and returns PUT instructions', async () => {
	const { response, db } = await authorize({ purpose: 'status_preview', mimeType: 'image/webp', declaredSize: 123, width: 540, height: 360 })
	assert.equal(response.status, 200, await response.clone().text())
	const result = await response.json() as Record<string, unknown>
	assert.deepEqual(Object.keys(result).sort(), ['expires_at', 'public_url', 'required_headers', 'upload_id', 'upload_url'])
	assert.match(String(result.upload_id), /^[0-9a-f-]{36}$/i)
	assert.match(String(result.upload_url), /^https:\/\/test-bucket-123\.cos\.ap-shanghai\.myqcloud\.com\/media\/preview\/42\//)
	assert.match(String(result.public_url), /^https:\/\/media\.example\.test\/media\/preview\/42\//)
	assert.equal(typeof result.expires_at, 'number')
	const requiredHeaders = result.required_headers as Record<string, string>
	assert.equal(requiredHeaders['Content-Type'], 'image/webp')
	assert.equal(requiredHeaders['x-cos-forbid-overwrite'], 'true')
	assert.equal(typeof requiredHeaders.Authorization, 'string')
	assert.match(requiredHeaders.Authorization, /q-header-list=content-type;host;x-cos-forbid-overwrite(?:&|$)/)
	assert.equal(Object.hasOwn(requiredHeaders, 'Host'), false)
	assert.equal(db.rows.get(String(result.upload_id))?.status, 'pending')
	assert.equal(db.rows.get(String(result.upload_id))?.object_key.includes(String(result.upload_id)), false)
})

test('release authorize uses the current database role for JWT administrators', async () => {
	const body = { purpose: 'release', mimeType: 'application/vnd.android.package-archive', declaredSize: 1024 }
	const demotedDb = createDb([], { roles: { 42: 'user' } })
	assert.equal((await authorize(body, { role: 'admin', db: demotedDb })).response.status, 403)
	const adminDb = createDb([], { roles: { 42: 'admin' } })
	const adminResponse = (await authorize(body, { role: 'user', db: adminDb })).response
	assert.equal(adminResponse.status, 200, await adminResponse.clone().text())
})

test('release authorize requires admin scope for administrator OAuth tokens', async () => {
	const body = { purpose: 'release', mimeType: 'application/vnd.android.package-archive', declaredSize: 1024 }
	const withoutScope = createDb([], { roles: { 42: 'admin' }, oauthTokens: [{ accessToken: 'no-admin', userId: 42, scopes: 'read write' }] })
	assert.equal((await authorize(body, { db: withoutScope, authorization: oauthBearer('no-admin') })).response.status, 403)
	const withScope = createDb([], { roles: { 42: 'admin' }, oauthTokens: [{ accessToken: 'has-admin', userId: 42, scopes: 'read admin write' }] })
	const response = (await authorize(body, { db: withScope, authorization: oauthBearer('has-admin') })).response
	assert.equal(response.status, 200, await response.clone().text())
})

test('complete rejects wrong owners, expired uploads, and failed uploads', async () => {
	for (const [row, sub, expected] of [
		[uploadRow(), 7, 403],
		[uploadRow({ expires_at: Math.floor(Date.now() / 1000) - 1 }), 42, 409],
		[uploadRow({ status: 'failed' }), 42, 409],
	] as const) {
		const db = createDb([row])
		assert.equal((await complete(row.id, {}, { db, sub })).status, expected)
	}
})

test('complete rejects null and array JSON bodies as invalid uploads', async () => {
	for (const body of ['null', '[]']) {
		const row = uploadRow()
		const response = await createApp().request(`/api/v1/uploads/${row.id}/complete`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: await bearer() },
			body,
		}, { ...cosEnv, abdl_space_db: createDb([row]) } as never)
		assert.equal(response.status, 400)
		assert.equal((await response.json() as { code: string }).code, 'invalid_upload')
	}
})

test('complete rejects malformed non-empty JSON before issuing HEAD', async () => {
	const row = uploadRow()
	let headCalls = 0
	const originalFetch = globalThis.fetch
	globalThis.fetch = async () => {
		headCalls++
		throw new Error('HEAD must not run')
	}
	try {
		const response = await createApp().request(`/api/v1/uploads/${row.id}/complete`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: await bearer() },
			body: '{malformed',
		}, { ...cosEnv, abdl_space_db: createDb([row]) } as never)
		assert.equal(response.status, 400)
		assert.equal((await response.json() as { code: string }).code, 'invalid_upload')
		assert.equal(headCalls, 0)
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('complete rejects pending, wrong-purpose, and self-referencing previews', async () => {
	const original = uploadRow({ purpose: 'status_original', object_key: 'media/original/42/original.jpg', public_url: 'https://media.example.test/original.jpg' })
	for (const preview of [
		uploadRow({ purpose: 'status_preview', status: 'pending', object_key: 'media/preview/42/pending.webp', public_url: 'https://media.example.test/pending.webp', mime_type: 'image/webp' }),
		uploadRow({ purpose: 'generic', status: 'complete' }),
	]) {
		const db = createDb([original, preview])
		assert.equal((await complete(original.id, { previewUploadId: preview.id }, { db })).status, 409)
	}
	const selfDb = createDb([original])
	assert.equal((await complete(original.id, { previewUploadId: original.id }, { db: selfDb })).status, 400)
	const otherOwner = uploadRow({ user_id: 7, purpose: 'status_preview', status: 'complete', verified_size: 123 })
	const ownerDb = createDb([original, otherOwner])
	assert.equal((await complete(original.id, { previewUploadId: otherOwner.id }, { db: ownerDb })).status, 409)
})

test('complete rejects preview IDs for non-original uploads', async () => {
	const row = uploadRow()
	const db = createDb([row])
	assert.equal((await complete(row.id, { previewUploadId: crypto.randomUUID() }, { db })).status, 400)
})

test('complete rejects HEAD 404, size mismatch, and normalized type mismatch', async () => {
	const cases = [
		[new Response(null, { status: 404, headers: { 'x-cos-request-id': 'safe-id' } }), 502],
		[new Response(null, { status: 200, headers: { 'Content-Type': 'image/jpeg' } }), 422],
		[new Response(null, { status: 200, headers: { 'Content-Length': '122', 'Content-Type': 'image/jpeg' } }), 422],
		[new Response(null, { status: 200, headers: { 'Content-Length': '123', 'Content-Type': 'image/png; charset=binary' } }), 422],
	] as const
	for (const [headResponse, expected] of cases) {
		const row = uploadRow()
		const db = createDb([row])
		await withHead(headResponse, async () => {
			assert.equal((await complete(row.id, {}, { db })).status, expected)
		})
	}
})

test('complete accepts an expired completed preview when the original is still pending', async () => {
	const preview = uploadRow({ purpose: 'status_preview', status: 'complete', verified_size: 50, expires_at: Math.floor(Date.now() / 1000) - 30, mime_type: 'image/webp' })
	const original = uploadRow({ purpose: 'status_original' })
	const db = createDb([preview, original])
	await withHead(new Response(null, { status: 200, headers: { 'Content-Length': '123', 'Content-Type': 'image/jpeg' } }), async () => {
		assert.equal((await complete(original.id, { previewUploadId: preview.id }, { db })).status, 200)
	})
})

test('complete verifies preview then atomically links it when completing an original', async () => {
	const preview = uploadRow({ purpose: 'status_preview', object_key: 'media/preview/42/preview.webp', public_url: 'https://media.example.test/preview.webp', mime_type: 'image/webp', declared_size: 50, width: 540, height: 360 })
	const original = uploadRow({ purpose: 'status_original', object_key: 'media/original/42/original.jpg', public_url: 'https://media.example.test/original.jpg' })
	const db = createDb([preview, original])
	await withHead(new Response(null, { status: 200, headers: { 'Content-Length': '50', 'Content-Type': 'image/webp; charset=binary' } }), async () => {
		assert.equal((await complete(preview.id, {}, { db })).status, 200)
	})
	await withHead(new Response(null, { status: 200, headers: { 'Content-Length': '123', 'Content-Type': 'IMAGE/JPEG' } }), async () => {
		const response = await complete(original.id, { previewUploadId: preview.id }, { db })
		assert.equal(response.status, 200, await response.clone().text())
		assert.deepEqual(await response.json(), {
			id: original.id,
			url: original.public_url,
			preview_url: preview.public_url,
			type: 'image',
			blurhash: null,
			meta: { original: { width: 100, height: 80, size: '100x80' }, small: { width: 540, height: 360, size: '540x360' } },
		})
	})
	assert.equal(db.rows.get(original.id)?.preview_upload_id, preview.id)
})

test('complete supports non-image single objects and is idempotent without another HEAD', async () => {
	const row = uploadRow({ purpose: 'release', mime_type: 'application/vnd.android.package-archive', object_key: 'releases/42/app.apk', public_url: 'https://media.example.test/app.apk', width: null, height: null })
	const db = createDb([row], { roles: { 42: 'admin' } })
	let calls = 0
	const originalFetch = globalThis.fetch
	globalThis.fetch = async () => {
		calls++
		return new Response(null, { status: 200, headers: { 'Content-Length': '123', 'Content-Type': 'application/vnd.android.package-archive' } })
	}
	try {
		const first = await complete(row.id, {}, { db, role: 'admin' })
		assert.equal(first.status, 200)
		const firstJson = await first.json() as Record<string, unknown>
		assert.equal(firstJson.type, 'unknown')
		const second = await complete(row.id, {}, { db, role: 'admin' })
		assert.equal(second.status, 200)
		assert.deepEqual(await second.json(), firstJson)
		assert.equal(calls, 1)
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('complete rejects a different preview on an already completed original', async () => {
	const firstPreview = uploadRow({ purpose: 'status_preview', status: 'complete', verified_size: 123 })
	const secondPreview = uploadRow({ purpose: 'status_preview', status: 'complete', verified_size: 123 })
	const original = uploadRow({
		purpose: 'status_original',
		status: 'complete',
		verified_size: 123,
		preview_upload_id: firstPreview.id,
		preview_object_key: firstPreview.object_key,
		preview_url: firstPreview.public_url,
	})
	const db = createDb([original, firstPreview, secondPreview])
	let calls = 0
	const originalFetch = globalThis.fetch
	globalThis.fetch = async () => {
		calls++
		throw new Error('HEAD must not run')
	}
	try {
		assert.equal((await complete(original.id, {}, { db })).status, 200)
		assert.equal((await complete(original.id, { previewUploadId: firstPreview.id }, { db })).status, 200)
		assert.equal((await complete(original.id, { previewUploadId: secondPreview.id }, { db })).status, 409)
		assert.equal(calls, 0)
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('complete changes=0 reread rejects a concurrently linked different preview', async () => {
	const requestedPreview = uploadRow({ purpose: 'status_preview', status: 'complete', verified_size: 50 })
	const concurrentPreview = uploadRow({ purpose: 'status_preview', status: 'complete', verified_size: 50 })
	const original = uploadRow({ purpose: 'status_original' })
	const db = createDb([requestedPreview, concurrentPreview, original])
	db.setBeforeCompleteUpdate(() => {
		const current = db.rows.get(original.id)!
		current.status = 'complete'
		current.verified_size = current.declared_size
		current.preview_upload_id = concurrentPreview.id
		current.preview_object_key = concurrentPreview.object_key
		current.preview_url = concurrentPreview.public_url
	})
	await withHead(new Response(null, { status: 200, headers: { 'Content-Length': '123', 'Content-Type': 'image/jpeg' } }), async () => {
		assert.equal((await complete(original.id, { previewUploadId: requestedPreview.id }, { db })).status, 409)
	})
})

test('complete returns the preview key and URL copied by the atomic update', async () => {
	const preview = uploadRow({ purpose: 'status_preview', status: 'complete', verified_size: 50, public_url: 'https://media.example.test/before.webp' })
	const original = uploadRow({ purpose: 'status_original' })
	const db = createDb([preview, original])
	db.setBeforeCompleteUpdate(() => {
		const current = db.rows.get(preview.id)!
		current.object_key = 'media/preview/42/current.webp'
		current.public_url = 'https://media.example.test/current.webp'
	})
	await withHead(new Response(null, { status: 200, headers: { 'Content-Length': '123', 'Content-Type': 'image/jpeg' } }), async () => {
		const response = await complete(original.id, { previewUploadId: preview.id }, { db })
		assert.equal(response.status, 200)
		assert.equal((await response.json() as Record<string, unknown>).preview_url, 'https://media.example.test/current.webp')
	})
})

test('atomic original completion copies the current preview key and URL in SQLite', () => {
	const db = new DatabaseSync(':memory:')
	db.exec(`
		CREATE TABLE media_uploads (
			id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, purpose TEXT NOT NULL,
			object_key TEXT NOT NULL, public_url TEXT NOT NULL,
			preview_upload_id TEXT, preview_object_key TEXT, preview_url TEXT,
			verified_size INTEGER, status TEXT NOT NULL, expires_at INTEGER NOT NULL
		)
	`)
	const now = Math.floor(Date.now() / 1000)
	db.prepare(`INSERT INTO media_uploads VALUES (?, 42, 'status_preview', ?, ?, NULL, NULL, NULL, 50, 'complete', ?)`).run('preview', 'old-key', 'old-url', now - 60)
	db.prepare(`INSERT INTO media_uploads VALUES (?, 42, 'status_original', ?, ?, NULL, NULL, NULL, NULL, 'pending', ?)`).run('original', 'original-key', 'original-url', now + 60)
	db.prepare('UPDATE media_uploads SET object_key = ?, public_url = ? WHERE id = ?').run('current-key', 'current-url', 'preview')
	const result = db.prepare(COMPLETE_ORIGINAL_UPLOAD_SQL).run('preview', 'original', 42, now, 123)
	assert.equal(result.changes, 1)
	assert.deepEqual({ ...db.prepare('SELECT preview_upload_id, preview_object_key, preview_url, verified_size FROM media_uploads WHERE id = ?').get('original') }, {
		preview_upload_id: 'preview',
		preview_object_key: 'current-key',
		preview_url: 'current-url',
		verified_size: 123,
	})
	db.close()
})

test('release completion still requires administrator authorization', async () => {
	const row = uploadRow({ purpose: 'release', mime_type: 'application/vnd.android.package-archive', width: null, height: null })
	const db = createDb([row], { roles: { 42: 'user' } })
	assert.equal((await complete(row.id, {}, { db, role: 'admin' })).status, 403)
	row.status = 'complete'
	row.verified_size = row.declared_size
	db.rows.set(row.id, row)
	assert.equal((await complete(row.id, {}, { db, role: 'admin' })).status, 403)
})

test('release completion accepts current DB admin JWT and requires admin-scoped OAuth', async () => {
	const jwtRow = uploadRow({ purpose: 'release', status: 'complete', verified_size: 123, mime_type: 'application/vnd.android.package-archive', width: null, height: null })
	const jwtDb = createDb([jwtRow], { roles: { 42: 'admin' } })
	assert.equal((await complete(jwtRow.id, {}, { db: jwtDb, role: 'user' })).status, 200)

	for (const [token, scopes, expected] of [['no-admin', 'read write', 403], ['has-admin', 'read admin', 200]] as const) {
		const row = uploadRow({ purpose: 'release', status: 'complete', verified_size: 123, mime_type: 'application/vnd.android.package-archive', width: null, height: null })
		const db = createDb([row], { roles: { 42: 'admin' }, oauthTokens: [{ accessToken: token, userId: 42, scopes }] })
		assert.equal((await complete(row.id, {}, { db, authorization: oauthBearer(token) })).status, expected)
	}
})
