import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { toAccount, toStatus } from './converter.ts'
import {
	IMGBED_FALLBACK_HEADER,
	insertStatusMedia,
	resolveMediaAttachment,
	resolveStatusMedia,
	shouldUseImgbedFallback,
	uploadLegacyMastodonMedia,
} from './routes.ts'

assert.equal(IMGBED_FALLBACK_HEADER, 'X-ABDL-Upload-Fallback')

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
					const results = database.prepare(sql).all(...values) as Record<string, unknown>[]
					return { success: true, results, meta: {} }
				},
				async run() {
					const result = database.prepare(sql).run(...values)
					return { success: true, results: [], meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } }
				},
			} as unknown as D1PreparedStatement
		},
	} as unknown as D1Database
}

function mediaDatabase(): DatabaseSync {
	const database = new DatabaseSync(':memory:')
	database.exec(`
		CREATE TABLE media_uploads (
			id TEXT PRIMARY KEY,
			user_id INTEGER NOT NULL,
			purpose TEXT NOT NULL,
			object_key TEXT NOT NULL,
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
		);
		CREATE TABLE post_images (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			post_id INTEGER NOT NULL,
			image_url TEXT NOT NULL,
			is_nsfw INTEGER DEFAULT 0,
			alt_text TEXT,
			blurhash TEXT,
			preview_url TEXT,
			storage_provider TEXT,
			sort_order INTEGER DEFAULT 0
		);
	`)
	return database
}

function addUpload(database: DatabaseSync, values: {
	id: string
	userId?: number
	purpose?: string
	status?: string
	provider?: string
	previewUrl?: string | null
}): void {
	database.prepare(`
		INSERT INTO media_uploads (
			id, user_id, purpose, object_key, public_url, preview_url, mime_type,
			declared_size, verified_size, width, height, blurhash, storage_provider,
			status, created_at, expires_at
		) VALUES (?, ?, ?, ?, ?, ?, 'image/jpeg', 123, 123, 1200, 800, 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', ?, ?, 1, 9999999999)
	`).run(
		values.id,
		values.userId ?? 42,
		values.purpose ?? 'status_original',
		`media/original/42/${values.id}.jpg`,
		`https://media.example.test/${values.id}.jpg`,
		values.previewUrl === undefined ? `https://media.example.test/${values.id}-preview.jpg` : values.previewUrl,
		values.provider ?? 'cos',
		values.status ?? 'complete',
	)
}

test('resolves complete same-owner COS upload IDs and persists original, preview, provider, and metadata', async () => {
	const database = mediaDatabase()
	addUpload(database, { id: 'complete-cos' })
	const db = d1(database)

	const media = await resolveStatusMedia(db, ['complete-cos'], 42, [{ id: 'complete-cos', description: 'alt' }], {
		cosPublicOrigin: 'https://media.example.test',
	})
	assert.deepEqual(media, [{
		id: 'complete-cos',
		imageUrl: 'https://media.example.test/complete-cos.jpg',
		previewUrl: 'https://media.example.test/complete-cos-preview.jpg',
		storageProvider: 'cos',
		altText: 'alt',
		blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
	}])

	await insertStatusMedia(db, 9, media, 1)
	assert.deepEqual({ ...database.prepare(`
		SELECT image_url, preview_url, storage_provider, alt_text, blurhash, is_nsfw
		FROM post_images WHERE post_id = 9
	`).get()! }, {
		image_url: 'https://media.example.test/complete-cos.jpg',
		preview_url: 'https://media.example.test/complete-cos-preview.jpg',
		storage_provider: 'cos',
		alt_text: 'alt',
		blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
		is_nsfw: 1,
	})
	database.close()
})

test('rejects COS upload IDs that are pending, owned by another user, or have the wrong purpose', async () => {
	const database = mediaDatabase()
	addUpload(database, { id: 'pending', status: 'pending' })
	addUpload(database, { id: 'other-owner', userId: 7 })
	addUpload(database, { id: 'wrong-purpose', purpose: 'generic' })
	const db = d1(database)

	for (const id of ['pending', 'other-owner', 'wrong-purpose']) {
		await assert.rejects(resolveStatusMedia(db, [id], 42, [], { cosPublicOrigin: 'https://media.example.test' }), /media/i)
	}
	database.close()
})

test('accepts historical media URLs as imgbed but rejects arbitrary HTTPS injection', async () => {
	const database = mediaDatabase()
	addUpload(database, { id: 'https://img.abdl-space.top/file/old.jpg', userId: 7, provider: 'imgbed', previewUrl: null })
	const db = d1(database)
	const legacy = await resolveStatusMedia(db, [
		'https://img.abdl-space.top/file/old.jpg',
		'https://cloudflare-imgbed-790.pages.dev/file/older.jpg',
	], 42, [], {})
	assert.deepEqual(legacy.map(item => item.storageProvider), ['imgbed', 'imgbed'])
	await assert.rejects(resolveStatusMedia(db, ['https://attacker.example/image.jpg'], 42, [], {}), /media/i)
	database.close()
})

test('enables imgbed fallback only for the exact fixed header value', () => {
	assert.equal(shouldUseImgbedFallback('imgbed'), true)
	assert.equal(shouldUseImgbedFallback('IMGBED'), false)
	assert.equal(shouldUseImgbedFallback(' Imgbed '), false)
	assert.equal(shouldUseImgbedFallback(undefined), false)
})

test('classifies configured legacy COS URLs as COS and builds a trusted v3 preview', async () => {
	const database = mediaDatabase()
	const db = d1(database)
	const [media] = await resolveStatusMedia(db, [
		'https://media.example.test/media/original/42/legacy.jpg',
	], 42, [], { cosPublicOrigin: 'https://media.example.test' })
	assert.equal(media.storageProvider, 'cos')
	assert.equal(media.previewUrl, null)

	const attachment = await resolveMediaAttachment(db, encodeURIComponent(media.imageUrl), 42, {
		cosPublicOrigin: 'https://media.example.test',
	})
	assert.equal(attachment.storageProvider, 'cos')
	assert.match(attachment.previewUrl, /\/api\/v1\/media\/preview\/v3\//)
	database.close()
})

test('converter uses persisted preview and only falls back to v3 for historical NULL previews', () => {
	const account = toAccount({ id: 42, username: 'tester', avatar: null, role: 'user', created_at: '2026-01-01 00:00:00' })
	const status = toStatus({
		id: 1,
		user_id: 42,
		content: 'media',
		created_at: '2026-01-01 00:00:00',
		images: [
			{ image_url: 'https://media.example.test/original.jpg', preview_url: 'https://media.example.test/preview.jpg', storage_provider: 'cos' },
			{ image_url: 'https://media.example.test/empty-preview.jpg', preview_url: '', storage_provider: 'cos' },
			{ image_url: 'https://img.abdl-space.top/file/legacy.jpg', preview_url: null, storage_provider: 'imgbed' },
		],
	}, account)
	assert.equal(status.media_attachments[0].preview_url, 'https://media.example.test/preview.jpg')
	assert.equal(status.media_attachments[1].preview_url, '')
	assert.match(status.media_attachments[2].preview_url, /\/api\/v1\/media\/preview\/v3\//)
	assert.deepEqual(status.media_attachments[0].meta, {})
})

const tinyPng = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))

function uploadEnv(database: DatabaseSync) {
	return {
		abdl_space_db: d1(database),
		COS_SECRET_ID: 'fake-id',
		COS_SECRET_KEY: 'fake-key',
		COS_BUCKET: 'abdl-1339643562',
		COS_REGION: 'ap-shanghai',
		COS_PUBLIC_ORIGIN: 'https://media.example.test',
		IMGBED_UPLOAD_KEY: 'fake-imgbed-key',
	} as never
}

test('legacy multipart uploads original bytes to COS with overwrite protection and records complete status_original', async () => {
	const database = mediaDatabase()
	const originalFetch = globalThis.fetch
	let request: Request | null = null
	globalThis.fetch = async (input, init) => {
		request = new Request(input, init)
		return new Response(null, { status: 200 })
	}
	try {
		const result = await uploadLegacyMastodonMedia(uploadEnv(database), 42, new File([tinyPng], 'tiny.png', { type: 'image/png' }), 'tiny', false)
		assert.match(result.id, /^[0-9a-f-]{36}$/)
		assert.equal(result.url.startsWith('https://media.example.test/media/original/42/'), true)
		assert.match(result.preview_url, /\/api\/v1\/media\/preview\/v3\//)
		assert.deepEqual(result.meta.original, { width: 1, height: 1, size: '1x1', aspect: 1 })
		assert.equal(request?.method, 'PUT')
		assert.equal(request?.headers.get('content-type'), 'image/png')
		assert.equal(request?.headers.get('x-cos-forbid-overwrite'), 'true')
		assert.deepEqual(new Uint8Array(await request!.arrayBuffer()), tinyPng)
		assert.deepEqual({ ...database.prepare('SELECT purpose, status, storage_provider, preview_url, declared_size, verified_size FROM media_uploads WHERE id = ?').get(result.id)! }, {
			purpose: 'status_original',
			status: 'complete',
			storage_provider: 'cos',
			preview_url: null,
			declared_size: tinyPng.byteLength,
			verified_size: tinyPng.byteLength,
		})
	} finally {
		globalThis.fetch = originalFetch
		database.close()
	}
})

test('COS failure does not fall back to imgbed without the explicit header mode', async () => {
	const database = mediaDatabase()
	const originalFetch = globalThis.fetch
	const urls: string[] = []
	globalThis.fetch = async input => {
		urls.push(String(input))
		return new Response(null, { status: 503 })
	}
	try {
		await assert.rejects(uploadLegacyMastodonMedia(uploadEnv(database), 42, new File([tinyPng], 'tiny.png', { type: 'image/png' }), null, false), /COS PUT failed/)
		assert.equal(urls.some(url => url.includes('img.abdl-space.top')), false)
	} finally {
		globalThis.fetch = originalFetch
		database.close()
	}
})

test('explicit imgbed fallback mode uses the historical upload path and records provider', async () => {
	const database = mediaDatabase()
	const originalFetch = globalThis.fetch
	const methods: string[] = []
	globalThis.fetch = async (input, init) => {
		methods.push(`${init?.method}:${String(input)}`)
		return Response.json([{ src: 'https://img.abdl-space.top/file/fallback.png' }])
	}
	try {
		const result = await uploadLegacyMastodonMedia(uploadEnv(database), 42, new File([tinyPng], 'tiny.png', { type: 'image/png' }), null, true)
		assert.equal(result.id, 'https://img.abdl-space.top/file/fallback.png')
		assert.equal(methods.some(value => value.startsWith('POST:https://img.abdl-space.top/')), true)
		assert.equal(methods.some(value => value.startsWith('PUT:')), false)
		assert.equal(database.prepare('SELECT storage_provider FROM media_uploads').get()?.storage_provider, 'imgbed')
		const resolved = await resolveStatusMedia(d1(database), [result.id], 42, [], {})
		assert.equal(resolved[0].storageProvider, 'imgbed')
	} finally {
		globalThis.fetch = originalFetch
		database.close()
	}
})

test('media attachment update resolves COS upload IDs and legacy URLs with persisted preview behavior', async () => {
	const database = mediaDatabase()
	addUpload(database, { id: 'cos-id' })
	const db = d1(database)
	const cos = await resolveMediaAttachment(db, 'cos-id', 42, { cosPublicOrigin: 'https://media.example.test' })
	assert.equal(cos.url, 'https://media.example.test/cos-id.jpg')
	assert.equal(cos.previewUrl, 'https://media.example.test/cos-id-preview.jpg')
	assert.equal(cos.storageProvider, 'cos')

	const legacy = await resolveMediaAttachment(db, encodeURIComponent('https://img.abdl-space.top/file/legacy.jpg'), 42, {})
	assert.equal(legacy.url, 'https://img.abdl-space.top/file/legacy.jpg')
	assert.match(legacy.previewUrl, /\/api\/v1\/media\/preview\/v3\//)
	assert.equal(legacy.storageProvider, 'imgbed')
	database.close()
})
