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

test('version publishing rejects unauthenticated arbitrary APK URLs before database writes', async () => {
	const app = new Hono()
	app.route('/api/v1/version', version)
	const response = await app.request('/api/v1/version/upload', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			versionName: '9.9.9',
			versionCode: 999,
			apkUrl: 'https://attacker.example/app.apk',
		}),
	}, { JWT_SECRET: 'test-secret', abdl_space_db: d1(database()) } as never)
	assert.equal(response.status, 401)
})
