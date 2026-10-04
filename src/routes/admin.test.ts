import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import test from 'node:test'

import { Hono } from 'hono'

import { signJWT } from '../lib/auth.ts'
import { cleanupPrivateNovelObjects } from './novel-private.ts'
import admin from './admin.ts'
import auth from './auth.ts'
import friendRequests from './friend_requests.ts'
import { authMiddleware, adminMiddleware } from '../middleware/auth.ts'
import { mastodonAuthDetails } from '../mastodon/shared.ts'
import { cacheSet, cacheClear } from '../lib/ttl-cache.ts'
import { getCachedIpBan, getCachedTrackingRule } from '../lib/ip-security-cache.ts'
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
		async batch(statements: { run: () => Promise<{ success: boolean }> }[]) {
			database.exec('BEGIN')
			try {
				const results = []
				for (const statement of statements) results.push(await statement.run())
				database.exec('COMMIT')
				return results
			} catch (error) { database.exec('ROLLBACK'); throw error }
		},
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

// Feature fixture executes the actual route SQL with foreign keys and atomic SQLite batches.
// Legacy production tables absent from the complete schema are explicit here, not silently ignored.
async function securityFixture(bannedColumn = true) {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  database.exec(readSQL('../../schemas/schema.sql'))
  for (const file of ['0025_account_system_upgrade.sql', 'oauth.sql', '0020_content_api_keys.sql', 'captcha_api_keys.sql', '0023_key_split.sql', '0029_qr_login_sessions.sql', '0031_lan_heartbeats.sql', '0032_notifications_actor_id.sql', '0056_ip_tracking_and_bans.sql', '0060_admin_ops.sql']) {
    database.exec(readSQL(`../../migrations/${file}`))
  }
  database.exec(`ALTER TABLE users ADD COLUMN nbw_uid INTEGER;
    ALTER TABLE users ADD COLUMN nbw_username TEXT;
    ALTER TABLE users ADD COLUMN is_beta_user INTEGER DEFAULT 0;
    CREATE TABLE comment_images(id INTEGER PRIMARY KEY, comment_id INTEGER REFERENCES post_comments(id), image_url TEXT);
    CREATE TABLE reports(id INTEGER PRIMARY KEY, reporter_id INTEGER REFERENCES users(id), resolved_by INTEGER REFERENCES users(id));
    CREATE TABLE markers(user_id INTEGER REFERENCES users(id), timeline TEXT, last_read_id TEXT);`)
  if (bannedColumn) database.exec('ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0')
  database.exec(`INSERT INTO users(id,email,password_hash,username,role) VALUES
    (1,'root@example.test','hash','root','admin'), (2,'admin2@example.test','hash','admin2','admin'),
    (3,'user3@example.test','hash','user3','user'), (4,'user4@example.test','hash','user4','user');`)
  const controls: {
    beforeBatch?: () => void; beforeSQL?: (sql: string) => void;
    failSQL?: string; unsuccessful?: boolean; failBatchAt?: number; unsuccessfulBatch?: boolean; batchError?: string
  } = {}
  const statements: string[] = []
  function statement(sql: string, params: SQLInputValue[] = []) {
    const check = () => {
      statements.push(sql)
      controls.beforeSQL?.(sql)
      if (controls.failSQL && sql.includes(controls.failSQL)) throw new Error('Injected DB failure')
    }
    return {
      bind: (...bound: SQLInputValue[]) => statement(sql, bound),
      async all() {
        check()
        if (controls.unsuccessful) return { success: false, results: [] }
        return { success: true, results: database.prepare(sql).all(...params) }
      },
      async run() {
        check()
        const row = database.prepare(sql).run(...params)
        return { success: true, results: [], meta: { changes: Number(row.changes) } }
      },
    }
  }
  const db = {
    prepare: (sql: string) => statement(sql),
    async batch(items: ReturnType<typeof statement>[]) {
      controls.beforeBatch?.()
      delete controls.beforeBatch
      database.exec('BEGIN')
      try {
        const results = []
        for (const [index, item] of items.entries()) {
          if (index === controls.failBatchAt) throw new Error('Injected batch failure')
          results.push(await item.all()) // SELECT guards must actually be evaluated.
        }
        if (controls.unsuccessfulBatch || results.some(result => !result.success)) {
          database.exec('ROLLBACK')
          return results.map(() => ({ success: false, results: [] }))
        }
        database.exec('COMMIT')
        return results
      } catch (error) { controls.batchError = String(error); database.exec('ROLLBACK'); throw error }
    },
  }
  const env = { abdl_space_db: db, JWT_SECRET: 'super-admin-test-secret' }
  const app = new Hono<{ Variables: { user: import('../types/index.ts').JWTPayload } }>()
  app.onError((_error, c) => c.json({ error: 'Internal server error' }, 500))
  app.route('/api/admin', admin)
  app.route('/api/auth', auth)
  app.route('/api/friend-request', friendRequests)
  app.get('/session', authMiddleware, c => c.json(c.get('user')))
  app.get('/admin-session', adminMiddleware, c => c.json(c.get('user')))
  const tokens = new Map<number, string>()
  for (const [sub, role] of [[1, 'admin'], [2, 'admin'], [3, 'user'], [4, 'user']] as const) {
    tokens.set(sub, await signJWT({ sub, username: `old${sub}`, email: `old${sub}@example.test`, role }, env.JWT_SECRET))
  }
  const request = (path: string, method = 'GET', body?: unknown, actor = 1, headers: Record<string, string> = {}) =>
    app.request(path, { method, headers: { Authorization: `Bearer ${tokens.get(actor)}`, 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env as never, { waitUntil: () => {} } as never)
  const snapshot = () => JSON.stringify(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(row => [row.name, database.prepare(`SELECT * FROM "${String(row.name)}" ORDER BY rowid`).all()]))
  const oauth = (id: number, scopes = 'read write admin', token = `oauth-${id}`) => {
    database.prepare('INSERT INTO oauth_tokens(access_token,client_id,user_id,scopes,access_expires_at,created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(token, 'fixture-client', id, scopes, Math.floor(Date.now() / 1000) + 300, Math.floor(Date.now() / 1000))
    return token
  }
  const details = (token: string) => mastodonAuthDetails({ env: env as never, req: { header: name => name === 'Authorization' ? `Bearer ${token}` : undefined } })
  return { database, db, env, app, request, snapshot, controls, statements, tokens, oauth, details }
}

function seedCleanup(f: Awaited<ReturnType<typeof securityFixture>>, id = 3) {
  f.database.prepare("INSERT INTO posts(id,user_id,content) VALUES (30,?,'target'),(40,4,'other')").run(id)
  f.database.prepare("INSERT INTO post_comments(id,post_id,user_id,parent_id,content) VALUES (30,40,?,NULL,'target'),(31,40,4,30,'reply'),(32,30,4,NULL,'on target post')").run(id)
  f.database.exec("INSERT INTO comment_images(comment_id,image_url) VALUES (30,'image'); INSERT INTO likes(user_id,target_type,target_id) VALUES (4,'comment',30); INSERT INTO post_views(post_id,user_id,viewed_at) VALUES (30,4,1)")
  f.database.prepare("INSERT INTO friend_requests(id,user_id,title,looking_for) VALUES (30,?,'target','friends'),(40,4,'other','friends')").run(id)
  f.database.prepare("INSERT INTO friend_request_comments(id,request_id,user_id,parent_id,content) VALUES (30,40,?,NULL,'target'),(31,40,4,30,'reply'),(32,30,4,NULL,'on target request')").run(id)
  f.database.exec("INSERT INTO friend_request_reports(id,request_id,reporter_id,reason) VALUES (30,30,4,'reason'); INSERT INTO ip_tracking_events(user_id,ip,path,created_at) VALUES (3,'203.0.113.30','/api',1)")
  f.database.prepare('INSERT INTO points(user_id,balance) VALUES (?,10)').run(id)
  f.database.prepare("INSERT INTO wiki_pages(title,slug,content,author_id) VALUES ('keep','keep','keep',?)").run(id)
}

function seedReport(f: Awaited<ReturnType<typeof securityFixture>>, target: number) {
  f.database.prepare("INSERT INTO friend_requests(id,user_id,title,looking_for,status) VALUES (30,?,'target','friends','reported')").run(target)
  f.database.exec("INSERT INTO friend_request_reports(id,request_id,reporter_id,reason) VALUES (30,30,4,'reason')")
}

for (const legacy of [false, true]) test(`only live id1 super-admin can change roles; role remains App compatible (legacy=${legacy})`, async () => {
  const f = await securityFixture(!legacy)
  try {
    for (const actor of [2, 3]) {
      const before = f.snapshot()
      assert.equal((await f.request('/api/admin/add', 'POST', { user_ids: [3] }, actor)).status, 403)
      assert.equal((await f.request('/api/admin/users/2/role', 'PATCH', { role: 'user' }, actor)).status, 403)
      assert.equal(f.snapshot(), before)
    }
    assert.equal((await f.request('/api/admin/users/1/role', 'PATCH', { role: 'user' })).status, 403)
    assert.deepEqual(await (await f.request('/api/admin/users/1/role', 'PATCH', { role: 'admin' })).json(), { id: 1, role: 'admin', is_super_admin: true })
    const promoted = await f.request('/api/admin/add', 'POST', { user_ids: [2, 3, 999] })
    assert.equal(promoted.status, 200)
    assert.deepEqual(await promoted.json(), { promoted: 1, message: '1 个用户已提升为管理员' })
    assert.deepEqual(await (await f.request('/api/admin/add', 'POST', { user_ids: [3] })).json(), { promoted: 0, message: '0 个用户已提升为管理员' })
    const demoted = await f.request('/api/admin/users/2/role', 'PATCH', { role: 'user' })
    assert.equal(demoted.status, 200)
    assert.deepEqual(await demoted.json(), { id: 2, role: 'user', is_super_admin: false })
    assert.equal(demoted.headers.get('Cache-Control'), 'private, no-store')
    assert.equal((await f.request('/api/admin/users/999/role', 'PATCH', { role: 'user' })).status, 404)
    f.database.exec("UPDATE users SET role='user' WHERE id=1")
    assert.equal((await f.request('/api/admin/add', 'POST', { user_ids: [4] })).status, 403)
  } finally { f.database.close() }
})

test('role JSON, ids, origin, cookie fallback and OAuth scopes are fail-closed without writes', async () => {
  const f = await securityFixture()
  try {
    const before = f.snapshot()
    for (const body of [null, [], {}, { role: 'super_admin' }, { role: 'admin', extra: true }, { role: true }]) {
      assert.equal((await f.request('/api/admin/users/2/role', 'PATCH', body)).status, 400)
    }
    for (const id of ['0', '01', '-1', '2x', '2.5', '9007199254740992']) assert.equal((await f.request(`/api/admin/users/${id}/role`, 'PATCH', { role: 'user' })).status, 400)
    for (const ids of [[], [3, 3], ['3'], [0], [-1], [2.5], [9007199254740992], Array.from({ length: 101 }, (_, i) => i + 1)]) {
      assert.equal((await f.request('/api/admin/add', 'POST', { user_ids: ids })).status, 400)
    }
    const rejectedHeaders: Record<string, string>[] = [ { 'Content-Type': 'text/plain' }, { Origin: 'https://evil.test' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }, { Authorization: '', Cookie: `token=${f.tokens.get(1)}` }, { Authorization: 'Bearer invalid', Cookie: `token=${f.tokens.get(1)}` } ]
    for (const headers of rejectedHeaders) {
      const result = await f.request('/api/admin/users/2/role', 'PATCH', { role: 'user' }, 1, headers)
      assert.ok([403, 415].includes(result.status), await result.text())
    }
    assert.equal(f.snapshot(), before)
    assert.equal((await f.request('/api/admin/users/2/role', 'PATCH', { role: 'admin' }, 1, { Authorization: '', Cookie: `token=${f.tokens.get(1)}`, Origin: 'https://m.abdl-space.top' })).status, 200)
    for (const scopes of ['read', 'write', 'admin', 'read write']) {
      const token = f.oauth(1, scopes, `oauth-${scopes}`)
      assert.equal((await f.request('/api/admin/users/2/role', 'PATCH', { role: 'user' }, 1, { Authorization: `Bearer ${token}` })).status, 403)
    }
    const token = f.oauth(1, 'read,write,admin', 'oauth-scoped')
    assert.equal((await f.request('/api/admin/users/2/role', 'PATCH', { role: 'user' }, 1, { Authorization: `Bearer ${token}` })).status, 200)
    const malformed = await f.app.request('/api/admin/add', { method: 'POST', headers: { Authorization: `Bearer ${f.tokens.get(1)}`, 'Content-Type': 'application/json' }, body: '{' }, f.env as never)
    assert.equal(malformed.status, 400)
  } finally { f.database.close() }
})

test('auth/me, admin list/detail derive super flag from DB and banned state with no sensitive leakage', async () => {
  const f = await securityFixture()
  try {
    const me = await f.request('/api/auth/me')
    assert.equal(me.status, 200, await me.clone().text())
    assert.equal(me.headers.get('Cache-Control'), 'private, no-store')
    const text = await me.text()
    const body = JSON.parse(text) as { role: string; is_super_admin: boolean }
    assert.equal(body.role, 'admin'); assert.equal(body.is_super_admin, true)
    assert.doesNotMatch(text, /password_hash/)
    const rows = await (await f.request('/api/admin/users', 'GET', undefined, 2)).json() as AdminUserListResponse
    assert.deepEqual(rows.users.map(row => [row.id, row.role, row.is_super_admin]), [[4, 'user', false], [3, 'user', false], [2, 'admin', false], [1, 'admin', true]])
    f.database.exec('UPDATE users SET banned=1 WHERE id=1')
    const detail = await (await f.request('/api/admin/users/1/detail', 'GET', undefined, 2)).json() as AdminUserDetailResponse
    assert.equal(detail.user.is_super_admin, false)
    const bannedRows = await (await f.request('/api/admin/users', 'GET', undefined, 2)).json() as AdminUserListResponse
    assert.equal(bannedRows.users.find(row => row.id === 1)?.is_super_admin, false)
    assert.equal((await f.request('/api/auth/me')).status, 403)
    assert.equal((await f.request('/api/admin/add', 'POST', { user_ids: [3] })).status, 403)
  } finally { f.database.close() }
})

test('old JWT and OAuth cache cannot retain admin after demotion; middleware context role refreshes', async () => {
  const f = await securityFixture()
  cacheClear()
  try {
    const oauth = f.oauth(2)
    assert.equal((await f.details(oauth))?.user.role, 'admin')
    cacheSet('user:2', { id: 2, username: 'cached', email: 'cached@example.test', role: 'admin' }, 60_000)
    assert.equal((await f.request('/admin-session', 'GET', undefined, 2)).status, 200)
    assert.equal((await f.request('/api/admin/users/2/role', 'PATCH', { role: 'user' })).status, 200)
    for (const token of [f.tokens.get(2)!, oauth]) {
      assert.equal((await f.request('/admin-session', 'GET', undefined, 2, { Authorization: `Bearer ${token}` })).status, 403)
      const current = await (await f.request('/session', 'GET', undefined, 2, { Authorization: `Bearer ${token}` })).json() as { role: string; is_super_admin: boolean }
      assert.equal(current.role, 'user'); assert.equal(current.is_super_admin, false)
      assert.equal((await f.details(token))?.user.role, 'user')
    }
    f.database.exec('UPDATE users SET banned=1 WHERE id=2')
    assert.equal(await f.details(oauth), null)
    assert.equal(await f.details(f.tokens.get(2)!), null)
    assert.equal((await f.request('/session', 'GET', undefined, 2)).status, 403)
    f.database.exec('DELETE FROM users WHERE id=2')
    assert.equal((await f.request('/admin-session', 'GET', undefined, 2)).status, 401)
    assert.equal(await f.details(oauth), null)
  } finally { cacheClear(); f.database.close() }
})

test('administrators and reserved id1 cannot be deleted, banned, tracked, email blocked or accepted via friend reports', async () => {
  for (const target of [1, 2]) {
    const f = await securityFixture()
    try {
      seedReport(f, target)
      const before = f.snapshot()
      for (const [path, method, body] of [
        [`/api/admin/users/${target}`, 'DELETE', undefined], [`/api/admin/users/${target}/ban`, 'POST', undefined],
        [`/api/admin/security/users/${target}/track-and-ban`, 'POST', undefined],
        ['/api/admin/blocked-emails', 'POST', { email: target === 1 ? ' ROOT@EXAMPLE.TEST ' : 'admin2@example.test' }],
        ['/api/friend-request/admin/reports/30/accept', 'POST', undefined],
      ] as const) {
        const res = await f.request(path, method, body)
        assert.ok([400, 403].includes(res.status), `${path} ${res.status}`)
        assert.equal(f.snapshot(), before, path)
      }
      // Reserved id1 remains protected if an external misconfiguration removes its role.
      if (target === 1) {
        f.database.exec("UPDATE users SET role='user' WHERE id=1")
        assert.equal((await f.request('/api/admin/users/1/ban', 'POST', undefined, 2)).status, 403)
        assert.equal((await f.request('/api/admin/users/1', 'DELETE', undefined, 2)).status, 403)
      }
    } finally { f.database.close() }
  }
})

test('demote first then ordinary user deletion preserves nested cleanup and private monitoring job', async () => {
  const f = await securityFixture()
  try {
    assert.equal((await f.request('/api/admin/users/2/role', 'PATCH', { role: 'user' })).status, 200)
    seedCleanup(f, 2)
    f.database.prepare(`INSERT INTO private_books(id,owner_id,title,author,format,object_key,content_hash,content_md5,declared_size,verified_size,parse_status,upload_expires_at)
      VALUES ('book',2,'Book','Author','epub','novels/private/2/book.epub',?,?,123,123,'ready',1)`).run('a'.repeat(64), 'kAFQmDzST7DWlj99KOF/cg==')
    const res = await f.request('/api/admin/users/2', 'DELETE')
    assert.equal(res.status, 200, `${await res.clone().text()} ${f.controls.batchError ?? ''}`)
    assert.equal(f.database.prepare('SELECT id FROM users WHERE id=2').get(), undefined)
    for (const table of ['post_comments', 'friend_request_comments', 'friend_request_reports', 'comment_images', 'likes', 'post_views']) {
      assert.equal(f.database.prepare(`SELECT COUNT(*) n FROM ${table}`).get()?.n, 0, table)
    }
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM posts').get()?.n, 1)
    assert.equal(f.database.prepare('SELECT author_id FROM wiki_pages').get()?.author_id, null)
    assert.equal(f.database.prepare('SELECT object_key FROM novel_object_cleanup_jobs').get()?.object_key, 'novels/private/2/book.epub')
    assert.deepEqual(f.database.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { f.database.close() }
})

for (const operation of ['delete', 'track', 'accept'] as const) {
  for (const race of ['promote-target', 'demote-actor', 'ban-actor', 'late-failure', 'unsuccessful'] as const) {
    test(`${operation} transaction guard/rollback prevents all effects on ${race}`, async () => {
      const f = await securityFixture()
      cacheClear()
      try {
        if (operation === 'accept') seedReport(f, 3)
        else seedCleanup(f)
        const before = f.snapshot()
        if (race === 'late-failure') f.controls.failBatchAt = operation === 'delete' ? 20 : 2
        else if (race === 'unsuccessful') f.controls.unsuccessfulBatch = true
        else f.controls.beforeBatch = () => f.database.exec(race === 'promote-target' ? "UPDATE users SET role='admin' WHERE id=3" : race === 'demote-actor' ? "UPDATE users SET role='user' WHERE id=1" : 'UPDATE users SET banned=1 WHERE id=1')
        const path = operation === 'delete' ? '/api/admin/users/3' : operation === 'track' ? '/api/admin/security/users/3/track-and-ban' : '/api/friend-request/admin/reports/30/accept'
        const res = await f.request(path, operation === 'delete' ? 'DELETE' : 'POST')
        assert.equal(res.status, race === 'late-failure' || race === 'unsuccessful' ? 500 : 403, await res.clone().text())
        // Remove only the independent concurrent authority change to compare every other row.
        if (race === 'promote-target') f.database.exec("UPDATE users SET role='user' WHERE id=3")
        if (race === 'demote-actor') f.database.exec("UPDATE users SET role='admin' WHERE id=1")
        if (race === 'ban-actor') f.database.exec('UPDATE users SET banned=0 WHERE id=1')
        assert.equal(f.snapshot(), before)
        assert.equal(getCachedTrackingRule(3), undefined)
        assert.equal(getCachedIpBan('203.0.113.30'), undefined)
      } finally { cacheClear(); f.database.close() }
    })
  }
}

test('ordinary ban toggle, tracking, blocklist and friend acceptance retain success responses', async () => {
  const f = await securityFixture()
  cacheClear()
  try {
    assert.deepEqual(await (await f.request('/api/admin/users/3/ban', 'POST')).json(), { banned: true })
    assert.deepEqual(await (await f.request('/api/admin/users/3/ban', 'POST')).json(), { banned: false })
    f.database.exec("INSERT INTO ip_tracking_events(user_id,ip,path,created_at) VALUES (3,'203.0.113.31','/api',1)")
    assert.deepEqual(await (await f.request('/api/admin/security/users/3/track-and-ban', 'POST')).json(), { tracked: true, banned_ip_count: 1 })
    assert.deepEqual(await (await f.request('/api/admin/blocked-emails', 'POST', { email: 'user3@example.test' })).json(), { ok: true, email: 'user3@example.test' })
    seedReport(f, 3)
    const accepted = await f.request('/api/friend-request/admin/reports/30/accept', 'POST')
    assert.equal(accepted.status, 200, await accepted.clone().text())
    assert.equal(f.database.prepare('SELECT status FROM friend_requests').get()?.status, 'deleted')
    assert.equal(f.database.prepare('SELECT banned FROM users WHERE id=3').get()?.banned, 1)
    assert.equal(f.database.prepare('SELECT status FROM friend_request_reports').get()?.status, 'resolved')
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM friend_request_snapshots').get()?.n, 1)
    assert.equal((await f.request('/api/friend-request/admin/reports/30/accept', 'POST')).status, 404)
  } finally { cacheClear(); f.database.close() }
})

test('single-statement role/ban/email writes recheck authority and target on concurrent changes', async () => {
  for (const operation of ['role', 'ban', 'email', 'add'] as const) {
    const f = await securityFixture()
    try {
      const sqlPart = operation === 'role' ? 'UPDATE users SET role = ?' : operation === 'ban' ? 'UPDATE users SET banned = CASE' : operation === 'email' ? 'INSERT INTO email_blocklist' : "UPDATE users SET role = 'admin'"
      f.controls.beforeSQL = sql => {
        if (!sql.includes(sqlPart)) return
        delete f.controls.beforeSQL
        f.database.exec(operation === 'ban' || operation === 'email' ? "UPDATE users SET role='admin' WHERE id=3" : "UPDATE users SET role='user' WHERE id=1")
      }
      const path = operation === 'role' ? '/api/admin/users/2/role' : operation === 'ban' ? '/api/admin/users/3/ban' : operation === 'email' ? '/api/admin/blocked-emails' : '/api/admin/add'
      const body = operation === 'role' ? { role: 'user' } : operation === 'email' ? { email: 'user3@example.test' } : operation === 'add' ? { user_ids: [3] } : undefined
      assert.equal((await f.request(path, operation === 'role' ? 'PATCH' : 'POST', body)).status, operation === 'role' ? 409 : 403)
      assert.equal(f.database.prepare('SELECT role FROM users WHERE id=2').get()?.role, 'admin')
      assert.equal(f.database.prepare('SELECT banned FROM users WHERE id=3').get()?.banned, 0)
      assert.equal(f.database.prepare('SELECT COUNT(*) n FROM email_blocklist').get()?.n, 0)
      if (operation === 'add') assert.equal(f.database.prepare('SELECT role FROM users WHERE id=3').get()?.role, 'user')
    } finally { f.database.close() }
  }
})

test('database read/write failures never fall back to JWT authority or partially mutate users', async () => {
  const f = await securityFixture()
  try {
    const before = f.snapshot()
    for (const failed of ['auth_invalid_before', 'pragma_table_info', 'UPDATE users SET role']) {
      f.controls.failSQL = failed
      const res = await f.request('/api/admin/users/2/role', 'PATCH', { role: 'user' })
      assert.equal(res.status, 500)
      assert.equal(f.snapshot(), before)
    }
    delete f.controls.failSQL
    f.controls.unsuccessful = true
    assert.equal((await f.request('/api/admin/add', 'POST', { user_ids: [3] })).status, 500)
    assert.equal(f.snapshot(), before)
    f.controls.unsuccessful = false
    f.database.exec('ALTER TABLE users DROP COLUMN banned')
    const beforeMissing = f.snapshot()
    seedReport(f, 3)
    const beforeReport = f.snapshot()
    assert.equal((await f.request('/api/friend-request/admin/reports/30/accept', 'POST')).status, 500)
    assert.equal(f.snapshot(), beforeReport)
    assert.ok(beforeMissing)
    assert.ok(f.statements.every(sql => !sql.includes('ALTER TABLE')))
  } finally { f.database.close() }
})
