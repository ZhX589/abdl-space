import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import test from 'node:test'

import { Hono } from 'hono'

import { signJWT } from '../lib/auth.ts'
import { cleanupPrivateNovelObjects } from './novel-private.ts'
import admin from './admin.ts'
import type { AdminUserDetailResponse, AdminUserListResponse } from '../types/index.ts'

function readSQL(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

test('admin user deletion preserves a permanently monitored private object job', async () => {
	const database = new DatabaseSync(':memory:')
	database.exec('PRAGMA foreign_keys = ON;')
	database.exec(readSQL('../../schemas/schema.sql'))
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

test('admin can explicitly set and clear post NSFW state with image synchronization', async () => {
	const database = new DatabaseSync(':memory:')
	database.exec('PRAGMA foreign_keys = ON;')
	database.exec(readSQL('../../schemas/schema.sql'))
	database.prepare(`INSERT INTO users (id, email, password_hash, username, role) VALUES
		(1, 'admin@example.test', 'hash', 'admin', 'admin'), (2, 'user@example.test', 'hash', 'user', 'user')`).run()
	database.prepare(`INSERT INTO posts (id, user_id, content, has_nsfw) VALUES
		(10, 2, 'with image', 0), (11, 2, 'without image', 0)`).run()
	database.prepare("INSERT INTO post_images (post_id, image_url, is_nsfw) VALUES (10, 'https://example.test/1.jpg', 0), (10, 'https://example.test/2.jpg', 0)").run()

	function statement(sql: string, params: unknown[] = []) {
		return {
			bind(...bound: unknown[]) { return statement(sql, bound) },
			async all() { return { success: true, results: database.prepare(sql).all(...params) } },
			async first() { return database.prepare(sql).get(...params) ?? null },
			async run() {
				const result = database.prepare(sql).run(...params)
				return { success: true, meta: { changes: Number(result.changes) } }
			},
		}
	}
	const db = {
		prepare(sql: string) { return statement(sql) },
		async batch(statements: { run: () => Promise<unknown> }[]) {
			return Promise.all(statements.map(item => item.run()))
		},
	}
	const jwtSecret = 'admin-nsfw-test-secret'
	const token = await signJWT({ sub: 1, username: 'admin', email: 'admin@example.test', role: 'admin' }, jwtSecret)
	const app = new Hono()
	app.route('/api/admin', admin)
	const bindings = { JWT_SECRET: jwtSecret, abdl_space_db: db } as never
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

	const invalidId = await app.request('/api/admin/posts/nope/nsfw', { method: 'PATCH', headers, body: JSON.stringify({ has_nsfw: true }) }, bindings)
	assert.equal(invalidId.status, 400)
	const invalidBody = await app.request('/api/admin/posts/10/nsfw', { method: 'PATCH', headers, body: JSON.stringify({ has_nsfw: 1 }) }, bindings)
	assert.equal(invalidBody.status, 400)
	const missing = await app.request('/api/admin/posts/999/nsfw', { method: 'PATCH', headers, body: JSON.stringify({ has_nsfw: true }) }, bindings)
	assert.equal(missing.status, 404)

	const marked = await app.request('/api/admin/posts/10/nsfw', { method: 'PATCH', headers, body: JSON.stringify({ has_nsfw: true }) }, bindings)
	assert.equal(marked.status, 200, await marked.clone().text())
	assert.deepEqual(await marked.json(), { has_nsfw: true })
	assert.equal(database.prepare('SELECT has_nsfw FROM posts WHERE id = 10').get()?.has_nsfw, 1)
	assert.deepEqual(
		database.prepare('SELECT DISTINCT is_nsfw FROM post_images WHERE post_id = 10').all().map(row => ({ is_nsfw: Number(row.is_nsfw) })),
		[{ is_nsfw: 1 }],
	)

	const cleared = await app.request('/api/admin/posts/10/nsfw', { method: 'PATCH', headers, body: JSON.stringify({ has_nsfw: false }) }, bindings)
	assert.equal(cleared.status, 200, await cleared.clone().text())
	assert.deepEqual(await cleared.json(), { has_nsfw: false })
	assert.equal(database.prepare('SELECT has_nsfw FROM posts WHERE id = 10').get()?.has_nsfw, 0)
	assert.deepEqual(
		database.prepare('SELECT DISTINCT is_nsfw FROM post_images WHERE post_id = 10').all().map(row => ({ is_nsfw: Number(row.is_nsfw) })),
		[{ is_nsfw: 0 }],
	)

	const noImage = await app.request('/api/admin/posts/11/nsfw', { method: 'PATCH', headers, body: JSON.stringify({ has_nsfw: true }) }, bindings)
	assert.equal(noImage.status, 200, await noImage.clone().text())
	assert.equal(database.prepare('SELECT has_nsfw FROM posts WHERE id = 11').get()?.has_nsfw, 1)
	database.close()
})

// Strict D1 adapter: execute real SQLite SQL; never swallow missing tables/columns or failed queries.
async function adminUsersFixture(optionalColumns = true) {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  database.exec(readSQL('../../schemas/schema.sql'))
  database.exec(readSQL('../../migrations/0025_account_system_upgrade.sql'))
  if (optionalColumns) database.exec('ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0; ALTER TABLE users ADD COLUMN has_app INTEGER DEFAULT 0;')
  database.exec(`INSERT INTO users(id,email,password_hash,username,role) VALUES
    (1,'admin@example.test','hash','admin','admin'),
    (2,'bound@example.test','hash','target_bound','user'),
    (3,'unbound@example.test','hash','target_unbound','user'),
    (4,'admin2@example.test','hash','admin2','admin'),
    (5,'identityonly@example.test','hash','identityonly','user');`)
  for (const [id, hmac] of [[2, 'a'], [4, 'b'], [5, 'c']] as const) {
    database.prepare('INSERT INTO qq_identities(unionid_hmac,user_id) VALUES (?,?)').run(hmac.repeat(64), id)
  }
  // Multiple subjects must not duplicate rows; identity-only users are still bound.
  for (const appId of ['1905661071', '1905661072']) {
    database.prepare('INSERT INTO qq_app_subjects(app_id,openid_hmac,unionid_hmac) VALUES (?,?,?)').run(appId, 'd'.repeat(64), 'a'.repeat(64))
  }
  // Orphan subjects (allowed by schema) are NOT a user binding.
  database.prepare('INSERT INTO qq_app_subjects(app_id,openid_hmac,unionid_hmac) VALUES (?,?,?)').run('1905661071', 'e'.repeat(64), 'f'.repeat(64))
  database.exec("INSERT INTO posts(user_id,content) VALUES (2,'post'); INSERT INTO daily_checkins(user_id,checkin_date) VALUES (2,'2026-10-03');")
  const controls: { qqFailure?: 'throw' | 'unsuccessful' | 'null' | 'missing' } = {}
  const queries: { sql: string; params: unknown[] }[] = []
  function statement(sql: string, params: SQLInputValue[] = []) {
    return {
      bind: (...next: SQLInputValue[]) => statement(sql, next),
      async all() {
        queries.push({ sql, params })
        const rows = database.prepare(sql).all(...params)
        if (sql.includes('qq_identities')) {
          if (controls.qqFailure === 'throw') throw new Error('QQ query failed')
          if (controls.qqFailure === 'unsuccessful') return { success: false, results: [] }
          if (sql.includes('AS qq_bound') && controls.qqFailure) {
            for (const row of rows) {
              if (controls.qqFailure === 'null') row.qq_bound = null
              if (controls.qqFailure === 'missing') delete row.qq_bound
            }
          }
        }
        return { success: true, results: rows }
      },
    }
  }
  const env = { abdl_space_db: { prepare: (sql: string) => statement(sql) }, JWT_SECRET: 'admin-users-test-secret' }
  const app = new Hono()
  app.onError((_error, c) => c.json({ error: 'Internal server error' }, 500))
  app.route('/api/admin', admin)
  const token = await signJWT({ sub: 1, username: 'admin', email: 'admin@example.test', role: 'admin' }, env.JWT_SECRET)
  const request = (path: string) => app.request(`/api/admin${path}`, { headers: { Authorization: `Bearer ${token}` } }, env as never)
  return { database, request, controls, queries }
}

async function userList(fixture: Awaited<ReturnType<typeof adminUsersFixture>>, query = '') {
  const response = await fixture.request(`/users${query}`)
  const text = await response.text()
  assert.equal(response.status, 200, text)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.doesNotMatch(text, /unionid|openid|hmac|access_token|refresh_token|app_id|password_hash/i)
  for (const hmac of ['a', 'b', 'c', 'd', 'e', 'f']) assert.ok(!text.includes(hmac.repeat(64)))
  return JSON.parse(text) as AdminUserListResponse
}

async function userDetail(fixture: Awaited<ReturnType<typeof adminUsersFixture>>, id: number) {
  const response = await fixture.request(`/users/${id}/detail`)
  const text = await response.text()
  assert.equal(response.status, 200, text)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.doesNotMatch(text, /unionid|openid|hmac|access_token|refresh_token|app_id|password_hash/i)
  return JSON.parse(text) as AdminUserDetailResponse
}

for (const optionalColumns of [true, false]) {
  test(`admin list/detail return minimized QQ booleans from identities (optional columns=${optionalColumns})`, async () => {
    const fixture = await adminUsersFixture(optionalColumns)
    try {
      const list = await userList(fixture)
      assert.deepEqual(list.users.map(user => [user.id, user.qq_bound]), [[5, true], [4, true], [3, false], [2, true], [1, false]])
      assert.deepEqual(list.pagination, { page: 1, limit: 20, total: 5, totalPages: 1 })
      for (const user of list.users) {
        assert.equal(typeof user.qq_bound, 'boolean')
        assert.equal((await userDetail(fixture, user.id)).user.qq_bound, user.qq_bound)
      }
      assert.equal(list.users.find(user => user.id === 2)?.post_count, 1)
      assert.equal(list.users.find(user => user.id === 2)?.checkin_count, 1)
      // The app-subject table is not even needed for these endpoints.
      fixture.database.exec('DROP TABLE qq_app_subjects')
      assert.equal((await userList(fixture, '?qq_bound=bound')).pagination.total, 3)
      assert.equal((await userDetail(fixture, 5)).user.qq_bound, true)
      assert.equal((await fixture.request('/users/999/detail')).status, 404)
    } finally { fixture.database.close() }
  })
}

test('admin QQ filters align rows, total, pagination, role and search without duplicate subjects', async () => {
  const fixture = await adminUsersFixture()
  try {
    for (const [filter, ids] of [['bound', [5, 4, 2]], ['unbound', [3, 1]]] as const) {
      const pages = []
      for (const [index, id] of ids.entries()) {
        const body = await userList(fixture, `?qq_bound=${filter}&limit=1&page=${index + 1}`)
        assert.deepEqual(body.users.map(user => user.id), [id])
        assert.deepEqual(body.pagination, { page: index + 1, limit: 1, total: ids.length, totalPages: ids.length })
        assert.equal(body.users[0].qq_bound, filter === 'bound')
        pages.push(body.users[0].id)
      }
      assert.deepEqual(pages, [...ids])
    }
    assert.deepEqual((await userList(fixture, '?qq_bound=bound&role=user&q=target')).users.map(user => user.id), [2])
    assert.equal((await userList(fixture, '?qq_bound=bound&role=user&q=target')).pagination.total, 1)
    assert.deepEqual((await userList(fixture, '?qq_bound=unbound&role=user&q=target')).users.map(user => user.id), [3])
    assert.equal((await userList(fixture, '?qq_bound=bound&role=admin')).pagination.total, 1)
    assert.equal((await userList(fixture, '?qq_bound=unbound&role=admin')).pagination.total, 1)
    const empty = await userList(fixture, '?q=no-match&qq_bound=bound')
    assert.deepEqual(empty.users, [])
    assert.deepEqual(empty.pagination, { page: 1, limit: 20, total: 0, totalPages: 0 })
    const beyond = await userList(fixture, '?qq_bound=bound&page=4&limit=1')
    assert.deepEqual(beyond.users, [])
    assert.equal(beyond.pagination.total, 3)
    const injection = "' OR 1=1 --"
    assert.equal((await userList(fixture, `?q=${encodeURIComponent(injection)}`)).pagination.total, 0)
    assert.ok(fixture.queries.some(query => query.params.includes(`%${injection}%`)))
    assert.ok(fixture.queries.every(query => !query.sql.includes(injection)))
    // Actual binding removal must immediately change both list and detail, even with leftover subjects.
    fixture.database.prepare('DELETE FROM qq_identities WHERE user_id=?').run(2)
    assert.equal((await userDetail(fixture, 2)).user.qq_bound, false)
    assert.equal((await userList(fixture, '?qq_bound=bound')).pagination.total, 2)
    assert.deepEqual((await userList(fixture, '?qq_bound=unbound')).users.map(user => user.id), [3, 2, 1])
  } finally { fixture.database.close() }
})

test('admin users reject invalid pagination/filter/id values instead of silently coercing them', async () => {
  const fixture = await adminUsersFixture()
  try {
    for (const parameter of ['page', 'limit']) {
      for (const value of ['', '0', '-1', '1.5', '1x', 'NaN', 'Infinity', '01', '+1', ' 1', '1e2', '9007199254740992']) {
        const response = await fixture.request(`/users?${parameter}=${encodeURIComponent(value)}`)
        assert.equal(response.status, 400, `${parameter}=${value}`)
        assert.equal(typeof (await response.json() as { error: unknown }).error, 'string')
      }
    }
    for (const query of ['limit=101', 'page=9007199254740991&limit=100', 'qq_bound=', 'qq_bound=true', 'qq_bound=all', 'qq_bound=Bound', 'qq_bound=%20bound', 'role=owner', 'role=%20user']) {
      assert.equal((await fixture.request(`/users?${query}`)).status, 400, query)
    }
    for (const id of ['0', '-1', '1x', '1.5', '01', '9007199254740992']) {
      assert.equal((await fixture.request(`/users/${id}/detail`)).status, 400, id)
    }
    assert.equal((await userList(fixture, '?page=1&limit=100&role=')).pagination.limit, 100)
  } finally { fixture.database.close() }
})

test('admin users do not fake unbound state when QQ query fails or status is unknown', async () => {
  const fixture = await adminUsersFixture()
  try {
    for (const failure of ['throw', 'unsuccessful', 'null', 'missing'] as const) {
      fixture.controls.qqFailure = failure
      for (const path of ['/users', '/users?qq_bound=bound', '/users?qq_bound=unbound', '/users/2/detail', '/users/3/detail']) {
        const response = await fixture.request(path)
        assert.equal(response.status, 500, `${failure} ${path}`)
        assert.doesNotMatch(await response.text(), /qq_bound|unionid|openid|hmac/i)
      }
    }
    delete fixture.controls.qqFailure
    fixture.database.exec('DROP TABLE qq_identities')
    for (const path of ['/users', '/users?qq_bound=unbound', '/users/2/detail']) {
      assert.equal((await fixture.request(path)).status, 500, path)
    }
  } finally { fixture.database.close() }
})
