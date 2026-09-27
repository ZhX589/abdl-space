import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { Hono } from 'hono'
import { signJWT } from '../lib/auth.ts'
import qqRoutes from './qq.ts'

const appId = '1905661071'
const jwtSecret = 'test-jwt-secret'
const hmacKey = 'test-hmac-key'
const originalFetch = globalThis.fetch

function makeD1(database: DatabaseSync) {
  type Statement = { _sql: string; _params: unknown[]; run: () => Promise<unknown> }
  const statement = (sql: string, params: unknown[] = []): Statement & {
    bind: (...next: unknown[]) => ReturnType<typeof statement>
    first: <T>() => Promise<T | null>
    all: <T>() => Promise<{ success: true; results: T[] }>
  } => ({
    _sql: sql,
    _params: params,
    bind: (...next) => statement(sql, next),
    async first<T>() { return (database.prepare(sql).get(...params) ?? null) as T | null },
    async all<T>() { return { success: true, results: database.prepare(sql).all(...params) as T[] } },
    async run() {
      const result = database.prepare(sql).run(...params)
      return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }
    },
  })
  return {
    prepare: (sql: string) => statement(sql),
    async batch(items: Statement[]) {
      database.exec('BEGIN IMMEDIATE')
      try {
        const results = []
        for (const item of items) results.push(await item.run())
        database.exec('COMMIT')
        return results
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
  }
}

function createDb() {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys=ON')
  database.exec(readFileSync(new URL('../../schemas/schema.sql', import.meta.url), 'utf8'))
  database.exec(readFileSync(new URL('../../migrations/0038_webauthn.sql', import.meta.url), 'utf8'))
  database.exec(readFileSync(new URL('../../migrations/0067_qq_android_auth.sql', import.meta.url), 'utf8'))
  database.exec(readFileSync(new URL('../../migrations/0068_auth_login_method_guards.sql', import.meta.url), 'utf8'))
  const env = {
    abdl_space_db: makeD1(database),
    JWT_SECRET: jwtSecret,
    QQ_ANDROID_APP_ID: appId,
    QQ_ANDROID_APP_KEY: 'test-app-key',
    QQ_IDENTITY_HMAC_KEY: hmacKey,
  }
  return { database, env }
}

function createApp() {
  const app = new Hono()
  app.route('/api/auth/qq', qqRoutes)
  return app
}

function mockQQ(unionid = 'union-1', openid = 'openid-1', nickname = 'QQ User') {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname === '/oauth2.0/token') {
      return Response.json({ access_token: 'access-token', client_id: appId, openid })
    }
    if (url.pathname === '/oauth2.0/me') {
      return Response.json({ client_id: appId, openid, unionid })
    }
    return Response.json({ ret: 0, nickname, figureurl_qq_2: 'https://q.qlogo.cn/avatar' })
  }
}

function addUser(db: ReturnType<typeof createDb>, id: number, options: { password?: string; verifiedEmail?: boolean; nbw?: string } = {}) {
  db.database.prepare(
    `INSERT INTO users(id,email,password_hash,username,role,email_verified) VALUES(?,?,?,?, 'user', ?)`
  ).run(id, `user${id}@example.test`, options.password ?? '', `user${id}`, options.verifiedEmail ? 1 : 0)
  if (options.nbw) db.database.prepare('UPDATE users SET nbw_uid=? WHERE id=?').run(options.nbw, id)
}

async function authHeader(userId: number) {
  return `Bearer ${await signJWT({ sub: userId, username: `user${userId}`, email: `user${userId}@example.test`, role: 'user' }, jwtSecret)}`
}

async function request(db: ReturnType<typeof createDb>, method: string, path: string, userId?: number) {
  return createApp().request(`/api/auth/qq${path}`, {
    method,
    headers: {
      ...(userId ? { Authorization: await authHeader(userId) } : {}),
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    },
    body: method === 'POST' ? JSON.stringify({ client_id: appId, authorization_code: 'server-code' }) : undefined,
  }, db.env as never)
}

test.afterEach(() => { globalThis.fetch = originalFetch })

test('missing QQ app configuration returns a stable unavailable error', async () => {
  const db = createDb()
  try {
    addUser(db, 1, { password: 'hash' })
    mockQQ()
    delete (db.env as Partial<typeof db.env>).QQ_ANDROID_APP_ID
    const response = await request(db, 'POST', '/android/bind', 1)
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: 'QQ_UPSTREAM_UNAVAILABLE' })
  } finally { db.database.close() }
})

test('exchange distinguishes unbound and bound QQ without setting cookies', async () => {
  const db = createDb()
  try {
    addUser(db, 1, { password: 'hash' })
    mockQQ()
    const unbound = await request(db, 'POST', '/android/exchange')
    assert.equal(unbound.status, 200)
    assert.deepEqual(await unbound.json(), { action: 'not_bound', code: 'QQ_ACCOUNT_NOT_BOUND' })
    assert.equal(unbound.headers.get('set-cookie'), null)

		const bind = await request(db, 'POST', '/android/bind', 1)
		assert.equal(bind.status, 200)
		assert.match(bind.headers.get('content-type') ?? '', /^application\/json/)
		assert.deepEqual(await bind.json(), { bound: true, nickname: 'QQ User', avatar: 'https://q.qlogo.cn/avatar' })
		const login = await request(db, 'POST', '/android/exchange')
    assert.equal(login.status, 200)
    const body = await login.json() as Record<string, unknown>
    assert.equal(body.action, 'login')
    assert.equal(typeof body.token, 'string')
    assert.equal(login.headers.get('set-cookie'), null)
  } finally { db.database.close() }
})

test('exchange rejects banned bound users without issuing a token', async () => {
  const db = createDb()
  try {
    db.database.exec('ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0')
    addUser(db, 1, { password: 'hash' })
    mockQQ()
    assert.equal((await request(db, 'POST', '/android/bind', 1)).status, 200)
    db.database.prepare('UPDATE users SET banned=1 WHERE id=1').run()
    const response = await request(db, 'POST', '/android/exchange')
    assert.equal(response.status, 403)
    const text = await response.text()
    assert.deepEqual(JSON.parse(text), { error: 'QQ_ACCOUNT_UNAVAILABLE' })
    assert.doesNotMatch(text, /token/i)
  } finally { db.database.close() }
})

test('same app/openid cannot silently switch unionid during login or binding', async () => {
  const db = createDb()
  try {
    addUser(db, 1, { password: 'hash' })
    mockQQ('union-a', 'openid-shared')
    const first = await request(db, 'POST', '/android/exchange')
    assert.equal(first.status, 200)
    assert.deepEqual(await first.json(), { action: 'not_bound', code: 'QQ_ACCOUNT_NOT_BOUND' })

    mockQQ('union-b', 'openid-shared')
    const loginConflict = await request(db, 'POST', '/android/exchange')
    assert.equal(loginConflict.status, 401)
    assert.deepEqual(await loginConflict.json(), { error: 'QQ_CREDENTIAL_INVALID' })

    const bindConflict = await request(db, 'POST', '/android/bind', 1)
    assert.equal(bindConflict.status, 409)
    assert.deepEqual(await bindConflict.json(), { error: 'QQ_ALREADY_BOUND' })
  } finally { db.database.close() }
})

test('bind is idempotent and enforces both conflict directions', async () => {
  const db = createDb()
  try {
    addUser(db, 1, { password: 'hash' })
    addUser(db, 2, { password: 'hash' })
    mockQQ('union-a', 'openid-a')
    assert.equal((await request(db, 'POST', '/android/bind', 1)).status, 200)
    assert.equal((await request(db, 'POST', '/android/bind', 1)).status, 200)

    mockQQ('union-b', 'openid-b')
    const existing = await request(db, 'POST', '/android/bind', 1)
    assert.equal(existing.status, 409)
    assert.deepEqual(await existing.json(), { error: 'QQ_BINDING_EXISTS' })

    mockQQ('union-a', 'openid-a')
    const other = await request(db, 'POST', '/android/bind', 2)
    assert.equal(other.status, 409)
    assert.deepEqual(await other.json(), { error: 'QQ_ALREADY_BOUND' })
  } finally { db.database.close() }
})

test('status exposes only bound nickname and avatar', async () => {
  const db = createDb()
  try {
    addUser(db, 1, { password: 'hash' })
    mockQQ('raw-union-secret', 'raw-openid-secret', 'Minimal Profile')
    await request(db, 'POST', '/android/bind', 1)
    const response = await request(db, 'GET', '/status', 1)
    const text = await response.text()
    assert.deepEqual(JSON.parse(text), { bound: true, nickname: 'Minimal Profile', avatar: 'https://q.qlogo.cn/avatar' })
    assert.doesNotMatch(text, /union|openid|hmac|user_id|app_id/i)
  } finally { db.database.close() }
})

test('delete treats passkey lookup failures as unavailable instead of allowing unsafe unbind', async () => {
  const db = createDb()
  try {
    addUser(db, 1)
    mockQQ()
    await request(db, 'POST', '/android/bind', 1)
    db.database.exec('DROP TABLE passkeys')

    const response = await request(db, 'DELETE', '/binding', 1)
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: 'QQ_UPSTREAM_UNAVAILABLE' })
    assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM qq_identities WHERE user_id=1').get()?.count, 1)
  } finally { db.database.close() }
})

test('delete protects the sole login method and is otherwise idempotent', async () => {
  const db = createDb()
  try {
    addUser(db, 1)
    mockQQ()
    await request(db, 'POST', '/android/bind', 1)
    const blocked = await request(db, 'DELETE', '/binding', 1)
    assert.equal(blocked.status, 409)
    assert.deepEqual(await blocked.json(), { error: 'QQ_UNBIND_WOULD_LOCK_ACCOUNT' })

    db.database.prepare("UPDATE users SET email_verified=1 WHERE id=1").run()
    const deleted = await request(db, 'DELETE', '/binding', 1)
    assert.equal(deleted.status, 200)
    assert.deepEqual(await deleted.json(), { bound: false })
    const again = await request(db, 'DELETE', '/binding', 1)
    assert.deepEqual(await again.json(), { bound: false })
  } finally { db.database.close() }
})

test('database guards serialize QQ and last-passkey deletion without locking out the user', () => {
  const db = createDb()
  try {
    addUser(db, 1)
    const unionid = 'a'.repeat(64)
    db.database.prepare('INSERT INTO qq_identities(unionid_hmac,user_id) VALUES(?,1)').run(unionid)
    db.database.prepare("INSERT INTO passkeys(id,user_id,public_key) VALUES('passkey-1',1,X'01')").run()

    db.database.prepare("DELETE FROM passkeys WHERE id='passkey-1'").run()
    assert.throws(
      () => db.database.prepare('DELETE FROM qq_identities WHERE user_id=1').run(),
      /AUTH_LAST_LOGIN_METHOD/,
    )

    db.database.prepare("INSERT INTO passkeys(id,user_id,public_key) VALUES('passkey-2',1,X'02')").run()
    db.database.prepare('DELETE FROM qq_identities WHERE user_id=1').run()
    assert.throws(
      () => db.database.prepare("DELETE FROM passkeys WHERE id='passkey-2'").run(),
      /AUTH_LAST_LOGIN_METHOD/,
    )
  } finally { db.database.close() }
})

test('database constraints prevent duplicate user and duplicate app subject ownership', () => {
  const db = createDb()
  try {
    addUser(db, 1)
    addUser(db, 2)
    const a = 'a'.repeat(64)
    const b = 'b'.repeat(64)
    const o = 'c'.repeat(64)
    db.database.prepare('INSERT INTO qq_identities(unionid_hmac,user_id) VALUES(?,1)').run(a)
    assert.throws(() => db.database.prepare('INSERT INTO qq_identities(unionid_hmac,user_id) VALUES(?,1)').run(b))
    db.database.prepare('INSERT INTO qq_identities(unionid_hmac,user_id) VALUES(?,2)').run(b)
    db.database.prepare('INSERT INTO qq_app_subjects(app_id,openid_hmac,unionid_hmac) VALUES(?,?,?)').run(appId, o, a)
    assert.throws(() => db.database.prepare('INSERT INTO qq_app_subjects(app_id,openid_hmac,unionid_hmac) VALUES(?,?,?)').run(appId, o, b))
    assert.doesNotThrow(() => db.database.prepare('INSERT INTO qq_app_subjects(app_id,openid_hmac,unionid_hmac) VALUES(?,?,?)').run(appId, 'd'.repeat(64), b))
  } finally { db.database.close() }
})
