import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL as NodeURL } from 'node:url'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import test from 'node:test'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { signJWT } from '../lib/auth.ts'
import { APP_CLIENT_REMINDER_KEY, appClientStats, appClientUsers, defaultAppClientPolicy, defaultAppClientReminder, isNativeAppClient, observeAppClient, parseAppVersionCode, validateAppClientReminder } from '../lib/app-clients.ts'
import { appClientTimelineMiddleware, appUpdateNotice, buildAppUpdateNotice } from './app-clients.ts'
import mastodon from '../mastodon/routes.ts'
import abdl from '../mastodon/abdl.ts'
import admin from '../routes/admin.ts'
import type { MastodonStatus } from '../mastodon/types.ts'
import type { AppClientPolicy, AppClientStats, AppClientUsers } from '../types/app-clients.ts'

async function statuses(response: Response): Promise<MastodonStatus[]> { return await response.json() as MastodonStatus[] }

const secret = 'app-client-test-secret'
const nativeUA = 'MastodonAndroid/3.0.0'
const migration = readFileSync(fileURLToPath(new NodeURL('../../migrations/0070_app_clients.sql', import.meta.url)), 'utf8')
function fixture(migrate = true) {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,display_name TEXT,email TEXT,role TEXT,password_changed_at TEXT,auth_invalid_before INTEGER,banned INTEGER DEFAULT 0,has_app INTEGER DEFAULT 1);
    CREATE TABLE oauth_tokens(access_token TEXT PRIMARY KEY,user_id INTEGER,scopes TEXT,access_expires_at INTEGER,revoked INTEGER DEFAULT 0);
    INSERT INTO users(id,username,display_name,email,role) VALUES (1,'admin','Admin','a@test','admin'),(2,'alice','Alice','b@test','user'),(3,'bob','Bob','c@test','user');`)
  if (migrate) sqlite.exec(migration)
  const statements: string[] = []
  let failWrite = false
  let failReminderRead = false
  let reminderReadCount = 0
  const statement = (sql: string, params: SQLInputValue[] = []) => ({
    bind: (...next: SQLInputValue[]) => statement(sql, next),
    async all() { statements.push(sql); if (params.includes(APP_CLIENT_REMINDER_KEY)) { reminderReadCount++; if (failReminderRead) throw new Error('injected reminder read failure') } return { success: true, results: sqlite.prepare(sql).all(...params) } },
    async run() { statements.push(sql); if (failWrite && (sql.includes('app_client') || params.includes(APP_CLIENT_REMINDER_KEY))) throw new Error('injected write failure'); const result = sqlite.prepare(sql).run(...params); return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } } },
  })
  // The in-memory adapter serializes transactions, like D1's atomic batch write path.
  let queue = Promise.resolve()
  const db = { prepare: (sql: string) => statement(sql), batch(items: ReturnType<typeof statement>[]) {
    const result = queue.then(async () => {
      sqlite.exec('BEGIN IMMEDIATE')
      try { const results = []; for (const item of items) results.push(await item.run()); sqlite.exec('COMMIT'); return results } catch (error) { sqlite.exec('ROLLBACK'); throw error }
    })
    queue = result.then(() => undefined, () => undefined)
    return result
  } }
  const env = { abdl_space_db: db, JWT_SECRET: secret }
  const app = new Hono()
  app.route('/api/v1', mastodon)
  app.route('/api/v1/abdl', abdl)
  app.route('/api/admin', admin)
  const probe = new Hono()
  probe.use('/api/v1/timelines/*', appClientTimelineMiddleware)
  probe.get('/api/v1/timelines/*', c => { c.header('Cache-Control', 'public,max-age=300'); c.header('Link', '</next>; rel="next"'); return c.json([{ id: 'real' }]) })
  const reminderReads = () => reminderReadCount
  return { sqlite, db, env, app, probe, statements, reminderReads, failReminderReads: () => { failReminderRead = true }, failWrites: () => { failWrite = true }, close: () => sqlite.close() }
}
async function token(id = 2) { return signJWT({ sub: id, username: 'alice', email: 'b@test', role: id === 1 ? 'admin' : 'user' }, secret) }
function headers(jwt?: string, code: string | null = '29', ua: string | null = nativeUA) {
  return { ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}), ...(ua ? { 'User-Agent': ua } : {}), ...(code !== null ? { 'X-App-Version-Code': code } : {}), 'CF-Connecting-IP': '192.0.2.50', 'X-Real-Client-IP': '192.0.2.50' }
}
function setPolicy(f: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  const policy = { ...defaultAppClientPolicy(), enabled: true, deprecated_version_codes: [29], ...overrides }
  f.sqlite.prepare('UPDATE site_settings SET value=? WHERE key=?').run(JSON.stringify(policy), 'app_client_policy')
}

function setReminder(f: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  f.sqlite.prepare('INSERT INTO site_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(APP_CLIENT_REMINDER_KEY, JSON.stringify({ ...defaultAppClientReminder(), enabled: true, version_codes: [29], ...overrides }))
}
function contentSchema(f: ReturnType<typeof fixture>) {
  f.sqlite.exec(`ALTER TABLE users ADD COLUMN avatar TEXT; ALTER TABLE users ADD COLUMN bio TEXT; ALTER TABLE users ADD COLUMN created_at TEXT;
    UPDATE users SET created_at='2026-09-01T00:00:00Z';
    CREATE TABLE posts(id INTEGER PRIMARY KEY,user_id INTEGER,content TEXT,created_at TEXT,in_reply_to_id INTEGER,repost_id INTEGER,mental_crisis INTEGER DEFAULT 0,geo_province TEXT,shares_count INTEGER DEFAULT 0,views_count INTEGER DEFAULT 0);
    CREATE TABLE post_comments(id INTEGER PRIMARY KEY,post_id INTEGER);
    CREATE TABLE post_images(post_id INTEGER,image_url TEXT,is_nsfw INTEGER,alt_text TEXT,blurhash TEXT,preview_url TEXT,storage_provider TEXT,sort_order INTEGER);
    CREATE TABLE likes(user_id INTEGER,target_type TEXT,target_id INTEGER);
    CREATE TABLE follows(follower_id INTEGER,following_id INTEGER);
    CREATE TABLE user_badges(user_id INTEGER,badge_key TEXT,displayed INTEGER,unlocked_at TEXT);
    CREATE TABLE badges(key TEXT,name TEXT,color TEXT);
    INSERT INTO posts(id,user_id,content,created_at) VALUES(101,2,'real newest','2026-10-03T12:00:00Z'),(100,3,'real older','2026-10-02T12:00:00Z');`)
}

test('native classifier is anchored and version parser is strict positive int32', () => {
  for (const ua of [undefined, '', 'Android', 'Mozilla/5.0 (Android) MastodonAndroid/3.0.0', 'MastodonAndroid/3.0.0 Mozilla/5.0', 'OAuth', 'MastodonAndroid/3.0.0\n']) assert.equal(isNativeAppClient(ua), false, ua)
  for (const ua of [nativeUA, `${nativeUA}-debug`, `${nativeUA}-github`, `${nativeUA}-nightly+@20261003`, `${nativeUA}-nightly+@local`]) assert.equal(isNativeAppClient(ua), true)
  for (const code of [undefined, '', '0', '-1', '+29', '29x', '1e2', '29.0', ' 29', '01', '2147483648', '9999999999999']) assert.equal(parseAppVersionCode(code), null, code)
  assert.equal(parseAppVersionCode('2147483647'), 2147483647)
})

test('all actual timelines and NBW alias gate before queries/cache/upstream and never paginate', async () => {
  const f = fixture(); const jwt = await token(); setPolicy(f)
  try {
    for (const path of ['/timelines/home', '/timelines/geo', '/timelines/popular', '/timelines/public', '/timelines/nbw', '/timelines/all', '/timelines/tag/test', '/timelines/list/1', '/timelines/bubble', '/timelines/future', '/abdl/nbw/sync-threads']) {
      const response = await f.app.request(`/api/v1${path}?max_id=123&limit=1`, { headers: headers(jwt) }, f.env as never)
      assert.equal(response.status, 200, path)
      assert.equal(response.headers.get('Link'), null, path)
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
      assert.match(response.headers.get('Vary') || '', /User-Agent/)
      assert.equal(response.headers.get('X-App-Client-Observation'), 'recorded')
      const list = await statuses(response); assert.equal(list.length, 1); assert.equal(list[0].id, 'app-update-required')
      assert.equal(list[0].account.id, '-1'); assert.match(list[0].content, /href="https:\/\/m\.abdl-space\.top\/app"/)
      assert.deepEqual(list[0].media_attachments, []); assert.equal(list[0].visibility, 'public')
    }
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS c FROM app_client_observations').get()?.c, 1)
    assert.ok(f.statements.every(sql => !/FROM posts|post_images|NBW/i.test(sql)))
  } finally { f.close() }
})

test('browser and header-only requests unaffected; kill switch continues observation and keeps native cache private', async () => {
  const f = fixture(); const jwt = await token(); setPolicy(f)
  try {
    for (const ua of [null, 'Mozilla/5.0 (Linux; Android 14)', 'prefix MastodonAndroid/3.0.0']) {
      const response = await f.probe.request('/api/v1/timelines/public', { headers: headers(jwt, '29', ua) }, f.env as never)
      assert.equal((await statuses(response))[0].id, 'real'); assert.equal(response.headers.get('Cache-Control'), 'public,max-age=300')
    }
    assert.equal(f.statements.length, 0)
    setPolicy(f, { enabled: false })
    const response = await f.probe.request('/api/v1/timelines/public', { headers: headers(jwt) }, f.env as never)
    assert.equal((await statuses(response))[0].id, 'real'); assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
    assert.equal((await appClientStats(f.db as never)).totals.observed_users, 1)
  } finally { f.close() }
})

test('missing malformed and explicit deprecated codes are separate policy controls and null observation bucket', async () => {
  const f = fixture(); const jwt = await token(); setPolicy(f, { block_unversioned: true })
  try {
    for (const code of [null, '29x', '0', '-29', '2147483648', '29']) {
      const response = await f.probe.request('/api/v1/timelines/public', { headers: headers(jwt, code) }, f.env as never)
      assert.equal((await statuses(response))[0].id, 'app-update-required')
    }
    for (const code of ['28', '30']) assert.equal((await statuses(await f.probe.request('/api/v1/timelines/public', { headers: headers(jwt, code) }, f.env as never)))[0].id, 'real')
    setPolicy(f, { block_unversioned: false })
    assert.equal((await statuses(await f.probe.request('/api/v1/timelines/public', { headers: headers(jwt, 'bad') }, f.env as never)))[0].id, 'real')
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS c FROM app_client_observations WHERE version_key=0').get()?.c, 1)
  } finally { f.close() }
})

test('required home authentication wins over policy; stale deleted banned expired revoked sessions never count', async () => {
  const f = fixture(); const jwt = await token(); setPolicy(f)
  try {
    assert.equal((await f.app.request('/api/v1/timelines/home', { headers: headers() }, f.env as never)).status, 401)
    f.sqlite.prepare('UPDATE users SET auth_invalid_before=? WHERE id=2').run(Math.floor(Date.now() / 1000) + 10)
    assert.equal((await f.app.request('/api/v1/timelines/home', { headers: headers(jwt) }, f.env as never)).status, 401)
    f.sqlite.exec('UPDATE users SET auth_invalid_before=NULL,banned=1 WHERE id=2')
    assert.equal((await f.app.request('/api/v1/timelines/home', { headers: headers(jwt) }, f.env as never)).status, 401)
    f.sqlite.exec(`UPDATE users SET banned=0 WHERE id=2;
      INSERT INTO oauth_tokens VALUES('revoked',2,'read',${Math.floor(Date.now()/1000)+1000},1);
      INSERT INTO oauth_tokens VALUES('expired',2,'read',1,0);`)
    for (const access of ['revoked', 'expired', 'nonsense']) assert.equal((await f.app.request('/api/v1/timelines/home', { headers: headers(access) }, f.env as never)).status, 401)
    f.sqlite.exec('DELETE FROM users WHERE id=2')
    assert.equal((await f.app.request('/api/v1/timelines/home', { headers: headers(jwt) }, f.env as never)).status, 401)
    assert.equal((await appClientStats(f.db as never)).totals.observed_users, 0)
  } finally { f.close() }
})

test('concurrent duplicate requests shared IP upgrades downgrades exact pairs and last-observed latest distribution', async () => {
  const f = fixture(); const jwt = await token(); const other = await token(3)
  try {
    await Promise.all(Array.from({ length: 12 }, () => f.probe.request('/api/v1/timelines/public', { headers: headers(jwt) }, f.env as never)))
    await f.probe.request('/api/v1/timelines/public', { headers: headers(other) }, f.env as never)
    // Stay newer than the real-clock middleware observations, independent of the calendar day.
    const base = Date.now() + 86400000
    const at = (hours: number) => new Date(base + hours * 3600000).toISOString()
    await observeAppClient(f.db as never, 2, 30, at(0))
    await observeAppClient(f.db as never, 2, 28, at(1))
    await observeAppClient(f.db as never, 2, 30, at(-24))
    await observeAppClient(f.db as never, 2, null, at(2))
    const stats = await appClientStats(f.db as never, base + 10 * 3600000)
    assert.equal(stats.totals.observed_users, 2); assert.equal(stats.totals.versioned_users, 2); assert.equal(stats.totals.unversioned_users, 1)
    assert.equal(stats.versions.reduce((sum, row) => sum + row.latest_users, 0), 2)
    assert.equal(stats.versions.find(row => row.version_code === null)?.latest_users, 1)
    assert.equal((await appClientUsers(f.db as never, 30, 1, 20, '')).users[0].last_seen_at, at(0))
    assert.equal((await appClientUsers(f.db as never, 'all', 1, 20, 'ali')).users[0].version_code, null)
    assert.equal((await appClientUsers(f.db as never, 'all', 2, 1, '')).pagination.total, 2)
    assert.equal((await appClientUsers(f.db as never, 'all', 1, 20, '%')).pagination.total, 0)
  } finally { f.close() }
})

test('observation transaction failures are honest fail-open and no synthetic notice pollutes later web/native response', async () => {
  const f = fixture(); const jwt = await token(); setPolicy(f)
  try {
    f.failWrites()
    const response = await f.probe.request('/api/v1/timelines/public', { headers: headers(jwt) }, f.env as never)
    assert.equal(response.headers.get('X-App-Client-Observation'), 'unavailable')
    assert.equal((await statuses(response))[0].id, 'app-update-required')
    assert.equal((await appClientStats(f.db as never)).totals.observed_users, 0)
    assert.equal((await statuses(await f.probe.request('/api/v1/timelines/public', { headers: headers(jwt, '29', 'Mozilla/5.0') }, f.env as never)))[0].id, 'real')
    setPolicy(f, { enabled: false })
    assert.equal((await statuses(await f.probe.request('/api/v1/timelines/public', { headers: headers(jwt) }, f.env as never)))[0].id, 'real')
  } finally { f.close() }
})

test('admin policy authorization validation atomic writes reserved generic settings and stats users contract', async () => {
  const f = fixture(); const adminJwt = await token(1); const userJwt = await token()
  const request = (path: string, method = 'GET', body?: unknown, access = adminJwt) => f.app.request(`/api/admin${path}`, { method, headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, f.env as never)
  try {
    for (const path of ['/app-clients/policy', '/app-clients/stats', '/app-clients/users']) {
      const unauthorized = await request(path, 'GET', undefined, '')
      assert.equal(unauthorized.status, 401); assert.equal(unauthorized.headers.get('Cache-Control'), 'private, no-store')
      const forbidden = await request(path, 'GET', undefined, userJwt)
      assert.equal(forbidden.status, 403); assert.equal(forbidden.headers.get('Cache-Control'), 'private, no-store')
    }
    const initial = await (await request('/app-clients/policy')).json() as AppClientPolicy; assert.deepEqual(initial, defaultAppClientPolicy())
    for (const body of [{ ...initial, enabled: 'true' }, { ...initial, deprecated_version_codes: [0] }, { ...initial, deprecated_version_codes: [29, 29] }, { ...initial, deprecated_version_codes: ['29'] }, { ...initial, deprecated_version_codes: [2147483648] }, { ...initial, update_message: ' ' }, { ...initial, update_message: 'x'.repeat(2001) }, { ...initial, deprecated_version_codes: Array.from({ length: 201 }, (_, i) => i + 1) }, { ...initial, extra: true }]) {
      assert.equal((await request('/app-clients/policy', 'PUT', body)).status, 422)
      assert.deepEqual(await (await request('/app-clients/policy')).json(), initial)
    }
    const policy = { ...initial, enabled: true, deprecated_version_codes: [28, 29], update_message: ' Update now ' }
    const saved = await request('/app-clients/policy', 'PUT', policy); assert.equal(saved.status, 200); assert.equal((await saved.json() as AppClientPolicy).update_message, 'Update now')
    assert.equal((await request('/settings', 'PUT', { key: 'app_client_policy', value: '{}' })).status, 422)
    await f.probe.request('/api/v1/timelines/public', { headers: headers(userJwt) }, f.env as never)
    assert.equal((await (await request('/app-clients/stats')).json() as AppClientStats).totals.observed_users, 1)
    const users = await (await request('/app-clients/users?version_code=29&page=1&limit=20&q=Alice')).json() as AppClientUsers
    assert.equal(users.users.length, 1); assert.equal(users.users[0].version_code, 29); assert.equal(users.pagination.totalPages, 1)
    for (const query of ['version_code=0', 'version_code=29x', 'page=2x', 'limit=101']) assert.equal((await request(`/app-clients/users?${query}`)).status, 422)
  } finally { f.close() }
})

test('migration creates stable fresh epoch without legacy backfill, cascades users, and unavailable infrastructure is explicit', async () => {
  const f = fixture(false); const adminJwt = await token(1); const jwt = await token()
  try {
    const response = await f.probe.request('/api/v1/timelines/public', { headers: headers(jwt) }, f.env as never)
    assert.equal((await statuses(response))[0].id, 'real'); assert.equal(response.headers.get('X-App-Client-Observation'), 'unavailable')
    assert.equal(response.headers.get('X-App-Client-Policy'), 'unavailable')
    assert.equal((await appClientStats(f.db as never)).available, false)
    const auth = { Authorization: `Bearer ${adminJwt}`, 'Content-Type': 'application/json' }
    const initial = await f.app.request('/api/admin/app-clients/policy', { headers: auth }, f.env as never)
    assert.equal(initial.status, 503); assert.deepEqual(await initial.json(), { error: 'App client policy unavailable' })
    assert.equal((await f.app.request('/api/admin/app-clients/policy', { method: 'PUT', headers: auth, body: JSON.stringify(defaultAppClientPolicy()) }, f.env as never)).status, 503)
    assert.equal((await f.app.request('/api/admin/app-clients/users', { headers: auth }, f.env as never)).status, 503)
    f.sqlite.exec(migration)
    f.sqlite.exec("UPDATE site_settings SET value='broken-json' WHERE key='app_client_policy'")
    const invalidPolicy = await f.app.request('/api/admin/app-clients/policy', { headers: auth }, f.env as never)
    assert.equal(invalidPolicy.status,503)
    const failOpen = await f.probe.request('/api/v1/timelines/public', { headers: headers(jwt) }, f.env as never)
    assert.equal((await statuses(failOpen))[0].id,'real'); assert.equal(failOpen.headers.get('X-App-Client-Policy'),'unavailable')
    f.sqlite.exec('DELETE FROM app_client_latest; DELETE FROM app_client_observations')
    const epoch = (await appClientStats(f.db as never)).measurement_started_at
    f.sqlite.exec(migration)
    assert.equal((await appClientStats(f.db as never)).measurement_started_at, epoch)
    assert.equal((await appClientStats(f.db as never)).totals.observed_users, 0)
    await observeAppClient(f.db as never, 2, 29)
    f.sqlite.exec('DELETE FROM users WHERE id=2')
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS c FROM app_client_latest').get()?.c, 0)
    assert.equal((await appClientStats(f.db as never)).totals.observed_users, 0)
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS c FROM pragma_foreign_key_check').get()?.c, 0)
  } finally { f.close() }
})

test('notice escapes admin text and is complete without a real post/account', () => {
  const status = appUpdateNotice({ ...defaultAppClientPolicy(), update_message: '<script>alert(1)</script>' })
  assert.match(status.content, /&lt;script&gt;/); assert.doesNotMatch(status.content, /<script>/)
  for (const key of ['created_at','in_reply_to_id','in_reply_to_account_id','sensitive','spoiler_text','visibility','language','uri','url','replies_count','reblogs_count','favourites_count','favourited','reblogged','muted','bookmarked','content','reblog','application','account','media_attachments','mentions','tags','emojis','card','poll']) assert.ok(key in status, key)
  assert.ok(Number.isFinite(Date.parse(status.created_at)))
})


test('reserved notice account and status cannot be read or mutated, including nested action routes', async () => {
  const f = fixture(); const jwt = await token()
  try {
    for (const [path, method] of [
      ['/accounts/-1', 'GET'], ['/accounts/-1/statuses', 'GET'], ['/accounts/-1/follow', 'POST'],
      ['/accounts/-1/unfollow', 'POST'], ['/accounts/-1/block', 'POST'],
      ['/statuses/app-update-required', 'GET'], ['/statuses/app-update-required/context', 'GET'],
      ['/statuses/app-update-required/favourite', 'POST'], ['/statuses/app-update-required/reblog', 'POST'],
      ['/statuses/app-update-required/bookmark', 'POST'], ['/statuses/app-update-required', 'DELETE'],
      ['/statuses/app-update-required', 'PUT'],
    ]) {
      const response = await f.app.request(`/api/v1${path}`, { method, headers: headers(jwt) }, f.env as never)
      assert.equal(response.status, 404, `${method} ${path}`)
    }
    assert.equal(f.statements.length, 0, 'no reserved entity touches a real database row')
  } finally { f.close() }
})

test('valid OAuth and direct JWT work without a registered OAuth client, and password-change JWT stays excluded', async () => {
  const f = fixture(); const jwt = await token()
  try {
    f.sqlite.exec(`INSERT INTO oauth_tokens VALUES('valid-direct-client',2,'read',${Math.floor(Date.now()/1000)+1000},0)`)
    const response = await f.probe.request('/api/v1/timelines/public', { headers: headers('valid-direct-client', '28') }, f.env as never)
    assert.equal(response.headers.get('X-App-Client-Observation'), 'recorded')
    f.sqlite.prepare('UPDATE users SET password_changed_at=? WHERE id=2').run(new Date(Date.now()+10000).toISOString())
    await f.probe.request('/api/v1/timelines/public', { headers: headers(jwt, '30') }, f.env as never)
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS c FROM app_client_observations').get()?.c, 1)
  } finally { f.close() }
})

test('actual public warm cache bypasses all real data on block and never contaminates later native/browser requests', async () => {
  const f = fixture(); const jwt = await token()
  const kvCalls: string[] = []
  const snapshot = [{ id: 'cached-real' }]
  const env = { ...f.env, NOTICE_KV: { get: async (key: string) => { kvCalls.push(key); return snapshot }, put: async () => { throw new Error('synthetic must not be cached') } } }
  try {
    setPolicy(f)
    const blocked = await f.app.request('/api/v1/timelines/public', { headers: headers(jwt) }, env as never)
    assert.equal((await statuses(blocked))[0].id, 'app-update-required')
    assert.equal(kvCalls.length, 0, 'gate runs before D1 failure/snapshot reads')
    setPolicy(f, { enabled: false })
    const fallback = await f.app.request('/api/v1/timelines/public', { headers: headers(jwt) }, env as never)
    assert.deepEqual(await fallback.json(), snapshot)
    assert.equal(fallback.headers.get('Cache-Control'), 'private, no-store')
    const webFallback = await f.app.request('/api/v1/timelines/public', { headers: headers(undefined, '29', 'Mozilla/5.0') }, env as never)
    assert.deepEqual(await webFallback.json(), snapshot)
    assert.equal(webFallback.headers.get('X-App-Client-Observation'), null)
    assert.deepEqual(kvCalls, ['d1kv:public-timeline:snapshot', 'd1kv:public-timeline:snapshot'])
    // Input-validation errors also retain native cache headers and cannot become a notice cache.
    const native = await f.app.request('/api/v1/timelines/geo', { headers: headers(jwt) }, f.env as never)
    assert.equal(native.status, 400); assert.equal(native.headers.get('Cache-Control'), 'private, no-store')
    const browser = await f.app.request('/api/v1/timelines/geo', { headers: headers(jwt, '29', 'Mozilla/5.0') }, f.env as never)
    assert.equal(browser.status, 400); assert.equal(browser.headers.get('X-App-Client-Observation'), null)
  } finally { f.close() }
})

test('rolling windows are UTC durations, totals distinct and per-version sums may overlap', async () => {
  const f = fixture()
  try {
    await observeAppClient(f.db as never, 2, 28, '2026-10-03T00:00:00.000Z')
    await observeAppClient(f.db as never, 2, 29, '2026-09-29T00:00:00.000Z')
    await observeAppClient(f.db as never, 3, null, '2026-09-20T00:00:00.000Z')
    const stats = await appClientStats(f.db as never, Date.parse('2026-10-03T12:00:00Z'))
    assert.deepEqual([stats.totals.active_1d, stats.totals.active_7d, stats.totals.active_30d], [1,1,2])
    assert.equal(stats.versions.reduce((sum,row)=>sum+row.observed_users,0),3)
    assert.equal(stats.totals.observed_users,2)
  } finally { f.close() }
})


test('legacy admin counters use exact observed distinct accounts and ignore cached has_app schema', async () => {
  const f = fixture(); const jwt = await token(1)
  try {
    f.sqlite.exec(`ALTER TABLE users ADD COLUMN avatar TEXT; ALTER TABLE users ADD COLUMN created_at TEXT;
      CREATE TABLE posts(id INTEGER PRIMARY KEY,user_id INTEGER,content TEXT,geo_province TEXT,created_at TEXT);
      CREATE TABLE post_comments(id INTEGER PRIMARY KEY,created_at TEXT);
      CREATE TABLE ratings(id INTEGER PRIMARY KEY,created_at TEXT);
      CREATE TABLE diapers(id INTEGER PRIMARY KEY,created_at TEXT);
      CREATE TABLE likes(id INTEGER PRIMARY KEY,created_at TEXT);
      CREATE TABLE daily_checkins(id INTEGER PRIMARY KEY,created_at TEXT);
      CREATE TABLE user_badges(id INTEGER PRIMARY KEY,created_at TEXT);
      CREATE TABLE novels(id INTEGER PRIMARY KEY,status TEXT,deleted_at INTEGER,created_at INTEGER);
      CREATE TABLE admin_metrics_cache(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT);
      INSERT INTO admin_metrics_cache VALUES('overview_snapshot_v2','{"totals":{"appUsers":999}}',datetime('now'));`)
    await observeAppClient(f.db as never, 2, 29)
    await observeAppClient(f.db as never, 2, 30)
    for (const path of ['/api/admin/stats', '/api/admin/stats/overview']) {
      const response = await f.app.request(path, { headers: { Authorization: `Bearer ${jwt}` } }, f.env as never)
      assert.equal(response.status, 200, await response.clone().text())
      const body = await response.json() as { totals?: {appUsers:number;appUsersAvailable:boolean};appUsers:number;appUsersAvailable:boolean }
      const counts = body.totals || body
      assert.equal(counts.appUsers, 1); assert.equal(counts.appUsersAvailable, true)
    }
    assert.ok(f.sqlite.prepare("SELECT 1 FROM admin_metrics_cache WHERE key='overview_snapshot_v3_app_clients'").get())
    assert.equal(f.sqlite.prepare('SELECT SUM(has_app) AS c FROM users').get()?.c, 3, 'legacy flags are untouched')
    f.sqlite.exec('DROP TABLE app_client_latest;DROP TABLE app_client_observations;DROP TABLE app_client_measurement')
    const missing = await f.app.request('/api/admin/stats', { headers: { Authorization: `Bearer ${jwt}` } }, f.env as never)
    const body = await missing.json() as { appUsers:number|null;appUsersAvailable:boolean }
    assert.equal(body.appUsers,null);assert.equal(body.appUsersAvailable,false)
  } finally { f.close() }
})


test('invalid native bearer cannot fall back to a valid cookie and lowercase bearer is valid', async () => {
  const f = fixture(); const jwt = await token()
  try {
    for (const authorization of ['Bearer invalid', 'Bearer expired']) {
      const response = await f.app.request('/api/v1/timelines/home', { headers: { ...headers(), Authorization: authorization, Cookie: `token=${jwt}` } }, f.env as never)
      assert.equal(response.status,401)
    }
    assert.equal((await appClientStats(f.db as never)).totals.observed_users,0)
    const valid = await f.probe.request('/api/v1/timelines/public', { headers: { ...headers(), Authorization: `bearer ${jwt}` } }, f.env as never)
    assert.equal(valid.headers.get('X-App-Client-Observation'),'recorded')
  } finally { f.close() }
})

test('blocked native requests do not bypass existing timeline rate limits or trigger D1 after limit', async () => {
  const f = fixture(); const jwt = await token(); setPolicy(f)
  const requestHeaders = {...headers(jwt),'CF-Connecting-IP':'192.0.2.252'}
  try {
    for (let i=0;i<120;i++) {
      const response = await f.app.request('/api/v1/timelines/public',{headers:requestHeaders},f.env as never)
      assert.equal(response.status,200)
      assert.equal((await statuses(response))[0].id,'app-update-required')
    }
    const before=f.statements.length
    const limited=await f.app.request('/api/v1/timelines/public',{headers:requestHeaders},f.env as never)
    assert.equal(limited.status,429); assert.equal(limited.headers.get('Cache-Control'),'private, no-store')
    assert.equal(f.statements.length,before,'rate limited request never reaches auth/observation/policy DB')
    const aliasLimited = await f.app.request('/api/v1/abdl/nbw/sync-threads',{headers:requestHeaders},f.env as never)
    assert.equal(aliasLimited.status,429); assert.equal(aliasLimited.headers.get('Cache-Control'),'private, no-store')
    assert.equal(f.statements.length,before)
  } finally {f.close()}
})

test('reminder admin GET/PUT auth, strict validation, default blank message and reserved setting', async () => {
  const f = fixture(); const adminJwt = await token(1); const userJwt = await token()
  const request = (method = 'GET', body?: unknown, access = adminJwt) => f.app.request('/api/admin/app-clients/reminder', { method, headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, f.env as never)
  try {
    for (const method of ['GET', 'PUT']) {
      assert.equal((await request(method, method === 'PUT' ? defaultAppClientReminder() : undefined, '')).status, 401)
      assert.equal((await request(method, method === 'PUT' ? defaultAppClientReminder() : undefined, userJwt)).status, 403)
    }
    const initial = await request(); assert.equal(initial.status, 200); assert.equal(initial.headers.get('Cache-Control'), 'private, no-store')
    assert.deepEqual(await initial.json(), defaultAppClientReminder())
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS c FROM site_settings WHERE key=?').get(APP_CLIENT_REMINDER_KEY)?.c, 0, 'GET never creates a row')
    const valid = { enabled: true, version_codes: [1, 29, 2147483647], include_unversioned: true, message: 'custom' }
    for (const body of [null, [], {}, { ...valid, enabled: 1 }, { ...valid, enabled: 'true' }, { ...valid, version_codes: null }, { ...valid, version_codes: [0] }, { ...valid, version_codes: [-1] }, { ...valid, version_codes: [1.2] }, { ...valid, version_codes: ['29'] }, { ...valid, version_codes: [2147483648] }, { ...valid, version_codes: [29, 29] }, { ...valid, version_codes: Array.from({ length: 201 }, (_, i) => i + 1) }, { ...valid, message: null }, { ...valid, message: 'x'.repeat(2001) }, { ...valid, block_unversioned: true }, { enabled: true, version_codes: [29] }]) {
      assert.equal((await request('PUT', body)).status, 422, JSON.stringify(body))
      assert.deepEqual(await (await request()).json(), defaultAppClientReminder())
    }
    for (const include_unversioned of [null, 'true', 'false', 0, 1, [], {}]) {
      assert.equal((await request('PUT', { ...valid, include_unversioned })).status, 422)
      assert.deepEqual(await (await request()).json(), defaultAppClientReminder())
      assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS c FROM site_settings WHERE key=?').get(APP_CLIENT_REMINDER_KEY)?.c, 0)
    }
    for (const body of [
      { enabled: true, version_codes: [29], include_unversioned: true },
      { enabled: true, message: 'custom', include_unversioned: true },
      { version_codes: [29], message: 'custom', include_unversioned: true },
      { ...valid, extra: true },
    ]) assert.equal((await request('PUT', body)).status, 422)
    assert.equal(validateAppClientReminder({ ...valid, include_unversioned: undefined }), null, 'explicit undefined is not a legacy omission')
    const malformed = await f.app.request('/api/admin/app-clients/reminder', { method: 'PUT', headers: headers(adminJwt), body: '{' }, f.env as never)
    assert.equal(malformed.status, 422)
    assert.deepEqual(await (await request('PUT', { ...valid, message: '  ' })).json(), { ...valid, message: defaultAppClientReminder().message })
    assert.deepEqual(await (await request('PUT', { ...valid, message: ' custom\nline ' })).json(), { ...valid, message: 'custom\nline' })
    const max = { ...valid, version_codes: Array.from({ length: 200 }, (_, i) => i + 1), message: 'x'.repeat(2000) }
    assert.equal((await request('PUT', max)).status, 200)
    assert.equal((await f.app.request('/api/admin/settings', { method: 'PUT', headers: headers(adminJwt), body: JSON.stringify({ key: APP_CLIENT_REMINDER_KEY, value: '{}' }) }, f.env as never)).status, 422)
    assert.deepEqual(await (await f.app.request('/api/admin/app-clients/policy', { headers: headers(adminJwt) }, f.env as never)).json(), defaultAppClientPolicy())
    f.failWrites(); assert.equal((await request('PUT', valid)).status, 503)
    assert.deepEqual(await (await request()).json(), max)
    f.sqlite.exec("UPDATE users SET role='user' WHERE id=1")
    assert.equal((await request()).status, 403, 'fresh database role, not JWT role')
  } finally { f.close() }
})

test('legacy saved reminder and legacy PUT normalize to four fields with include_unversioned true', async () => {
  const f = fixture(); const adminJwt = await token(1)
  const legacy = { enabled: true, version_codes: [29], message: 'Legacy reminder' }
  const normalized = { ...legacy, include_unversioned: true }
  const request = (method = 'GET', body?: unknown) => f.app.request('/api/admin/app-clients/reminder', { method, headers: headers(adminJwt), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, f.env as never)
  const stored = () => JSON.parse(String(f.sqlite.prepare('SELECT value FROM site_settings WHERE key=?').get(APP_CLIENT_REMINDER_KEY)?.value))
  try {
    f.sqlite.prepare('INSERT INTO site_settings(key,value) VALUES(?,?)').run(APP_CLIENT_REMINDER_KEY, JSON.stringify(legacy))
    const read = await request(); assert.equal(read.status, 200); assert.deepEqual(await read.json(), normalized)
    assert.deepEqual(stored(), legacy, 'GET normalizes without migrating/writing the row')
    const saved = await request('PUT', legacy); assert.equal(saved.status, 200); assert.deepEqual(await saved.json(), normalized)
    assert.deepEqual(stored(), normalized); assert.equal(Object.keys(stored()).length, 4)
    const disabledGroup = { ...normalized, include_unversioned: false }
    assert.deepEqual(await (await request('PUT', disabledGroup)).json(), disabledGroup)
    assert.deepEqual(await (await request()).json(), disabledGroup); assert.deepEqual(stored(), disabledGroup)
    assert.deepEqual(await (await request('PUT', legacy)).json(), normalized, 'legacy PUT always restores the true default')
    assert.deepEqual(stored(), normalized)
  } finally { f.close() }
})

test('missing and malformed native versions receive nonblocking legacy reminder; group and master toggles remain independent', async () => {
  const f = fixture(); const jwt = await token()
  const unversioned = [null, '', 'bad', '29x', '01', '0', '-1', '+29', '29.0', '1e2', '2147483648']
  const request = (code: string | null) => f.probe.request('/api/v1/timelines/public?limit=1', { headers: headers(jwt, code) }, f.env as never)
  try {
    assert.deepEqual(await (await request(null)).json(), [{ id: 'real' }], 'absent row master is off even though include_unversioned defaults true')
    f.sqlite.prepare('INSERT INTO site_settings(key,value) VALUES(?,?)').run(APP_CLIENT_REMINDER_KEY, JSON.stringify({ enabled: true, version_codes: [29], message: 'Legacy reminder' }))
    for (const code of unversioned) {
      const response = await request(code)
      assert.equal(response.status, 200); assert.equal(response.headers.get('X-App-Client-Observation'), 'recorded')
      assert.equal(response.headers.get('X-App-Client-Reminder'), null)
      assert.equal(response.headers.get('Link'), '</next>; rel="next"')
      assert.deepEqual((await statuses(response)).map(s => s.id), ['app-update-required', 'real'], String(code))
    }
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS c FROM app_client_observations WHERE version_key=0').get()?.c, 1, 'parser retains one null observation bucket')
    setReminder(f, { include_unversioned: false })
    for (const code of unversioned) assert.deepEqual(await (await request(code)).json(), [{ id: 'real' }], String(code))
    assert.deepEqual((await statuses(await request('29'))).map(s => s.id), ['app-update-required', 'real'])
    setReminder(f, { version_codes: [] })
    assert.deepEqual((await statuses(await request(null))).map(s => s.id), ['app-update-required', 'real'], 'unversioned does not require any selected code')
    setReminder(f, { enabled: false })
    for (const code of [...unversioned, '29', '30']) assert.deepEqual(await (await request(code)).json(), [{ id: 'real' }])
    assert.equal((await appClientStats(f.db as never)).totals.observed_users, 1)
  } finally { f.close() }
})

test('unversioned inclusion never classifies desktop/android browsers, header-only or OAuth identity; cookie auth stays bearer-only', async () => {
  const f = fixture(); const jwt = await token(); setReminder(f)
  try {
    f.sqlite.exec(`INSERT INTO oauth_tokens VALUES('unversioned-oauth',2,'read',${Math.floor(Date.now()/1000)+1000},0)`)
    for (const ua of [null, 'Mozilla/5.0 (X11; Linux x86_64)', 'Mozilla/5.0 (Linux; Android 14)', 'Mozilla/5.0 MastodonAndroid/3.0.0', 'MastodonAndroid/3.0.0 browser']) {
      for (const code of [null, 'bad', '29']) {
        const before = f.statements.length
        const response = await f.probe.request('/api/v1/timelines/public', { headers: { ...headers('unversioned-oauth', code, ua), Cookie: `token=${jwt}` } }, f.env as never)
        assert.deepEqual(await response.json(), [{ id: 'real' }]); assert.equal(response.headers.get('Cache-Control'), 'public,max-age=300')
        assert.equal(response.headers.get('X-App-Client-Observation'), null); assert.equal(f.statements.length, before)
      }
    }
    assert.equal(f.reminderReads(), 0)
    for (const code of [null, 'bad']) {
      for (const authorization of [undefined, 'Bearer invalid']) {
        const before = f.reminderReads()
        const response = await f.app.request('/api/v1/timelines/home', { headers: { ...headers(undefined, code), ...(authorization ? { Authorization: authorization } : {}), Cookie: `token=${jwt}` } }, f.env as never)
        assert.equal(response.status, 401); assert.equal(f.reminderReads(), before)
      }
    }
    assert.equal((await appClientStats(f.db as never)).totals.observed_users, 0)
    const native = await f.probe.request('/api/v1/timelines/public', { headers: headers('unversioned-oauth', 'bad') }, f.env as never)
    assert.equal(native.headers.get('X-App-Client-Observation'), 'recorded')
    assert.deepEqual((await statuses(native)).map(s => s.id), ['app-update-required', 'real'])
    assert.equal(f.sqlite.prepare('SELECT version_key FROM app_client_latest WHERE user_id=2').get()?.version_key, 0)
  } finally { f.close() }
})

test('unversioned reminder preserves continuation, empty initial/terminal arrays and reserved cursor termination', async () => {
  const f = fixture(); const jwt = await token(); setReminder(f); contentSchema(f)
  try {
    for (const code of [null, 'bad']) {
      for (const query of ['max_id=p_100', 'min_id=p_100', 'since_id=p_100', 'cursor=opaque', 'offset=20', 'offset=20x']) {
        const response = await f.probe.request(`/api/v1/timelines/public?${query}`, { headers: headers(jwt, code) }, f.env as never)
        assert.deepEqual(await response.json(), [{ id: 'real' }]); assert.equal(response.headers.get('Link'), '</next>; rel="next"')
      }
      const first = await f.probe.request('/api/v1/timelines/public?offset=0', { headers: headers(jwt, code) }, f.env as never)
      assert.deepEqual((await statuses(first)).map(s => s.id), ['app-update-required', 'real'])
      for (const enabled of [true, false]) {
        setReminder(f, { enabled })
        for (const query of ['max_id=p_1', 'max_id=app-update-required']) {
          const before = f.statements.length
          const response = await f.app.request(`/api/v1/timelines/public?${query}`, { headers: headers(jwt, code) }, f.env as never)
          assert.deepEqual(await response.json(), []); assert.equal(response.headers.get('Link'), null)
          if (query.includes('app-update-required')) assert.ok(f.statements.slice(before).every(sql => !/FROM posts/i.test(sql)))
        }
      }
      setReminder(f)
    }
    f.sqlite.exec('DELETE FROM posts')
    for (const code of [null, 'bad']) assert.deepEqual(await (await f.app.request('/api/v1/timelines/public', { headers: headers(jwt, code) }, f.env as never)).json(), [])
  } finally { f.close() }
})

test('retirement block_unversioned wins for null versions even with continuation or terminal notice cursor', async () => {
  const f = fixture(); const jwt = await token(); setPolicy(f, { block_unversioned: true, update_message: 'Retired unversioned' }); setReminder(f); f.failReminderReads()
  try {
    for (const code of [null, 'bad', '01', '2147483648']) {
      for (const path of ['/api/v1/timelines/public', '/api/v1/abdl/nbw/sync-threads']) {
        for (const query of ['', '?cursor=opaque', '?max_id=app-update-required']) {
          const response = await f.app.request(path + query, { headers: headers(jwt, code) }, f.env as never)
          assert.equal(response.status, 200); assert.equal(response.headers.get('Link'), null)
          const body = await statuses(response); assert.equal(body.length, 1); assert.equal(body[0].text, 'Retired unversioned\nhttps://m.abdl-space.top/app')
        }
      }
    }
    assert.equal(f.reminderReads(), 0); assert.ok(f.statements.every(sql => !/FROM posts|NBW/i.test(sql)))
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS c FROM app_client_observations WHERE version_key=0').get()?.c, 1)
  } finally { f.close() }
})

test('reminder needs only existing site_settings, not epoch; corruption/read failures are honest and native fail-open', async () => {
  const f = fixture(false); const adminJwt = await token(1)
  const request = (method = 'GET', body?: unknown) => f.app.request('/api/admin/app-clients/reminder', { method, headers: headers(adminJwt), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, f.env as never)
  try {
    f.sqlite.exec('CREATE TABLE site_settings(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT)')
    assert.deepEqual(await (await request()).json(), defaultAppClientReminder())
    const reminder = { enabled: true, version_codes: [29], include_unversioned: true, message: 'No epoch needed' }
    assert.equal((await request('PUT', reminder)).status, 200)
    assert.deepEqual(await (await request()).json(), reminder)
    const native = await f.probe.request('/api/v1/timelines/public', { headers: headers() }, f.env as never)
    assert.deepEqual((await statuses(native)).map(s => s.id), ['app-update-required', 'real'])
    for (const value of ['broken-json', '{}', '{"enabled":true,"version_codes":[0],"message":"bad"}', ...[null, 'true', 0].map(include_unversioned => JSON.stringify({ ...reminder, include_unversioned }))]) {
      f.sqlite.prepare('UPDATE site_settings SET value=? WHERE key=?').run(value, APP_CLIENT_REMINDER_KEY)
      assert.equal((await request()).status, 503)
      const response = await f.probe.request('/api/v1/timelines/public', { headers: headers() }, f.env as never)
      assert.deepEqual(await response.json(), [{ id: 'real' }]); assert.equal(response.headers.get('X-App-Client-Reminder'), 'unavailable')
    }
    setReminder(f); f.failReminderReads()
    assert.equal((await request()).status, 503)
    assert.deepEqual(await (await f.probe.request('/api/v1/timelines/public', { headers: headers() }, f.env as never)).json(), [{ id: 'real' }])
    f.sqlite.exec('DROP TABLE site_settings')
    assert.equal((await request('PUT', reminder)).status, 503)
  } finally { f.close() }
})

test('reminder matches strict native selected version, observes normally and disabling is immediate', async () => {
  const f = fixture(); const jwt = await token(); setReminder(f)
  try {
    const response = await f.probe.request('/api/v1/timelines/public?limit=1', { headers: headers(jwt) }, f.env as never)
    assert.deepEqual((await statuses(response)).map(s => s.id), ['app-update-required', 'real'])
    assert.equal(response.headers.get('Link'), '</next>; rel="next"')
    assert.equal(response.headers.get('X-App-Client-Observation'), 'recorded')
    assert.equal(f.reminderReads(), 1)
    for (const code of ['28', '30']) {
      assert.deepEqual(await (await f.probe.request('/api/v1/timelines/public', { headers: headers(jwt, code) }, f.env as never)).json(), [{ id: 'real' }])
    }
    const before = f.statements.length
    for (const ua of [null, 'Mozilla/5.0 (Android)', 'Mozilla/5.0 MastodonAndroid/3.0.0', 'MastodonAndroid/3.0.0 browser']) {
      assert.deepEqual(await (await f.probe.request('/api/v1/timelines/public', { headers: headers(jwt, '29', ua) }, f.env as never)).json(), [{ id: 'real' }])
    }
    assert.equal(f.statements.length, before)
    setReminder(f, { enabled: false })
    assert.deepEqual(await (await f.probe.request('/api/v1/timelines/public', { headers: headers(jwt) }, f.env as never)).json(), [{ id: 'real' }])
    assert.equal((await appClientStats(f.db as never)).totals.observed_users, 1)
    assert.equal((await f.app.request('/api/v1/timelines/home', { headers: headers() }, f.env as never)).status, 401)
  } finally { f.close() }
})

test('retirement wins exactly one old notice and does not read reminder or real timeline content', async () => {
  const f = fixture(); const jwt = await token(); setPolicy(f, { update_message: 'Retired' }); setReminder(f, { message: 'Reminder' }); f.failReminderReads()
  try {
    for (const path of ['/api/v1/timelines/public', '/api/v1/abdl/nbw/sync-threads']) {
      const response = await f.app.request(`${path}?max_id=100&limit=1`, { headers: headers(jwt) }, f.env as never)
      const body = await statuses(response); assert.equal(body.length, 1); assert.equal(body[0].text, 'Retired\nhttps://m.abdl-space.top/app')
      assert.equal(response.headers.get('Link'), null); assert.equal(response.headers.get('X-App-Client-Reminder'), null)
    }
    assert.equal(f.reminderReads(), 0)
    assert.ok(f.statements.every(sql => !/FROM posts|NBW/i.test(sql)))
  } finally { f.close() }
})

test('actual SQLite public/home/geo timelines retain every real status and real pagination cursor', async () => {
  const f = fixture(); const jwt = await token(); contentSchema(f); setReminder(f)
  f.sqlite.exec("UPDATE posts SET geo_province='test'")
  try {
    for (const path of ['/api/v1/timelines/public', '/api/v1/timelines/home', '/api/v1/timelines/geo?province=test']) {
      const url = path + (path.includes('?') ? '&' : '?') + 'limit=1'
      const original = await f.app.request(url, { headers: headers(jwt, '30') }, f.env as never)
      const real = await statuses(original)
      for (const code of ['29', null, 'bad']) {
        const response = await f.app.request(url, { headers: headers(jwt, code) }, f.env as never)
        const result = await statuses(response)
        assert.equal(response.status, 200, path)
        assert.equal(result[0].id, 'app-update-required'); assert.deepEqual(result.slice(1), real)
        assert.equal(result.length, real.length + 1, 'do not trim real list to limit')
        assert.equal(response.headers.get('Link'), original.headers.get('Link'))
        assert.doesNotMatch(response.headers.get('Link') || '', /app-update-required/)
      }
    }
  } finally { f.close() }
})

test('reminder on actual public fallback never mutates shared snapshot or later browser/nonmatching responses', async () => {
  const f = fixture(); const jwt = await token(); setReminder(f)
  const snapshot = [{ id: 'cached-real', content: '<p>real</p>', account: { id: '2' } }]
  const before = structuredClone(snapshot)
  const env = { ...f.env, NOTICE_KV: { get: async () => snapshot, put: async () => { throw new Error('must not cache reminder') } } }
  try {
    for (const code of ['29', null, 'bad']) {
      const response = await f.app.request('/api/v1/timelines/public', { headers: headers(jwt, code) }, env as never)
      const result = await statuses(response)
      assert.equal(result[0].id, 'app-update-required'); assert.deepEqual(result.slice(1), before)
      assert.equal(response.headers.get('X-ABDL-Timeline-Fallback'), 'snapshot')
      assert.deepEqual(snapshot, before)
    }
    for (const h of [headers(undefined, null, 'Mozilla/5.0'), headers(undefined, null, 'Mozilla/5.0 (Android)'), headers(undefined, '29', null), headers(jwt, '30')]) assert.deepEqual(await (await f.app.request('/api/v1/timelines/public', { headers: h }, env as never)).json(), before)
  } finally { f.close() }
})

test('reminder plaintext escapes every HTML delimiter, preserves newline and uses fixed reserved identity/link', () => {
  const status = buildAppUpdateNotice('&<>"\'\r\nnext\nlast')
  assert.match(status.content, /&amp;&lt;&gt;&quot;&#39;<br>next<br>last/)
  assert.equal(status.account.id, '-1'); assert.equal(status.id, 'app-update-required')
  assert.equal(status.url, 'https://m.abdl-space.top/app'); assert.deepEqual(status.media_attachments, [])
  assert.match(status.content, /href="https:\/\/m\.abdl-space\.top\/app"/)
  assert.equal(status.account.url, 'https://m.abdl-space.top/app')
  assert.equal(status.text, '&<>"\'\r\nnext\nlast\nhttps://m.abdl-space.top/app')
})

test('bounded transform preserves CORS/proxy/pagination/status headers, removes invalid body validators and replaces only reserved IDs', async () => {
  const f = fixture(); setReminder(f)
  const app = new Hono()
  const originals = [{ id: 'real1', content: 'unchanged', nested: { value: true } }, { id: 'app-update-required', content: 'old' }, { id: 'real2' }, { id: 'app-update-required' }]
  app.use('*', cors({ origin: 'https://abdl-space.top', exposeHeaders: ['Link', 'X-Next-Cursor'] }))
  app.use('*', appClientTimelineMiddleware)
  app.get('*', c => { c.header('Vary', 'Accept-Encoding'); return c.body(JSON.stringify(originals), 200, {
    'Content-Type': 'application/json; charset=utf-8', 'Content-Length': '123', ETag: 'old', 'Content-MD5': 'old', 'Content-Digest': 'old', Digest: 'old', 'Last-Modified': 'old',
    Link: '</real?max_id=real2>; rel="next", </real?min_id=real1>; rel="prev"', 'X-Next-Cursor': 'opaque-real-cursor', 'X-Proxy-Trace': 'retained',
  }) })
  try {
    const response = await app.request('/api/v1/timelines/public', { headers: { ...headers(), Origin: 'https://abdl-space.top' } }, f.env as never)
    const result = await statuses(response)
    assert.deepEqual(result.map(s => s.id), ['app-update-required', 'real1', 'real2'])
    assert.deepEqual(result.slice(1), [originals[0], originals[2]])
    assert.equal(originals.length, 4); assert.equal(originals[1].content, 'old')
    for (const key of ['Content-Length', 'ETag', 'Content-MD5', 'Content-Digest', 'Digest', 'Last-Modified']) assert.equal(response.headers.get(key), null, key)
    assert.equal(response.headers.get('X-Next-Cursor'), 'opaque-real-cursor'); assert.equal(response.headers.get('X-Proxy-Trace'), 'retained')
    assert.equal(response.headers.get('Link'), '</real?max_id=real2>; rel="next", </real?min_id=real1>; rel="prev"')
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://abdl-space.top')
    assert.match(response.headers.get('Access-Control-Expose-Headers') || '', /Link/)
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
    for (const key of ['Accept-Encoding', 'Origin', 'User-Agent', 'X-App-Version-Code', 'Authorization']) assert.match(response.headers.get('Vary') || '', new RegExp(key))
    assert.equal(f.reminderReads(), 1)
    const before = f.statements.length
    const preflight = await app.request('/api/v1/timelines/public', { method: 'OPTIONS', headers: { ...headers(), Origin: 'https://abdl-space.top', 'Access-Control-Request-Method': 'GET' } }, f.env as never)
    assert.equal(preflight.status, 204); assert.equal(f.statements.length, before)
  } finally { f.close() }
})

test('response transform never changes errors, objects, non-JSON, 204, malformed, encoded, oversized or failing bodies', async () => {
  const f = fixture(); setReminder(f)
  const maximum = 2 * 1024 * 1024
  const cases = [
    { status: 200, text: '{}', type: 'application/json' },
    { status: 400, text: '[{"id":"real"}]', type: 'application/json' },
    { status: 503, text: '{"error":"unavailable"}', type: 'application/json' },
    { status: 204, text: null, type: 'application/json' },
    { status: 200, text: '[{"id":"real"}]', type: 'text/plain' },
    { status: 200, text: '[broken', type: 'application/json' },
    { status: 200, text: '[]', type: 'application/json' },
    { status: 200, text: '[{"id":"real"}]', type: 'application/json', extra: { 'Content-Encoding': 'gzip' } },
    { status: 200, text: '[{"id":"real"}]', type: 'application/json', extra: { 'Content-Length': String(maximum + 1) } },
    { status: 200, text: JSON.stringify([{ id: 'large', text: '中'.repeat(maximum / 2) }]), type: 'application/json' },
  ]
  try {
    for (const item of cases) {
      const app = new Hono(); app.use('*', appClientTimelineMiddleware)
      app.get('*', () => new Response(item.text, { status: item.status, headers: { 'Content-Type': item.type, ETag: 'retain', ...item.extra } }))
      const response = await app.request('/api/v1/timelines/public', { headers: headers() }, f.env as never)
      assert.equal(response.status, item.status); assert.equal(await response.text(), item.text || '')
      assert.equal(response.headers.get('ETag'), 'retain'); assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
    }
    // A valid body exactly at the byte limit still transforms; byte count, not Content-Length, bounds reads.
    const exact = '[{"id":"boundary"}]' + ' '.repeat(maximum - '[{"id":"boundary"}]'.length)
    const boundary = new Hono(); boundary.use('*', appClientTimelineMiddleware); boundary.get('*', () => new Response(exact, { headers: { 'Content-Type': 'application/json' } }))
    const result = await boundary.request('/api/v1/timelines/public', { headers: headers() }, f.env as never)
    assert.deepEqual((await statuses(result)).map(s => s.id), ['app-update-required', 'boundary'])
    const invalidUTF = new Hono(); invalidUTF.use('*', appClientTimelineMiddleware)
    invalidUTF.get('*', () => new Response(new Uint8Array([91, 255, 93]), { headers: { 'Content-Type': 'application/json', ETag: 'retain' } }))
    const bad = await invalidUTF.request('/api/v1/timelines/public', { headers: headers() }, f.env as never)
    assert.deepEqual(new Uint8Array(await bad.arrayBuffer()), new Uint8Array([91, 255, 93])); assert.equal(bad.headers.get('ETag'), 'retain')
    const failed = new Hono(); failed.use('*', appClientTimelineMiddleware)
    failed.get('*', () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('body failure')) } }), { headers: { 'Content-Type': 'application/json', ETag: 'retain' } }))
    const errored = await failed.request('/api/v1/timelines/public', { headers: headers() }, f.env as never)
    assert.equal(errored.status, 200); assert.equal(errored.headers.get('ETag'), 'retain')
    await assert.rejects(errored.text(), /body failure/)
  } finally { f.close() }
})

test('initial-only reminder leaves legacy pagination/gap refresh untouched and reserved max cursor terminates without queries', async () => {
  const f = fixture(); setReminder(f); const jwt = await token()
  try {
    for (const query of ['max_id=p_100', 'min_id=p_100', 'since_id=p_100', 'cursor=opaque', 'offset=20', 'offset=20x']) {
      const response = await f.probe.request(`/api/v1/timelines/public?${query}`, { headers: headers(jwt) }, f.env as never)
      assert.deepEqual(await response.json(), [{ id: 'real' }], query)
      assert.equal(response.headers.get('Link'), '</next>; rel="next"')
    }
    assert.equal((await statuses(await f.probe.request('/api/v1/timelines/public?offset=0', { headers: headers(jwt) }, f.env as never)))[0].id, 'app-update-required')
    contentSchema(f)
    for (const query of ['max_id=p_1', 'max_id=app-update-required']) {
      const start = f.statements.length
      const response = await f.app.request(`/api/v1/timelines/public?${query}`, { headers: headers(jwt) }, f.env as never)
      assert.deepEqual(await response.json(), []); assert.equal(response.headers.get('Link'), null)
      if (query.includes('app-update-required')) assert.ok(f.statements.slice(start).every(sql => !/FROM posts/i.test(sql)))
    }
    setReminder(f, { enabled: false })
    assert.deepEqual(await (await f.app.request('/api/v1/timelines/public?max_id=app-update-required', { headers: headers(jwt) }, f.env as never)).json(), [])
    setPolicy(f)
    assert.equal((await statuses(await f.app.request('/api/v1/timelines/public?max_id=app-update-required', { headers: headers(jwt) }, f.env as never)))[0].id, 'app-update-required')
  } finally { f.close() }
})

test('actual NBW routes and alias preserve opaque real cursors and read reminder once per native request', async () => {
  const f = fixture(); setReminder(f); const jwt = await token()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ code: 200, data: { has_more: true, next_cursor: 'opaque-next', list: [{ tid: 123, authorid: 12, author: 'NBW', subject: 'real upstream', dateline: 1700000000 }] } })
  const env = { ...f.env, NBW_API_KEY: 'local-test-only' }
  try {
    for (const path of ['/api/v1/timelines/nbw', '/api/v1/abdl/nbw/sync-threads']) {
      const original = await f.app.request(path, { headers: headers(jwt, '30') }, env as never)
      const real = await original.json()
      for (const code of ['29', null, 'bad']) {
        const before = f.reminderReads()
        const response = await f.app.request(path, { headers: headers(jwt, code) }, env as never)
        const result = await statuses(response)
        assert.equal(result[0].id, 'app-update-required'); assert.deepEqual(result.slice(1), real)
        assert.equal(response.headers.get('Link'), original.headers.get('Link')); assert.match(response.headers.get('Link') || '', /opaque-next/)
        assert.equal(f.reminderReads(), before + 1)
        const page = await f.app.request(`${path}?cursor=opaque-next`, { headers: headers(jwt, code) }, env as never)
        assert.deepEqual((await statuses(page)).map(s => s.id), ['nbw_123'])
      }
    }
  } finally { globalThis.fetch = originalFetch; f.close() }
})

test('reminder preserves OAuth observation/auth and existing native rate limit without DB work after 429', async () => {
  const f = fixture(); setReminder(f)
  const env = { ...f.env, NBW_API_KEY: 'local-test-only', NOTICE_KV: { get: async () => [{ id: 'real' }] } }
  const h = { ...headers('reminder-oauth', null), 'CF-Connecting-IP': '192.0.2.251' }
  try {
    f.sqlite.exec(`INSERT INTO oauth_tokens VALUES('reminder-oauth',2,'read',${Math.floor(Date.now()/1000)+1000},0)`)
    for (let i = 0; i < 120; i++) {
      const response = await f.app.request('/api/v1/timelines/public', { headers: h }, env as never)
      assert.equal(response.status, 200); assert.equal(response.headers.get('X-App-Client-Observation'), 'recorded')
      assert.deepEqual((await statuses(response)).map(s => s.id), ['app-update-required', 'real'])
    }
    const before = f.statements.length
    const limited = await f.app.request('/api/v1/timelines/public', { headers: h }, env as never)
    assert.equal(limited.status, 429); assert.equal(f.statements.length, before)
    assert.equal(limited.headers.get('Cache-Control'), 'private, no-store')
    const alias = await f.app.request('/api/v1/abdl/nbw/sync-threads', { headers: h }, env as never)
    assert.equal(alias.status, 429); assert.equal(f.statements.length, before)
    assert.equal((await appClientStats(f.db as never)).totals.observed_users, 1)
  } finally { f.close() }
})
