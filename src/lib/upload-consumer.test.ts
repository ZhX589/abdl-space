import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
	deleteCompletedUpload,
	getCompletedUpload,
	getCompletedUploadReference,
	uploadLegacyObject,
} from './upload-consumer.ts'

function d1(database: DatabaseSync): D1Database {
	return {
		prepare(sql: string) {
			let values: unknown[] = []
			return {
				bind(...params: unknown[]) {
					values = params
					return this
				},
				async all() {
					return { success: true, results: database.prepare(sql).all(...values), meta: {} }
				},
				async run() {
					const result = database.prepare(sql).run(...values)
					return { success: true, results: [], meta: { changes: result.changes } }
				},
			} as unknown as D1PreparedStatement
		},
	} as unknown as D1Database
}

function database(): DatabaseSync {
	const db = new DatabaseSync(':memory:')
	db.exec(`
		CREATE TABLE media_uploads (
			id TEXT PRIMARY KEY NOT NULL,
			user_id INTEGER NOT NULL,
			purpose TEXT NOT NULL,
			object_key TEXT NOT NULL UNIQUE,
			public_url TEXT NOT NULL,
			preview_upload_id TEXT,
			preview_object_key TEXT,
			preview_url TEXT,
			mime_type TEXT NOT NULL,
			declared_size INTEGER NOT NULL,
			verified_size INTEGER,
			width INTEGER,
			height INTEGER,
			blurhash TEXT,
			storage_provider TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL
		)
	`)
	return db
}

function addUpload(db: DatabaseSync, overrides: Record<string, unknown> = {}): string {
	const id = String(overrides.id ?? crypto.randomUUID())
	db.prepare(`INSERT INTO media_uploads (
		id, user_id, purpose, object_key, public_url, mime_type, declared_size,
		verified_size, width, height, storage_provider, status, created_at, expires_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 9999999999)`).run(
		id,
		overrides.user_id ?? 42,
		overrides.purpose ?? 'generic',
		overrides.object_key ?? `generic/42/${id}.jpg`,
		overrides.public_url ?? `https://media.example.test/${id}.jpg`,
		overrides.mime_type ?? 'image/jpeg',
		overrides.declared_size ?? 123,
		overrides.verified_size === undefined ? 123 : overrides.verified_size,
		overrides.width === undefined ? 100 : overrides.width,
		overrides.height === undefined ? 80 : overrides.height,
		overrides.storage_provider ?? 'cos',
		overrides.status ?? 'complete',
	)
	return id
}

test('consumes only completed owned uploads with the requested purpose', async () => {
	const sqlite = database()
	const valid = addUpload(sqlite)
	const wrongOwner = addUpload(sqlite, { user_id: 7 })
	const wrongPurpose = addUpload(sqlite, { purpose: 'avatar' })
	const pending = addUpload(sqlite, { status: 'pending', verified_size: null })
	const db = d1(sqlite)

	assert.equal((await getCompletedUpload(db, valid, 42, 'generic')).public_url, `https://media.example.test/${valid}.jpg`)
	for (const id of [wrongOwner, wrongPurpose, pending]) {
		await assert.rejects(getCompletedUpload(db, id, 42, 'generic'), /upload/i)
	}
	sqlite.close()
})

test('resolves completed uploads by either ID or their exact public URL', async () => {
	const sqlite = database()
	const id = addUpload(sqlite, { purpose: 'avatar' })
	const db = d1(sqlite)
	const url = `https://media.example.test/${id}.jpg`

	assert.equal((await getCompletedUploadReference(db, id, 42, 'avatar')).id, id)
	assert.equal((await getCompletedUploadReference(db, url, 42, 'avatar')).id, id)
	await assert.rejects(getCompletedUploadReference(db, 'https://attacker.example/avatar.jpg', 42, 'avatar'), /upload/i)
	sqlite.close()
})

test('legacy upload defaults to COS and only uses imgbed when explicitly selected', async () => {
	const sqlite = database()
	const env = {
		abdl_space_db: d1(sqlite),
		COS_SECRET_ID: 'fake-id',
		COS_SECRET_KEY: 'fake-key',
		COS_BUCKET: 'test-bucket-123',
		COS_REGION: 'ap-shanghai',
		COS_PUBLIC_ORIGIN: 'https://media.example.test',
		IMGBED_UPLOAD_KEY: 'fake-imgbed-key',
	} as never
	const file = new File([Uint8Array.from([1, 2, 3])], 'app.apk', { type: 'application/vnd.android.package-archive' })
	const originalFetch = globalThis.fetch
	const requests: string[] = []
	globalThis.fetch = async (input, init) => {
		requests.push(`${init?.method}:${String(input)}`)
		if (String(input).includes('img.abdl-space.top')) return Response.json([{ src: 'https://img.abdl-space.top/file/app.apk' }])
		return new Response(null, { status: 200 })
	}
	try {
		const cos = await uploadLegacyObject(env, 42, 'release', file, false)
		assert.equal(cos.storage_provider, 'cos')
		assert.equal(requests.some(value => value.startsWith('PUT:')), true)
		assert.equal(requests.some(value => value.includes('img.abdl-space.top')), false)

		requests.length = 0
		const imgbed = await uploadLegacyObject(env, 42, 'release', file, true)
		assert.equal(imgbed.storage_provider, 'imgbed')
		assert.equal(requests.some(value => value.startsWith('POST:https://img.abdl-space.top/')), true)
		assert.equal(requests.some(value => value.startsWith('PUT:')), false)
	} finally {
		globalThis.fetch = originalFetch
		sqlite.close()
	}
})

test('explicit imgbed fallback retries with the legacy authCode mode', async () => {
	const sqlite = database()
	const env = {
		abdl_space_db: d1(sqlite),
		COS_SECRET_ID: 'fake-id',
		COS_SECRET_KEY: 'fake-key',
		COS_BUCKET: 'test-bucket-123',
		COS_REGION: 'ap-shanghai',
		COS_PUBLIC_ORIGIN: 'https://media.example.test',
		IMGBED_UPLOAD_KEY: 'fake-imgbed-key',
	} as never
	const file = new File([Uint8Array.from([1, 2, 3])], 'app.apk', { type: 'application/vnd.android.package-archive' })
	const originalFetch = globalThis.fetch
	const urls: string[] = []
	globalThis.fetch = async input => {
		urls.push(String(input))
		if (urls.length === 1) return new Response(null, { status: 401 })
		return Response.json([{ src: 'https://img.abdl-space.top/file/app.apk' }])
	}
	try {
		const upload = await uploadLegacyObject(env, 42, 'release', file, true)
		assert.equal(upload.storage_provider, 'imgbed')
		assert.equal(urls.length, 2)
		assert.match(urls[1], /authCode=fake-imgbed-key/)
	} finally {
		globalThis.fetch = originalFetch
		sqlite.close()
	}
})

test('deletes only owned completed COS uploads', async () => {
	const sqlite = database()
	const id = addUpload(sqlite)
	const db = d1(sqlite)
	const originalFetch = globalThis.fetch
	let method = ''
	globalThis.fetch = async (_input, init) => {
		method = init?.method ?? ''
		return new Response(null, { status: 204 })
	}
	try {
		await deleteCompletedUpload({
			db,
			id,
			userId: 42,
			purpose: 'generic',
			cos: { secretId: 'fake-id', secretKey: 'fake-key', bucket: 'test-bucket-123', region: 'ap-shanghai' },
		})
		assert.equal(method, 'DELETE')
		assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM media_uploads WHERE id = ?').get(id)?.count, 0)
	} finally {
		globalThis.fetch = originalFetch
		sqlite.close()
	}
})

test('keeps a completed upload record when COS deletion fails', async () => {
	const sqlite = database()
	const id = addUpload(sqlite)
	const db = d1(sqlite)
	const originalFetch = globalThis.fetch
	globalThis.fetch = async () => new Response(null, { status: 503 })
	try {
		await assert.rejects(deleteCompletedUpload({
			db,
			id,
			userId: 42,
			purpose: 'generic',
			cos: { secretId: 'fake-id', secretKey: 'fake-key', bucket: 'test-bucket-123', region: 'ap-shanghai' },
		}), /COS DELETE failed/)
		assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM media_uploads WHERE id = ?').get(id)?.count, 1)
	} finally {
		globalThis.fetch = originalFetch
		sqlite.close()
	}
})
