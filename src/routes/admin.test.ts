import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { Hono } from 'hono'

import { signJWT } from '../lib/auth.ts'
import { cleanupPrivateNovelObjects } from './novel-private.ts'
import admin from './admin.ts'

test('admin user deletion preserves a permanently monitored private object job', async () => {
	const database = new DatabaseSync(':memory:')
	database.exec('PRAGMA foreign_keys = ON;')
	database.exec(readFileSync(new URL('../../schemas/schema.sql', import.meta.url), 'utf8'))
	database.prepare(`INSERT INTO users (id, email, password_hash, username, role) VALUES
		(1, 'admin@example.test', 'hash', 'admin', 'admin'), (2, 'user@example.test', 'hash', 'user', 'user')`).run()
	database.prepare(`INSERT INTO private_books (
		id, owner_id, title, author, format, object_key, content_hash, content_md5, declared_size,
		verified_size, parse_status, upload_expires_at
	) VALUES ('book', 2, 'Book', 'Author', 'epub', 'novels/private/2/book.epub', ?, ?, 123, 123, 'ready', 1)`)
		.run('a'.repeat(64), 'kAFQmDzST7DWlj99KOF/cg==')
	const db = {
		prepare(sql: string) {
			return {
				bind(...params: unknown[]) {
					return {
						async all() {
							try { return { success: true, results: database.prepare(sql).all(...params) } }
						catch (error) { if (String(error).includes('no such table') || String(error).includes('no such column')) return { success: true, results: [] }; throw error }
						},
						async first() { return database.prepare(sql).get(...params) ?? null },
						async run() {
							try { const result = database.prepare(sql).run(...params); return { success: true, meta: { changes: Number(result.changes) } } }
							catch (error) { if (String(error).includes('no such table') || String(error).includes('no such column')) return { success: true, meta: { changes: 0 } }; throw error }
						},
					}
				},
			}
		},
	}
	const jwtSecret = 'admin-test-secret'
	const token = await signJWT({ sub: 1, username: 'admin', email: 'admin@example.test', role: 'admin' }, jwtSecret)
	const app = new Hono()
	app.route('/api/admin', admin)
	const bindings = {
		JWT_SECRET: jwtSecret,
		abdl_space_db: db,
		NOVEL_COS_SECRET_ID: 'private-id', NOVEL_COS_SECRET_KEY: 'private-key',
		NOVEL_PRIVATE_COS_BUCKET: 'private-bucket-123', NOVEL_PRIVATE_COS_REGION: 'ap-shanghai',
	}
	const deleted = await app.request('/api/admin/users/2', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }, bindings as never)
	assert.equal(deleted.status, 200, await deleted.clone().text())
	assert.equal(database.prepare('SELECT COUNT(*) AS count FROM users WHERE id = 2').get()?.count, 0)
	assert.equal(database.prepare('SELECT object_key FROM novel_object_cleanup_jobs').get()?.object_key, 'novels/private/2/book.epub')

	const originalFetch = globalThis.fetch
	let objectExists = false
	let calls = 0
	globalThis.fetch = async (_input, init) => {
		assert.equal(init?.method, 'DELETE')
		assert.match((init?.headers as Record<string, string>).Authorization, /q-ak=private-id(?:&|$)/)
		calls++
		if (!objectExists) return new Response(null, { status: 404 })
		objectExists = false
		return new Response(null, { status: 204 })
	}
	try {
		assert.equal(await cleanupPrivateNovelObjects(bindings as never, 1, 50), 1)
		assert.equal(database.prepare('SELECT status FROM novel_object_cleanup_jobs').get()?.status, 'monitoring')
		objectExists = true
		assert.equal(await cleanupPrivateNovelObjects(bindings as never, 86_401, 50), 1)
		assert.equal(objectExists, false)
		assert.equal(await cleanupPrivateNovelObjects(bindings as never, 172_801, 50), 1)
		assert.equal(calls, 3)
		assert.equal(database.prepare('SELECT status FROM novel_object_cleanup_jobs').get()?.status, 'monitoring')
	} finally {
		globalThis.fetch = originalFetch
		database.close()
	}
})
