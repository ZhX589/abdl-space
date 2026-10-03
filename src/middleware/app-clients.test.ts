import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL as NodeURL } from 'node:url'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import test from 'node:test'
import { Hono } from 'hono'
import { signJWT } from '../lib/auth.ts'
import { appClientStats, appClientUsers, defaultAppClientPolicy, isNativeAppClient, observeAppClient, parseAppVersionCode } from '../lib/app-clients.ts'
import { appClientTimelineMiddleware, appUpdateNotice } from './app-clients.ts'
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
  const statement = (sql: string, params: SQLInputValue[] = []) => ({
    bind: (...next: SQLInputValue[]) => statement(sql, next),
    async all() { statements.push(sql); return { success: true, results: sqlite.prepare(sql).all(...params) } },
    async run() { statements.push(sql); if (failWrite && sql.includes('app_client')) throw new Error('injected write failure'); const result = sqlite.prepare(sql).run(...params); return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } } },
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
  return { sqlite, db, env, app, probe, statements, failWrites: () => { failWrite = true }, close: () => sqlite.close() }
}
async function token(id = 2) { return signJWT({ sub: id, username: 'alice', email: 'b@test', role: id === 1 ? 'admin' : 'user' }, secret) }
function headers(jwt?: string, code: string | null = '29', ua: string | null = nativeUA) {
  return { ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}), ...(ua ? { 'User-Agent': ua } : {}), ...(code !== null ? { 'X-App-Version-Code': code } : {}), 'CF-Connecting-IP': '192.0.2.50', 'X-Real-Client-IP': '192.0.2.50' }
}
function setPolicy(f: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  const policy = { ...defaultAppClientPolicy(), enabled: true, deprecated_version_codes: [29], ...overrides }
  f.sqlite.prepare('UPDATE site_settings SET value=? WHERE key=?').run(JSON.stringify(policy), 'app_client_policy')
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
      assert.equal(list[0].account.id, '-1'); assert.match(list[0].content, /https:\/\/abdl-space.top\/app/)
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
    await observeAppClient(f.db as never, 2, 30, '2026-10-03T10:00:00.000Z')
    await observeAppClient(f.db as never, 2, 28, '2026-10-03T11:00:00.000Z')
    await observeAppClient(f.db as never, 2, 30, '2026-10-02T10:00:00.000Z')
    await observeAppClient(f.db as never, 2, null, '2026-10-03T12:00:00.000Z')
    const stats = await appClientStats(f.db as never, Date.parse('2026-10-03T20:00:00Z'))
    assert.equal(stats.totals.observed_users, 2); assert.equal(stats.totals.versioned_users, 2); assert.equal(stats.totals.unversioned_users, 1)
    assert.equal(stats.versions.reduce((sum, row) => sum + row.latest_users, 0), 2)
    assert.equal(stats.versions.find(row => row.version_code === null)?.latest_users, 1)
    assert.equal((await appClientUsers(f.db as never, 30, 1, 20, '')).users[0].last_seen_at, '2026-10-03T10:00:00.000Z')
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
