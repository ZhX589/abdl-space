import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { Hono } from 'hono'

import { resolveOptionalProfileImageUpload, resolveProfileImageUpload } from '../mastodon/routes.ts'
import { resolveGenericImageUpload } from './images.ts'
import version, { resolveReleaseUpload } from './version.ts'
import { resolveUserAvatarUpload } from './users.ts'

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
	db.exec(`CREATE TABLE media_uploads (
		id TEXT PRIMARY KEY NOT NULL, user_id INTEGER NOT NULL, purpose TEXT NOT NULL,
		object_key TEXT NOT NULL UNIQUE, public_url TEXT NOT NULL, mime_type TEXT NOT NULL,
		declared_size INTEGER NOT NULL, verified_size INTEGER, width INTEGER, height INTEGER,
		storage_provider TEXT NOT NULL, status TEXT NOT NULL
	)`)
	return db
}

function addUpload(db: DatabaseSync, id: string, purpose: string, userId = 42): void {
	db.prepare(`INSERT INTO media_uploads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cos', 'complete')`).run(
		id,
		userId,
		purpose,
		`${purpose}/42/${id}`,
		`https://media.example.test/${id}`,
		purpose === 'release' ? 'application/vnd.android.package-archive' : 'image/jpeg',
		purpose === 'release' ? 4096 : 123,
		purpose === 'release' ? 4096 : 123,
		purpose === 'release' ? null : 100,
		purpose === 'release' ? null : 80,
	)
}

test('profile image references require the matching completed purpose', async () => {
	const sqlite = database()
	addUpload(sqlite, 'avatar-id', 'avatar')
	addUpload(sqlite, 'header-id', 'header')
	const db = d1(sqlite)

	assert.equal((await resolveProfileImageUpload(db, 'avatar-id', 42, 'avatar')).public_url, 'https://media.example.test/avatar-id')
	assert.equal((await resolveProfileImageUpload(db, 'https://media.example.test/header-id', 42, 'header')).id, 'header-id')
	await assert.rejects(resolveProfileImageUpload(db, 'header-id', 42, 'avatar'), /upload/i)
	sqlite.close()
})

test('the non-Mastodon profile route uses the same completed avatar boundary', async () => {
	const sqlite = database()
	addUpload(sqlite, 'avatar-id', 'avatar')
	addUpload(sqlite, 'generic-id', 'generic')
	const db = d1(sqlite)

	assert.equal((await resolveUserAvatarUpload(db, 'avatar-id', 42)).public_url, 'https://media.example.test/avatar-id')
	await assert.rejects(resolveUserAvatarUpload(db, 'generic-id', 42), /upload/i)
	sqlite.close()
})

test('profile routes keep explicit empty avatar and header values available for clearing', async () => {
	const sqlite = database()
	const db = d1(sqlite)
	assert.equal(await resolveOptionalProfileImageUpload(db, '', 42, 'avatar'), '')
	assert.equal(await resolveOptionalProfileImageUpload(db, null, 42, 'header'), '')
	sqlite.close()
})

test('generic image references require completed generic uploads owned by the caller', async () => {
	const sqlite = database()
	addUpload(sqlite, 'generic-id', 'generic')
	addUpload(sqlite, 'other-id', 'generic', 7)
	const db = d1(sqlite)

	assert.equal((await resolveGenericImageUpload(db, 'generic-id', 42)).public_url, 'https://media.example.test/generic-id')
	await assert.rejects(resolveGenericImageUpload(db, 'other-id', 42), /upload/i)
	sqlite.close()
})

test('version publishing consumes only completed release uploads and verified size', async () => {
	const sqlite = database()
	addUpload(sqlite, 'release-id', 'release')
	addUpload(sqlite, 'generic-id', 'generic')
	const db = d1(sqlite)

	const release = await resolveReleaseUpload(db, 'release-id', 42)
	assert.equal(release.public_url, 'https://media.example.test/release-id')
	assert.equal(release.verified_size, 4096)
	await assert.rejects(resolveReleaseUpload(db, 'generic-id', 42), /upload/i)
	sqlite.close()
})

test('version publishing anonymously uploads APK files to the legacy imgbed distribution', async () => {
	const app = new Hono()
	app.route('/api/v1/version', version)
	const sqlite = database()
	const originalFetch = globalThis.fetch
	let uploadUrl = ''
	globalThis.fetch = async input => {
		uploadUrl = String(input)
		return Response.json([{ src: 'https://img.abdl-space.top/file/apk/app.apk' }])
	}
	try {
		const form = new FormData()
		form.append('apk', new File([new Uint8Array([1, 2, 3])], 'app.apk', { type: 'application/vnd.android.package-archive' }))
		form.append('versionName', '2.4.0')
		form.append('versionCode', '22')
		form.append('changelog', '提升图片上传与图片加载速度')
		const response = await app.request('/api/v1/version/upload', { method: 'POST', body: form }, {
			IMGBED_UPLOAD_KEY: 'test-key',
			abdl_space_db: d1(sqlite),
		} as never)
		assert.equal(response.status, 200, await response.clone().text())
		assert.equal(uploadUrl, 'https://img.abdl-space.top/upload?returnFormat=full&uploadFolder=apk&uploadChannel=huggingface&channelName=abdl-space-img&autoRetry=false')
		assert.deepEqual(await response.json(), {
			success: true,
			versionName: '2.4.0',
			versionCode: 22,
			downloadUrl: 'https://img.abdl-space.top/file/apk/app.apk',
			message: '版本更新成功',
		})
		const stored = sqlite.prepare("SELECT value FROM kv_store WHERE key = 'app_version_latest'").get() as { value: string }
		const storedVersion = JSON.parse(stored.value)
		assert.equal(typeof storedVersion.releasedAt, 'string')
		delete storedVersion.releasedAt
		assert.deepEqual(storedVersion, {
			versionName: '2.4.0',
			versionCode: 22,
			downloadUrl: 'https://img.abdl-space.top/file/apk/app.apk',
			changelog: '提升图片上传与图片加载速度',
			apkSize: 3,
		})
	} finally {
		globalThis.fetch = originalFetch
		sqlite.close()
	}
})

test('version publishing accepts the current imgbed object response', async () => {
	const app = new Hono()
	app.route('/api/v1/version', version)
	const sqlite = database()
	const originalFetch = globalThis.fetch
	globalThis.fetch = async () => Response.json({ src: 'https://img.abdl-space.top/file/apk/current.apk' })
	try {
		const form = new FormData()
		form.append('apk', new File([new Uint8Array([1])], 'app.apk', { type: 'application/vnd.android.package-archive' }))
		form.append('versionName', '2.4.0')
		form.append('versionCode', '22')
		const response = await app.request('/api/v1/version/upload', { method: 'POST', body: form }, {
			IMGBED_UPLOAD_KEY: 'test-key',
			abdl_space_db: d1(sqlite),
		} as never)
		assert.equal(response.status, 200, await response.clone().text())
		assert.equal((await response.json() as { downloadUrl: string }).downloadUrl, 'https://img.abdl-space.top/file/apk/current.apk')
	} finally {
		globalThis.fetch = originalFetch
		sqlite.close()
	}
})

test('version publishing reports all imgbed authentication failure statuses', async () => {
	const app = new Hono()
	app.route('/api/v1/version', version)
	const sqlite = database()
	const originalFetch = globalThis.fetch
	globalThis.fetch = async () => new Response('Unauthorized', { status: 401 })
	try {
		const form = new FormData()
		form.append('apk', new File([new Uint8Array([1])], 'app.apk', { type: 'application/vnd.android.package-archive' }))
		form.append('versionName', '2.4.0')
		form.append('versionCode', '22')
		const response = await app.request('/api/v1/version/upload', { method: 'POST', body: form }, {
			IMGBED_UPLOAD_KEY: 'stale-key',
			abdl_space_db: d1(sqlite),
		} as never)
		assert.equal(response.status, 502)
		assert.deepEqual(await response.json(), { error: 'APK 上传失败', upstream_statuses: [401, 401, 401] })
	} finally {
		globalThis.fetch = originalFetch
		sqlite.close()
	}
})
