import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { createHash } from 'node:crypto'
import test, { type TestContext } from 'node:test'
import { Hono } from 'hono'
import albums from './albums.ts'
import { signJWT } from '../lib/auth.ts'
import { authorizeAlbumBatch, cancelAlbumHistoryReservation, cleanupAlbumObjects, ensureDefaultAlbum, getAlbumStorageQuota, reserveAlbumHistoryPhoto } from '../lib/albums.ts'
import type { AlbumEnv } from '../lib/albums.ts'
import type { Album, AlbumBatchAuthorization, AlbumComment, AlbumPhotosResponse, AlbumPublishResponse, PhotoDetailResponse, StorageQuota } from '../types/albums.ts'

const root = new URL('../../', import.meta.url)
const file = (path: string) => readFileSync(new URL(path, root), 'utf8')
const schema = file('schemas/schema.sql')
const migration = file('migrations/0071_baby_albums.sql')
const jpeg = (width = 320, height = 240) => Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0, 0xff, 0xd9])
const bytes = jpeg()
const md5 = createHash('md5').update(bytes).digest('base64')
const md5hex = createHash('md5').update(bytes).digest('hex')
const GIB = 1073741824
interface Control { beforeBatch?: () => void; beforeFirst?: (sql: string) => void; failStatement?: (sql: string) => boolean; failResults?: boolean; diagnostics: string[] }
interface Statement { sql: string; params: SQLInputValue[] }

function d1(db: DatabaseSync, controls: Control) {
  const statement = (sql: string, params: SQLInputValue[] = []) => ({
    sql, params, bind: (...values: SQLInputValue[]) => statement(sql, values),
    first: async <T>() => { controls.beforeFirst?.(sql); return (db.prepare(sql).get(...params) ?? null) as T | null },
    all: async <T>() => ({ success: true, results: db.prepare(sql).all(...params) as T[], meta: {} }),
    run: async () => { const r = db.prepare(sql).run(...params); return { success: true, meta: { changes: Number(r.changes) } } },
  })
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Statement[]) => {
      const hook = controls.beforeBatch; controls.beforeBatch = undefined; hook?.()
      db.exec('BEGIN IMMEDIATE')
      try {
        const results = statements.map(s => {
          if (controls.failStatement?.(s.sql)) throw new Error('injected later statement failure')
          const r = db.prepare(s.sql).all(...s.params)
          return { success: true, results: r, meta: { changes: Number(db.prepare('SELECT changes() AS n').get()?.n ?? 0) } }
        })
        if (controls.failResults) { db.exec('ROLLBACK'); return results.map(r => ({ ...r, success: false })) }
        db.exec('COMMIT'); return results
      } catch (error) { controls.diagnostics.push(String(error)); db.exec('ROLLBACK'); throw error }
    },
  }
}

async function fixture(protectionAvailable = true) {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); db.exec(protectionAvailable ? schema : schema.slice(0, schema.indexOf(file('migrations/0072_album_image_protection.sql').trim()))); db.exec(file('migrations/oauth.sql')); db.exec(file('migrations/0062_sponsors.sql')); db.exec(migration)
  db.exec("ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0; INSERT INTO users(id,email,password_hash,username) VALUES(1,'one@test.invalid','x','one'),(2,'two@test.invalid','x','two'),(3,'three@test.invalid','x','three')")
  const controls: Control = { diagnostics: [] }
  const env = { abdl_space_db: d1(db, controls), JWT_SECRET: 'album-route-test-secret', COS_SECRET_ID: 'test-id', COS_SECRET_KEY: 'test-key', COS_BUCKET: 'album-test-123', COS_REGION: 'ap-shanghai' }
  const tokens = await Promise.all([1, 2, 3].map(sub => signJWT({ sub, username: ['one', 'two', 'three'][sub - 1], email: 'unused@test.invalid', role: 'user' }, env.JWT_SECRET)))
  const app = new Hono(); app.route('/api/v1/albums', albums)
  const request = (path: string, body: unknown = undefined, method = body === undefined ? 'GET' : 'POST', user = 1, extra: Record<string, string> = {}) => app.request(`/api/v1/albums${path === '/' ? '' : path.startsWith('/?') ? path.slice(1) : path}`, { method, headers: { ...(user ? { Authorization: `Bearer ${tokens[user - 1]}` } : {}), ...(['GET', 'HEAD'].includes(method) ? {} : { 'Content-Type': 'application/json' }), ...extra }, ...(['GET', 'HEAD'].includes(method) ? {} : { body: JSON.stringify(body ?? {}) }) }, env as never)
  const libEnv: AlbumEnv = env as never
  const create = async (visibility = 'private', name = '测试相册') => { const response = await request('/', { visibility, name }); assert.equal(response.status, 201, JSON.stringify(await response.clone().json())); return (await response.json() as { album: Album }).album }
  const input = (quality = 'hd', operationId = crypto.randomUUID()) => ({ operation_id: operationId, description: 'a separate metadata description', captured_at: null, quality, photos: [{ client_id: 'z-first', width: 1600, height: 1200, variants: [{ kind: 'preview', mime_type: 'image/jpeg', size: bytes.byteLength, content_md5: md5, width: 320, height: 240 }, { kind: 'hd', mime_type: 'image/jpeg', size: bytes.byteLength, content_md5: md5 }, ...(quality === 'original' ? [{ kind: 'original', mime_type: 'image/jpeg', size: bytes.byteLength, content_md5: md5 }] : [])] }] })
  const authorize = async (albumId: string, body = input()) => { const response = await request(`/${albumId}/batches/authorize`, body); assert.equal(response.status, 200, JSON.stringify(await response.clone().json())); return { auth: await response.json() as AlbumBatchAuthorization, body } }
  const complete = async (auth: AlbumBatchAuthorization) => { for (const upload of auth.uploads) { const response = await request(`/uploads/${upload.upload_id}/complete`, {}); assert.equal(response.status, 200, JSON.stringify(await response.clone().json())) } }
  const publish = async (auth: AlbumBatchAuthorization) => { const response = await request(`/batches/${auth.batch_id}/publish`, {}); assert.equal(response.status, 200, JSON.stringify(await response.clone().json())); return await response.json() as AlbumPublishResponse }
  const mockCos = (t: TestContext, options: { actualBytes?: Uint8Array; length?: number; type?: string; etag?: string; status?: number; onHead?: () => void; deleteStatus?: number; headStatusOnce?: number } = {}) => {
    const calls: Array<{ method: string; url: string }> = []
    t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
      assert.equal(new URL(String(url)).hostname, 'album-test-123.cos.ap-shanghai.myqcloud.com'); assert.equal(init?.redirect, 'manual')
      const method = init?.method ?? 'GET'; calls.push({ method, url: String(url) }); assert.ok(new Headers(init?.headers).get('Authorization'))
      if (method === 'DELETE') return new Response(null, { status: options.deleteStatus ?? 200 })
      if (method === 'HEAD') {
        options.onHead?.()
        if (options.headStatusOnce) { const code = options.headStatusOnce; options.headStatusOnce = 0; return new Response(null, { status: code, headers: { 'x-cos-request-id': 'retry-fixture' } }) }
      }
      const data = options.actualBytes ?? bytes
      return new Response(method === 'HEAD' ? null : data, { status: options.status ?? 200, headers: { 'content-length': String(options.length ?? data.byteLength), 'content-type': options.type ?? 'image/jpeg', etag: options.etag ?? md5hex } })
    })
    return calls
  }
  const sponsor = (plan = 'week') => { db.exec("UPDATE sponsor_settings SET config_json=json_set(config_json,'$.enabled',json('true'))"); db.prepare("INSERT INTO sponsor_operations(id,operation_id,user_id,actor_id,kind,request_hash,reason,plan_json) SELECT ?,?,1,'1','grant','test','test',plan_json FROM sponsor_plans WHERE id=?").run(crypto.randomUUID(), crypto.randomUUID(), plan) }
  return { db, env, libEnv, request, controls, create, input, authorize, complete, publish, mockCos, sponsor, app, tokens }
}

test('album schema/bootstrap include complete replay-safe isolated migration without altering legacy uploads', () => {
  assert.ok(schema.includes(migration.trim()))
  assert.ok(file('scripts/database-bootstrap-files.mjs').includes('migrations/0071_baby_albums.sql'))
  assert.doesNotMatch(migration, /ALTER TABLE media_uploads|INSERT INTO post_images/)
  const db = new DatabaseSync(':memory:')
  try { db.exec(schema); db.exec(file('migrations/0062_sponsors.sql')); db.exec(migration); db.exec(migration); assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='album_batch_publish_apply'").get()) } finally { db.close() }
})

test('guest, invalid bearer/cookie and explicit OAuth read/write scope checks are fail closed', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.request('/', undefined, 'GET', 0)).status, 401)
    assert.equal((await f.request('/', undefined, 'GET', 1, { Authorization: 'Bearer bad', Cookie: `token=${f.tokens[0]}` })).status, 401)
    f.db.prepare("INSERT INTO oauth_clients(client_id,client_secret,name,redirect_uris,scopes,owner_id,created_at,updated_at) VALUES('album-client','secret','client','[]','read write',1,unixepoch(),unixepoch())").run()
    for (const scopes of ['read', 'write', '']) f.db.prepare('INSERT INTO oauth_tokens(access_token,refresh_token,client_id,user_id,scopes,access_expires_at,refresh_expires_at,created_at) VALUES(?,?,?,1,?,?,?,unixepoch())').run(`album-${scopes}`, `refresh-${scopes}`, 'album-client', scopes, Math.floor(Date.now() / 1000) + 3000, Math.floor(Date.now() / 1000) + 6000)
    assert.equal((await f.request('/', undefined, 'GET', 1, { Authorization: 'Bearer album-read' })).status, 200)
    assert.equal((await f.request('/', { name: 'no', visibility: 'private' }, 'POST', 1, { Authorization: 'Bearer album-read' })).status, 403)
    assert.equal((await f.request('/quota', undefined, 'GET', 1, { Authorization: 'Bearer album-write' })).status, 403)
    assert.equal((await f.request('/', { name: 'yes', visibility: 'public' }, 'POST', 1, { Authorization: 'Bearer album-write' })).status, 201)
    f.db.exec('UPDATE users SET banned=1 WHERE id=1')
    assert.equal((await f.request('/quota')).status, 401)
  } finally { f.db.close() }
})

test('default album is idempotent, private/immutable, owner metadata cannot be supplied and responses no-store', async () => {
  const f = await fixture()
  try {
    const defaults = await Promise.all([ensureDefaultAlbum(f.libEnv, 1), ensureDefaultAlbum(f.libEnv, 1)])
    assert.equal(defaults[0].id, defaults[1].id)
    const list = await f.request('/'); assert.equal(list.status, 200); assert.equal(list.headers.get('cache-control'), 'private, no-store')
    const album = (await list.json() as { albums: Album[] }).albums[0]; assert.equal(album.is_default, true); assert.equal(album.visibility, 'private')
    assert.equal((await f.request(`/${album.id}`, { name: 'new' }, 'PATCH')).status, 409)
    assert.equal((await f.request(`/${album.id}`, {}, 'DELETE')).status, 409)
    assert.equal((await f.request(`/${album.id}`, undefined, 'GET', 2)).status, 404)
    assert.equal((await f.request('/', { name: 'forged', visibility: 'public', owner_id: 2 })).status, 400)
    assert.equal((await f.request('/?owner_id=2')).status, 200)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM albums WHERE owner_id=2').get()?.n, 0)
    assert.equal((await f.request('/?limit=garbage')).status, 400)
    assert.equal((await f.request('/', { name: 'x', visibility: 'private' }, 'POST', 1, { Origin: 'https://evil.invalid' })).status, 403)
    f.db.exec("UPDATE album_rate_limits SET count=240 WHERE bucket='user:1:read'")
    assert.equal((await f.request('/')).status, 429)
  } finally { f.db.close() }
})

test('storage derives latest actual plan snapshot, ignores names/badges and drops tier on expiry without deleting photos', async () => {
  const f = await fixture()
  try {
    assert.equal((await getAlbumStorageQuota(f.libEnv, 1)).limit_bytes, 3 * GIB)
    f.db.exec("INSERT INTO sponsor_memberships(user_id,expires_at,plan_name) VALUES(1,unixepoch()+100000,'永久赞助者')")
    assert.equal((await getAlbumStorageQuota(f.libEnv, 1)).tier, 'week')
    for (const [tier, cap] of [['month', 10], ['quarter', 20], ['year', 50], ['week', 5]] as const) { f.sponsor(tier); const q = await getAlbumStorageQuota(f.libEnv, 1); assert.equal(q.tier, tier); assert.equal(q.limit_bytes, cap * GIB) }
    f.db.exec('UPDATE sponsor_memberships SET expires_at=unixepoch()-1')
    const expired = await getAlbumStorageQuota(f.libEnv, 1); assert.equal(expired.tier, 'free'); assert.equal(expired.original_upload_allowed, false)
    f.db.exec('UPDATE sponsor_memberships SET permanent=1')
    assert.equal((await getAlbumStorageQuota(f.libEnv, 1)).limit_bytes, 100 * GIB)
  } finally { f.db.close() }
})

test('public publish is atomic and idempotent; fallback exact, selected cover order stable, no post_images or private keys', async t => {
  const f = await fixture(); const calls = f.mockCos(t)
  try {
    const album = await f.create('public'); const body = f.input(); body.photos.push({ ...body.photos[0], client_id: 'a-second' })
    const { auth } = await f.authorize(album.id, body)
    assert.equal(auth.uploads[0].client_id, 'z-first')
    for (const upload of auth.uploads) {
      assert.equal(new URL(upload.upload_url).search, ''); assert.match(new URL(upload.upload_url).pathname, /^\/albums\/1\//)
      const h = upload.required_headers; assert.equal(h['x-cos-acl'], 'private'); assert.equal(h['x-cos-forbid-overwrite'], 'true'); assert.equal(h['Content-Length'], String(bytes.byteLength)); assert.equal(h['Content-MD5'], md5)
      assert.match(h.Authorization, /q-header-list=content-length;content-md5;content-type;host;x-cos-acl;x-cos-forbid-overwrite/)
    }
    const reserved = await (await f.request('/quota')).json() as StorageQuota; assert.equal(reserved.used_bytes, 0); assert.equal(reserved.reserved_bytes, bytes.byteLength * 4)
    assert.equal((await f.request(`/batches/${auth.batch_id}/publish`, {})).status, 409)
    await f.complete(auth)
    const result = await f.publish(auth); assert.equal(typeof result.post_id, 'number')
    assert.deepEqual(await f.publish(auth), result)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM posts').get()?.n, 1)
    assert.equal(f.db.prepare('SELECT content FROM posts').get()?.content, '【宝宝相册】当前渠道不支持查看此内容，请下载最新版ABDL Space APP查看详情')
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM post_images').get()?.n, 0)
    assert.equal(f.db.prepare('SELECT used_bytes FROM album_storage').get()?.used_bytes, bytes.byteLength * 4)
    const retry = await (await f.request(`/${album.id}/batches/authorize`, body)).json() as AlbumBatchAuthorization
    assert.equal(retry.published, true); assert.equal(retry.post_id, result.post_id); assert.deepEqual(retry.uploads, [])
    const dto = await (await f.request(`/${album.id}/photos`, undefined, 'GET', 2)).json() as AlbumPhotosResponse
    assert.equal(dto.photos.length, 2); assert.ok(dto.photos.every(p => p.hd_url === null && !p.original_available))
    assert.doesNotMatch(JSON.stringify(dto), /preview_key|hd_key|object_key|content_md5/)
    const before = calls.length; await f.request(`/${album.id}`); assert.equal(calls.length, before, 'GET signing performs no server fetch')
    const cover = (await (await f.request(`/${album.id}`)).json() as { album: Album }).album.cover_url!
    const first = f.db.prepare("SELECT photo_id FROM album_uploads WHERE batch_id=? AND client_id='z-first'").get(auth.batch_id)?.photo_id
    assert.ok(cover.includes(String(first)))
    await f.request(`/${album.id}`, { visibility: 'private' }, 'PATCH')
    assert.equal((await f.request(`/${album.id}/photos`, undefined, 'GET', 2)).status, 404)
    assert.equal((await f.request(`/photos/${dto.photos[0].id}/authorize`, { variant: 'hd', operation_id: crypto.randomUUID() }, 'POST', 2)).status, 404)
  } finally { f.db.close() }
})

test('authorize validates limits, source URLs, variant uniqueness, original entitlement and reserves no rejected bytes', async () => {
  const f = await fixture()
  try {
    const album = await f.create()
    const candidates: unknown[] = []
    const original = f.input('original'); candidates.push(original)
    for (const [kind, size] of [['preview', 2 * 1024 * 1024 + 1], ['hd', 10 * 1024 * 1024 + 1]] as const) { const b = f.input(); b.photos[0].variants.find(v => v.kind === kind)!.size = size; candidates.push(b) }
    const url = f.input(); candidates.push({ ...url, source_url: 'https://evil.invalid' })
    const dimensions = f.input(); dimensions.photos[0].variants[0].width = 541; candidates.push(dimensions)
    const duplicate = f.input(); duplicate.photos[0].variants[1].kind = 'preview'; candidates.push(duplicate)
    const maximum = f.input(); maximum.photos = Array.from({ length: 21 }, (_, n) => ({ ...maximum.photos[0], client_id: String(n) })); candidates.push(maximum)
    for (const b of candidates) assert.ok([400, 403].includes((await f.request(`/${album.id}/batches/authorize`, b)).status))
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM album_batches').get()?.n, 0)
    f.sponsor(); const exactOriginal = f.input('original'); exactOriginal.photos[0].variants[2].size = 20 * 1024 * 1024
    assert.equal((await f.request(`/${album.id}/batches/authorize`, exactOriginal)).status, 400)
    const auth = (await f.authorize(album.id)).auth
    assert.equal((await f.request(`/${album.id}/batches/authorize`, { ...f.input(), operation_id: (await f.request(`/batches/${auth.batch_id}`)).status })).status, 400)
  } finally { f.db.close() }
})

test('HEAD rejects missing/type/size/etag mismatches; physical preview cannot spoof dimensions or exceed declared bytes', async t => {
  for (const mismatch of [{ length: bytes.byteLength + 1 }, { type: 'text/html' }, { etag: 'f'.repeat(32) }, { status: 302 }, { status: 404 }]) {
    const f = await fixture(); const album = await f.create(); const { auth } = await f.authorize(album.id)
    f.mockCos(t, mismatch)
    const response = await f.request(`/uploads/${auth.uploads[0].upload_id}/complete`, {})
    assert.ok([409, 422, 502].includes(response.status))
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM album_uploads WHERE status='complete'").get()?.n, 0)
    t.mock.restoreAll(); f.db.close()
  }
  const f = await fixture()
  try {
    const album = await f.create(); const b = f.input(); const actual = jpeg(1000, 800); const digest = createHash('md5').update(actual).digest('base64'); b.photos[0].variants[0].content_md5 = digest
    const { auth } = await f.authorize(album.id, b); f.mockCos(t, { actualBytes: actual, etag: createHash('md5').update(actual).digest('hex') })
    const preview = auth.uploads.find(u => u.kind === 'preview')!
    const response = await f.request(`/uploads/${preview.upload_id}/complete`, {}); assert.equal(response.status, 422); assert.equal((await response.json() as { code: string }).code, 'album_preview_dimensions')
  } finally { f.db.close() }
})

test('quota reservation races and five pending batches enforce transactional ceiling, idempotency never double reserves', async () => {
  const f = await fixture()
  try {
    const album = await f.create(); const a = f.input(); const b = f.input()
    f.db.prepare('INSERT INTO album_storage(user_id,used_bytes) VALUES(1,?)').run(3 * GIB - bytes.byteLength * 2)
    const results = await Promise.all([f.request(`/${album.id}/batches/authorize`, a), f.request(`/${album.id}/batches/authorize`, b)])
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409])
    const winning = results[0].status === 200 ? a : b
    assert.equal((await f.request(`/${album.id}/batches/authorize`, winning)).status, 200)
    assert.equal(f.db.prepare('SELECT reserved_bytes FROM album_storage').get()?.reserved_bytes, bytes.byteLength * 2)
    assert.equal((await f.request(`/${album.id}/batches/authorize`, { ...winning, description: 'different' })).status, 409)
    f.db.exec('UPDATE album_storage SET used_bytes=0')
    for (let n = 0; n < 4; n++) await f.authorize(album.id)
    assert.equal((await f.request(`/${album.id}/batches/authorize`, f.input())).status, 429)
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM album_batches WHERE status='pending'").get()?.n, 5)
  } finally { f.db.close() }
})

test('publication rechecks quota and original membership, and late write/unsuccessful batch rolls all photos/posts/bytes back', async t => {
  const f = await fixture(); f.mockCos(t)
  try {
    const album = await f.create('public'); f.sponsor('month'); const { auth } = await f.authorize(album.id, f.input('original')); await f.complete(auth)
    f.db.exec('UPDATE sponsor_memberships SET expires_at=unixepoch()-1')
    assert.equal((await f.request(`/batches/${auth.batch_id}/publish`, {})).status, 403)
    f.db.exec('UPDATE sponsor_memberships SET expires_at=unixepoch()+600')
    f.db.prepare('UPDATE album_storage SET used_bytes=?').run(10 * GIB)
    assert.equal((await f.request(`/batches/${auth.batch_id}/publish`, {})).status, 409)
    f.db.exec('UPDATE album_storage SET used_bytes=0')
    f.controls.failStatement = sql => sql.includes('EXISTS(SELECT 1 FROM album_batches WHERE id=') && sql.startsWith('INSERT INTO album_transaction_guards')
    assert.equal((await f.request(`/batches/${auth.batch_id}/publish`, {})).status, 503)
    f.controls.failStatement = undefined
    for (const table of ['posts', 'album_photos']) assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n, 0)
    assert.equal(f.db.prepare('SELECT used_bytes FROM album_storage').get()?.used_bytes, 0)
    assert.equal(f.db.prepare('SELECT status FROM album_batches').get()?.status, 'pending')
    f.controls.failResults = true
    assert.equal((await f.request(`/batches/${auth.batch_id}/publish`, {})).status, 503)
    f.controls.failResults = false
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM posts').get()?.n, 0)
    await f.publish(auth)
  } finally { f.db.close() }
})

test('completion rechecks membership after HEAD and publication rejects current owner/album deletion races', async t => {
  const f = await fixture()
  try {
    const album = await f.create('public'); f.sponsor(); const { auth } = await f.authorize(album.id, f.input('original'))
    f.mockCos(t, { onHead: () => f.db.exec('UPDATE sponsor_memberships SET expires_at=unixepoch()-1') })
    assert.equal((await f.request(`/uploads/${auth.uploads[0].upload_id}/complete`, {})).status, 409)
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM album_uploads WHERE status='complete'").get()?.n, 0)
    t.mock.restoreAll(); f.mockCos(t); f.db.exec('UPDATE sponsor_memberships SET expires_at=unixepoch()+600'); await f.complete(auth)
    f.controls.beforeBatch = () => f.db.prepare('UPDATE albums SET deleted_at=unixepoch() WHERE id=?').run(album.id)
    assert.equal((await f.request(`/batches/${auth.batch_id}/publish`, {})).status, 409)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM posts').get()?.n, 0)
  } finally { f.db.close() }
})

test('completion retries transient storage verification failures with bounded backoff; 404 is never retried', async t => {
  const f = await fixture()
  try {
    const album = await f.create(); const { auth } = await f.authorize(album.id)
    // First preview HEAD fails with a transient 503, the retry succeeds: one extra HEAD, upload completes.
    const calls = f.mockCos(t, { headStatusOnce: 503 })
    await f.complete(auth)
    assert.equal(calls.filter(call => call.method === 'HEAD').length, auth.uploads.length + 1)
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM album_uploads WHERE status='complete'").get()?.n, auth.uploads.length)
  } finally { f.db.close() }
  const g = await fixture()
  try {
    const album = await g.create(); const { auth } = await g.authorize(album.id)
    // A definitive missing object must stay an immediate upload_object_missing answer with no retry.
    const calls = g.mockCos(t, { status: 404 })
    const response = await g.request(`/uploads/${auth.uploads[0].upload_id}/complete`, {})
    assert.equal(response.status, 409); assert.equal((await response.json() as { code: string }).code, 'upload_object_missing')
    assert.equal(calls.filter(call => call.method === 'HEAD').length, 1)
    assert.equal(g.db.prepare("SELECT count(*) AS n FROM album_uploads WHERE status='complete'").get()?.n, 0)
  } finally { g.db.close() }
})

test('shared members can read/like/comment only; rotated invites, self-leave, removal and private transitions revoke access', async t => {
  const f = await fixture(); f.mockCos(t)
  try {
    const album = await f.create('shared'); const { auth } = await f.authorize(album.id); await f.complete(auth); await f.publish(auth)
    const photo = f.db.prepare('SELECT id FROM album_photos').get()?.id as string
    const first = await (await f.request(`/${album.id}/invites`, {})).json() as { token: string }
    const second = await (await f.request(`/${album.id}/invites`, {})).json() as { token: string }
    assert.notEqual(first.token, second.token); assert.equal(first.token.length, 64)
    assert.equal(f.db.prepare('SELECT token_hash FROM album_invites').get()?.token_hash, createHash('sha256').update(second.token).digest('hex'))
    assert.equal((await f.request('/join', { token: first.token }, 'POST', 2)).status, 404)
    for (let n = 0; n < 2; n++) assert.equal((await f.request('/join', { token: second.token }, 'POST', 2)).status, 200)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM album_members').get()?.n, 1)
    assert.equal((await f.request(`/${album.id}/batches/authorize`, f.input(), 'POST', 2)).status, 403)
    assert.equal((await f.request(`/${album.id}`, { visibility: 'public' }, 'PATCH', 2)).status, 403)
    assert.equal((await f.request(`/${album.id}`, {}, 'DELETE', 2)).status, 403)
    assert.deepEqual(await (await f.request(`/photos/${photo}/like`, { liked: true }, 'POST', 2)).json(), { liked: true, likes_count: 1 })
    assert.deepEqual(await (await f.request(`/photos/${photo}/like`, { liked: true }, 'POST', 2)).json(), { liked: true, likes_count: 1 })
    const commentBody = { content: '可爱', operation_id: crypto.randomUUID() }
    const comment = (await (await f.request(`/photos/${photo}/comments`, commentBody, 'POST', 2)).json() as { comment: AlbumComment }).comment
    const replay = (await (await f.request(`/photos/${photo}/comments`, commentBody, 'POST', 2)).json() as { comment: AlbumComment }).comment; assert.equal(replay.id, comment.id)
    assert.equal((await f.request(`/photos/${photo}/comments`, { ...commentBody, content: 'changed' }, 'POST', 2)).status, 409)
    assert.equal((await f.request(`/comments/${comment.id}`, {}, 'DELETE', 3)).status, 404)
    assert.equal((await f.request(`/comments/${comment.id}`, {}, 'DELETE')).status, 200)
    assert.equal((await f.request(`/${album.id}/members/3`, {}, 'DELETE', 2)).status, 403)
    assert.equal((await f.request(`/${album.id}/members/2`, {}, 'DELETE', 2)).status, 200)
    assert.equal((await f.request(`/${album.id}/photos`, undefined, 'GET', 2)).status, 404)
    assert.equal((await f.request('/join', { token: second.token }, 'POST', 2)).status, 200)
    assert.equal((await f.request(`/${album.id}/members/2`, {}, 'DELETE')).status, 200)
    assert.equal((await f.request(`/photos/${photo}/like`, { liked: false }, 'POST', 2)).status, 404)
    await f.request('/join', { token: second.token }, 'POST', 2)
    await f.request(`/${album.id}`, { visibility: 'private' }, 'PATCH')
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM album_members').get()?.n, 0)
    assert.equal((await f.request('/join', { token: second.token }, 'POST', 2)).status, 404)
  } finally { f.db.close() }
})

test('membership deletion in the actual like/comment/HD quota transaction rolls mutation and charge back', async t => {
  const f = await fixture(); f.mockCos(t)
  try {
    const album = await f.create('shared'); const { auth } = await f.authorize(album.id); await f.complete(auth); await f.publish(auth)
    const photo = f.db.prepare('SELECT id FROM album_photos').get()?.id as string
    f.db.exec("UPDATE sponsor_settings SET config_json=json_set(config_json,'$.enabled',json('true'))")
    for (const action of ['like', 'comments', 'authorize']) {
      f.db.prepare('INSERT OR IGNORE INTO album_members(album_id,user_id) VALUES(?,2)').run(album.id)
      f.controls.beforeBatch = () => f.db.prepare('DELETE FROM album_members WHERE album_id=? AND user_id=2').run(album.id)
      const body = action === 'like' ? { liked: true } : action === 'comments' ? { content: 'race', operation_id: crypto.randomUUID() } : { variant: 'hd', operation_id: crypto.randomUUID(), notice_version: 1 }
      assert.ok([409, 503].includes((await f.request(`/photos/${photo}/${action}`, body, 'POST', 2)).status))
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM album_likes').get()?.n, 0)
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM album_comments').get()?.n, 0)
      assert.equal(f.db.prepare("SELECT count(*) AS n FROM sponsor_operations WHERE kind='original'").get()?.n, 0)
    }
  } finally { f.db.close() }
})

test('original always owner/quota-only even after sponsor expiry; HD free live sponsor only; quota notice/idempotent replay', async t => {
  const f = await fixture(); const calls = f.mockCos(t)
  try {
    const album = await f.create('public'); f.sponsor(); const { auth } = await f.authorize(album.id, f.input('original')); await f.complete(auth); await f.publish(auth)
    const photo = f.db.prepare('SELECT id FROM album_photos').get()?.id as string
    assert.equal((await f.request(`/photos/${photo}/authorize`, { variant: 'original', operation_id: crypto.randomUUID() }, 'POST', 2)).status, 403)
    const before = calls.length
    const free = await f.request(`/photos/${photo}/authorize`, { variant: 'hd', operation_id: crypto.randomUUID() }); assert.equal(free.status, 200); assert.equal((await free.json() as { charged: boolean }).charged, false); assert.equal(calls.length, before)
    const op = crypto.randomUUID(); const request = { variant: 'original', operation_id: op }
    const charged = await f.request(`/photos/${photo}/authorize`, request); assert.equal(charged.status, 200); assert.equal((await charged.json() as { charged: boolean }).charged, true)
    const repeat = await f.request(`/photos/${photo}/authorize`, request); assert.equal((await repeat.json() as { charged: boolean }).charged, false)
    assert.equal(f.db.prepare('SELECT used FROM sponsor_daily_usage WHERE user_id=1').get()?.used, 1)
    f.db.exec('UPDATE sponsor_memberships SET expires_at=unixepoch()-1')
    const notice = await f.request(`/photos/${photo}/authorize`, { variant: 'original', operation_id: crypto.randomUUID() }); assert.equal(notice.status, 409); assert.equal((await notice.json() as { code: string }).code, 'notice_required')
    const expired = await f.request(`/photos/${photo}/authorize`, { variant: 'original', operation_id: crypto.randomUUID(), notice_version: 1 }); assert.equal(expired.status, 200)
    assert.equal(f.db.prepare('SELECT used FROM sponsor_daily_usage WHERE user_id=1').get()?.used, 2)
    const sharedOp = crypto.randomUUID()
    assert.equal((await f.request(`/photos/${photo}/authorize`, { variant: 'original', operation_id: sharedOp, notice_version: 1 })).status, 200)
    assert.equal((await f.request(`/photos/${photo}/authorize`, { variant: 'hd', operation_id: sharedOp, notice_version: 1 })).status, 409)
    const exhausted = await f.request(`/photos/${photo}/authorize`, { variant: 'original', operation_id: crypto.randomUUID(), notice_version: 1 })
    assert.equal(exhausted.status, 402); assert.equal((await exhausted.json() as { code: string }).code, 'quota_exhausted')
    f.db.exec("UPDATE sponsor_settings SET config_json=json_set(config_json,'$.enabled',json('false'))")
    assert.equal((await f.request(`/photos/${photo}/authorize`, { variant: 'original', operation_id: crypto.randomUUID() })).status, 503)
    const bypass = await f.request(`/photos/${photo}/authorize`, { variant: 'hd', operation_id: crypto.randomUUID() }, 'POST', 2); assert.equal(bypass.status, 200); assert.equal((await bypass.json() as { charged: boolean }).charged, false)
    const dto = await (await f.request(`/${album.id}/photos`)).json() as AlbumPhotosResponse; assert.equal(dto.photos[0].hd_url, null); assert.equal(dto.photos[0].original_available, true)
  } finally { f.db.close() }
})

test('completed variants reauthorization renews every signed lease; cancel/delete never release bytes before safe deletion', async t => {
  const f = await fixture(); const calls = f.mockCos(t)
  try {
    const album = await f.create(); const { auth, body } = await f.authorize(album.id); await f.complete(auth)
    f.db.exec('UPDATE album_uploads SET expires_at=unixepoch()-1')
    const renewed = await (await f.request(`/${album.id}/batches/authorize`, body)).json() as AlbumBatchAuthorization
    for (const u of renewed.uploads) assert.equal(f.db.prepare('SELECT expires_at FROM album_uploads WHERE id=?').get(u.upload_id)?.expires_at, u.expires_at)
    assert.equal((await f.request(`/batches/${auth.batch_id}/cancel`, {})).status, 200)
    assert.equal((await f.request(`/batches/${auth.batch_id}/cancel`, {})).status, 200)
    assert.equal((await f.request(`/batches/${auth.batch_id}/publish`, {})).status, 409)
    assert.equal(f.db.prepare('SELECT reserved_bytes FROM album_storage').get()?.reserved_bytes, bytes.byteLength * 2)
    assert.equal(calls.filter(c => c.method === 'DELETE').length, 0)
    f.db.exec('UPDATE album_uploads SET expires_at=unixepoch()-1')
    await cleanupAlbumObjects(f.libEnv, 1)
    assert.equal(f.db.prepare('SELECT reserved_bytes FROM album_storage').get()?.reserved_bytes, 0)
    await cleanupAlbumObjects(f.libEnv, 1)
    assert.equal(f.db.prepare('SELECT reserved_bytes FROM album_storage').get()?.reserved_bytes, 0)
    const next = (await f.authorize(album.id)).auth; await f.complete(next); await f.publish(next)
    const photo = f.db.prepare('SELECT id FROM album_photos').get()?.id as string
    assert.equal((await f.request(`/photos/${photo}`, {}, 'DELETE', 2)).status, 404)
    await f.request(`/${album.id}`, {}, 'DELETE')
    assert.equal((await f.request(`/${album.id}`)).status, 404)
    assert.equal(f.db.prepare('SELECT used_bytes FROM album_storage').get()?.used_bytes, bytes.byteLength * 2)
    f.db.exec('UPDATE album_uploads SET expires_at=unixepoch()-1')
    t.mock.restoreAll(); f.mockCos(t, { deleteStatus: 503 }); await cleanupAlbumObjects(f.libEnv, 1)
    assert.equal(f.db.prepare('SELECT used_bytes FROM album_storage').get()?.used_bytes, bytes.byteLength * 2)
    t.mock.restoreAll(); f.mockCos(t, { deleteStatus: 404 }); await cleanupAlbumObjects(f.libEnv, 1)
    assert.equal(f.db.prepare('SELECT used_bytes FROM album_storage').get()?.used_bytes, 0)
  } finally { f.db.close() }
})

test('history reserve-first is quota atomic, deduped and retains reservation on cancelled COS deletion failure', async t => {
  const f = await fixture(); f.mockCos(t, { deleteStatus: 503 })
  try {
    f.db.exec("INSERT INTO posts(id,user_id,content) VALUES(10,1,'old'); INSERT INTO post_images(id,post_id,image_url) VALUES(11,10,'https://old.invalid/photo')")
    const input = { sourcePostImageId: 11, sourceUploadId: null, previewKey: 'albums/1/history/test/preview', hdKey: 'albums/1/history/test/hd', previewBytes: bytes.byteLength, hdBytes: bytes.byteLength, width: 1600, height: 1200, description: 'old', capturedAt: null, uploadedAt: 1, previewMimeType: 'image/jpeg', hdMimeType: 'image/jpeg', previewMd5: md5, hdMd5: md5 }
    const reservation = await reserveAlbumHistoryPhoto(f.libEnv, 1, input); assert.equal(reservation.created, true); assert.equal(reservation.published, false)
    const retry = await reserveAlbumHistoryPhoto(f.libEnv, 1, { ...input, previewKey: 'albums/1/history/other/preview', hdKey: 'albums/1/history/other/hd' }); assert.equal(retry.created, false); assert.equal(retry.preview_key, input.previewKey)
    assert.equal(f.db.prepare('SELECT reserved_bytes FROM album_storage').get()?.reserved_bytes, bytes.byteLength * 2)
    await cancelAlbumHistoryReservation(f.libEnv, 1, reservation.batch_id)
    f.db.exec('UPDATE album_uploads SET expires_at=unixepoch()-1')
    await cleanupAlbumObjects(f.libEnv, 1)
    assert.equal(f.db.prepare('SELECT reserved_bytes FROM album_storage').get()?.reserved_bytes, bytes.byteLength * 2)
    f.db.prepare('UPDATE album_storage SET used_bytes=?').run(3 * GIB)
    await assert.rejects(reserveAlbumHistoryPhoto(f.libEnv, 1, input), /存储空间不足/)
  } finally { f.db.close() }
})

test('literal trailing-slash album root/import handler and bounded request JSON are supported', async () => {
  const f = await fixture()
  try {
    for (const method of ['GET', 'POST']) {
      const r = await f.app.request('/api/v1/albums/', { method, headers: { Authorization: `Bearer ${f.tokens[0]}`, 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify({ name: 'slash', visibility: 'private' }) } : {}) }, f.env as never)
      assert.equal(r.status, method === 'GET' ? 200 : 201)
      assert.equal(r.headers.get('cache-control'), 'private, no-store')
    }
    const imported = await f.request('/import-history', {}); assert.equal(imported.status, 200); assert.deepEqual(await imported.json(), { imported: 0, skipped: 0, remaining: false })
    assert.equal((await f.request('/import-history', { owner_id: 2 })).status, 400)
    assert.equal((await f.request('/', { name: 'x'.repeat(70000), visibility: 'private' })).status, 413)
  } finally { f.db.close() }
})

test('Android simple lossless/lossy WebP previews verify actual dimensions and MD5 before completion', async t => {
  for (const kind of ['VP8L', 'VP8 ']) {
    const f = await fixture()
    try {
      const size = kind === 'VP8L' ? 6 : 10
      const webp = new Uint8Array(20 + size); const view = new DataView(webp.buffer)
      webp.set(new TextEncoder().encode('RIFF'), 0); view.setUint32(4, webp.length - 8, true); webp.set(new TextEncoder().encode('WEBP'), 8); webp.set(new TextEncoder().encode(kind), 12); view.setUint32(16, size, true)
      if (kind === 'VP8L') { webp[20] = 0x2f; view.setUint32(21, (319 | (239 << 14)) >>> 0, true) }
      else { webp[23] = 0x9d; webp[24] = 1; webp[25] = 0x2a; view.setUint16(26, 320, true); view.setUint16(28, 240, true) }
      const album = await f.create(); const b = f.input(); b.photos[0].variants[0] = { kind: 'preview', mime_type: 'image/webp', size: webp.byteLength, content_md5: createHash('md5').update(webp).digest('base64'), width: 320, height: 240 }
      const { auth } = await f.authorize(album.id, b); f.mockCos(t, { actualBytes: webp, type: 'image/webp', etag: createHash('md5').update(webp).digest('hex') })
      const preview = auth.uploads.find(u => u.kind === 'preview')!
      assert.equal((await f.request(`/uploads/${preview.upload_id}/complete`, {})).status, 200)
    } finally { t.mock.restoreAll(); f.db.close() }
  }
})

test('free owner HD authorization rechecks live sponsor transaction state and safely falls back to a charged quota', async t => {
  const f = await fixture(); f.mockCos(t)
  try {
    const album = await f.create(); f.sponsor(); const { auth } = await f.authorize(album.id); await f.complete(auth); await f.publish(auth)
    const photo = String(f.db.prepare('SELECT id FROM album_photos').get()?.id)
    f.controls.beforeBatch = () => f.db.exec('UPDATE sponsor_memberships SET expires_at=unixepoch()-1')
    const response = await f.request(`/photos/${photo}/authorize`, { variant: 'hd', operation_id: crypto.randomUUID(), notice_version: 1 })
    assert.equal(response.status, 200); assert.equal((await response.json() as { charged: boolean }).charged, true)
    assert.equal(f.db.prepare('SELECT used FROM sponsor_daily_usage').get()?.used, 1)
  } finally { f.db.close() }
})

test('omitted capture time equals explicit null for batch idempotency and defaults photo sort to upload time', async t => {
  const f = await fixture(); f.mockCos(t)
  try {
    const album = await f.create()
    const explicit = f.input()
    const omitted: Partial<typeof explicit> = { ...explicit }
    delete omitted.captured_at
    const first = await f.request(`/${album.id}/batches/authorize`, omitted)
    assert.equal(first.status, 200)
    const auth = await first.json() as AlbumBatchAuthorization
    const repeat = await f.request(`/${album.id}/batches/authorize`, explicit)
    assert.equal(repeat.status, 200)
    assert.equal((await repeat.json() as AlbumBatchAuthorization).batch_id, auth.batch_id)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM album_batches').get()?.n, 1)
    assert.equal(f.db.prepare('SELECT captured_at FROM album_batches').get()?.captured_at, null)
    assert.equal(f.db.prepare('SELECT reserved_bytes FROM album_storage').get()?.reserved_bytes, bytes.byteLength * 2)
    assert.equal((await f.request(`/${album.id}/batches/authorize`, { ...explicit, captured_at: 123 })).status, 409)
    await f.complete(auth); await f.publish(auth)
    const photo = String(f.db.prepare('SELECT id FROM album_photos').get()?.id)
    const fresh = await (await f.request(`/photos/${photo}`)).json() as PhotoDetailResponse
    assert.equal(fresh.photo.captured_at, null); assert.equal(fresh.photo.sort_at, fresh.photo.uploaded_at)
    const publishedRetry = await f.request(`/${album.id}/batches/authorize`, omitted)
    assert.equal(publishedRetry.status, 200); assert.equal((await publishedRetry.json() as AlbumBatchAuthorization).published, true)
  } finally { f.db.close() }
})

test('single-photo renewal signs fresh previews without fetch or quota and withholds HD/original for nonowners', async t => {
  const f = await fixture(); const calls = f.mockCos(t)
  try {
    const album = await f.create('shared'); f.sponsor()
    const { auth } = await f.authorize(album.id, f.input('original')); await f.complete(auth); await f.publish(auth)
    const photo = String(f.db.prepare('SELECT id FROM album_photos').get()?.id)
    const invite = await (await f.request(`/${album.id}/invites`, {})).json() as { token: string }
    await f.request('/join', { token: invite.token }, 'POST', 2)
    const fetchesBefore = calls.length
    const firstResponse = await f.request(`/photos/${photo}`, undefined, 'GET', 2)
    assert.equal(firstResponse.status, 200); assert.equal(firstResponse.headers.get('cache-control'), 'private, no-store')
    const first = (await firstResponse.json() as PhotoDetailResponse).photo
    assert.equal(first.hd_url, null); assert.equal(first.original_available, false)
    assert.doesNotMatch(JSON.stringify(first), /object_key|preview_key|hd_key|original_key|\/hd\.jpg|\/original\.jpg/)
    const now = Date.now()
    t.mock.timers.enable({ apis: ['Date'], now: now + 61000 })
    const renewed = await f.request(`/photos/${photo}`, undefined, 'GET', 2)
    assert.equal(renewed.status, 200)
    const fresh = (await renewed.json() as PhotoDetailResponse).photo
    assert.notEqual(fresh.preview_url, first.preview_url)
    const oldTime = new URL(first.preview_url).searchParams.get('q-sign-time')!.split(';').map(Number)
    const newTime = new URL(fresh.preview_url).searchParams.get('q-sign-time')!.split(';').map(Number)
    assert.equal(newTime[1] - newTime[0], 60); assert.ok(newTime[0] >= oldTime[1])
    const owner = (await (await f.request(`/photos/${photo}`)).json() as PhotoDetailResponse).photo
    assert.ok(owner.hd_url); assert.equal(owner.original_available, true)
    assert.equal(calls.length, fetchesBefore, 'preview renewal never fetches COS')
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM sponsor_operations WHERE kind='original'").get()?.n, 0)
    await f.request(`/${album.id}/members/2`, {}, 'DELETE')
    assert.equal((await f.request(`/photos/${photo}`, undefined, 'GET', 2)).status, 404)
    f.db.exec('UPDATE sponsor_memberships SET expires_at=unixepoch()-1')
    const expiredOwner = (await (await f.request(`/photos/${photo}`)).json() as PhotoDetailResponse).photo
    assert.equal(expiredOwner.hd_url, null); assert.equal(expiredOwner.original_available, true)
    await f.request(`/${album.id}`, { visibility: 'private' }, 'PATCH')
    assert.equal((await f.request(`/photos/${photo}`, undefined, 'GET', 2)).status, 404)
    assert.equal((await f.request(`/photos/${photo}`, undefined, 'GET', 0)).status, 401)
  } finally { f.db.close() }
})

test('single-photo renewal final recheck rejects membership deletion and strips sponsor HD revocation during signing', async t => {
  const f = await fixture(); f.mockCos(t)
  try {
    const album = await f.create('shared'); f.sponsor()
    const { auth } = await f.authorize(album.id, f.input('original')); await f.complete(auth); await f.publish(auth)
    const photo = String(f.db.prepare('SELECT id FROM album_photos').get()?.id)
    f.db.prepare('INSERT INTO album_members(album_id,user_id) VALUES(?,2)').run(album.id)
    let sponsorReads = 0
    f.controls.beforeFirst = sql => {
      if (sql.includes('SELECT EXISTS(SELECT 1 FROM sponsor_memberships') && ++sponsorReads === 1) {
        f.db.prepare('DELETE FROM album_members WHERE album_id=? AND user_id=2').run(album.id)
        f.controls.beforeFirst = undefined
      }
    }
    assert.equal((await f.request(`/photos/${photo}`, undefined, 'GET', 2)).status, 404)
    sponsorReads = 0
    f.controls.beforeFirst = sql => {
      if (sql.includes('SELECT EXISTS(SELECT 1 FROM sponsor_memberships') && ++sponsorReads === 2) {
        f.db.exec('UPDATE sponsor_memberships SET expires_at=unixepoch()-1')
        f.controls.beforeFirst = undefined
      }
    }
    const owner = await f.request(`/photos/${photo}`)
    assert.equal(owner.status, 200)
    const dto = (await owner.json() as PhotoDetailResponse).photo
    assert.equal(dto.hd_url, null); assert.equal(dto.owner_sponsor, false)
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM sponsor_operations WHERE kind='original'").get()?.n, 0)
    f.controls.beforeFirst = sql => {
      if (sql.includes('SELECT EXISTS(SELECT 1 FROM sponsor_memberships')) {
        f.db.prepare('UPDATE album_photos SET deleted_at=unixepoch() WHERE id=?').run(photo)
        f.controls.beforeFirst = undefined
      }
    }
    assert.equal((await f.request(`/photos/${photo}`)).status, 404)
  } finally { f.db.close() }
})

test('reservation late write failure and quota race during atomic reserve roll back all batches/uploads/storage', async () => {
  const f = await fixture()
  try {
    const album = await f.create()
    f.controls.failStatement = sql => sql.startsWith('INSERT INTO album_uploads')
    await assert.rejects(authorizeAlbumBatch(f.libEnv, 1, album.id, f.input()))
    for (const table of ['album_batches', 'album_uploads', 'album_storage']) assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n, 0)
    f.controls.failStatement = undefined
    f.controls.beforeBatch = () => f.db.prepare('INSERT INTO album_storage(user_id,used_bytes) VALUES(1,?)').run(3 * GIB)
    assert.equal((await f.request(`/${album.id}/batches/authorize`, f.input())).status, 409)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM album_batches').get()?.n, 0)
  } finally { f.db.close() }
})

test('protection migration is additive, false-default, replay-safe on old/fresh databases and rejects invalid state atomically', () => {
  const protection = file('migrations/0072_album_image_protection.sql')
  assert.ok(schema.includes(protection.trim()))
  assert.ok(file('scripts/database-bootstrap-files.mjs').includes('migrations/0072_album_image_protection.sql'))
  assert.doesNotMatch(protection, /\b(?:ALTER|DROP)\b/i)
  for (const fresh of [false, true]) {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec('PRAGMA foreign_keys=ON')
      db.exec(fresh ? schema : schema.slice(0, schema.indexOf(protection.trim())))
      db.exec("INSERT INTO users(id,email,password_hash,username) VALUES(1,'migration@test.invalid','x','migration'); INSERT INTO albums(id,owner_id,name,visibility) VALUES('old',1,'old','public')")
      db.exec(protection); db.exec(protection); db.exec(migration)
      assert.equal(db.prepare('SELECT coalesce(p.download_protected,0) AS flag FROM albums a LEFT JOIN album_protection p ON p.album_id=a.id WHERE a.id=?').get('old')?.flag, 0)
      db.exec("INSERT INTO album_protection(album_id) VALUES('old')")
      assert.equal(db.prepare('SELECT download_protected FROM album_protection').get()?.download_protected, 0)
      db.exec('BEGIN IMMEDIATE')
      assert.throws(() => db.exec("UPDATE album_protection SET download_protected=1; UPDATE album_protection SET download_protected=2"), /CHECK/)
      db.exec('ROLLBACK')
      assert.equal(db.prepare('SELECT download_protected FROM album_protection').get()?.download_protected, 0)
      assert.throws(() => db.exec("INSERT INTO album_protection(album_id) VALUES('missing')"), /FOREIGN KEY/)
      assert.equal(db.prepare('SELECT name FROM albums').get()?.name, 'old')
    } finally { db.close() }
  }
})

test('owner protection toggles default/shared/public albums; default name/privacy remain immutable and types are strict', async () => {
  const f = await fixture()
  try {
    const normal = [await f.create('shared'), await f.create('public')]
    f.db.prepare('INSERT INTO album_members(album_id,user_id) VALUES(?,2)').run(normal[0].id)
    const defaultAlbum = await ensureDefaultAlbum(f.libEnv, 1)
    for (const album of [defaultAlbum, ...normal]) {
      assert.equal((await (await f.request(`/${album.id}`)).json() as { album: Album }).album.download_protected, false)
      for (const enabled of [true, false, true]) {
        const r = await f.request(`/${album.id}`, { download_protected: enabled }, 'PATCH')
        assert.equal(r.status, 200, await r.clone().text())
        const dto = (await r.json() as { album: Album }).album
        assert.equal(dto.download_protected, enabled); assert.equal(dto.name, album.name); assert.equal(dto.visibility, album.visibility)
      }
      for (const invalid of [null, 0, 1, 'true', [], {}]) assert.equal((await f.request(`/${album.id}`, { download_protected: invalid }, 'PATCH')).status, 400)
    }
    for (const input of [{ name: '宝宝相册', download_protected: false }, { visibility: 'private', download_protected: false }]) assert.equal((await f.request(`/${defaultAlbum.id}`, input, 'PATCH')).status, 409)
    for (const album of normal) {
      assert.equal((await f.request(`/${album.id}`, { download_protected: false }, 'PATCH', 2)).status, 403)
      assert.equal((await (await f.request(`/${album.id}`, undefined, 'GET', 2)).json() as { album: Album }).album.download_protected, true)
    }
    f.controls.failStatement = sql => sql.startsWith('INSERT INTO album_protection')
    assert.equal((await f.request(`/${normal[1].id}`, { name: 'must roll back', download_protected: false }, 'PATCH')).status, 503)
    assert.equal(f.db.prepare('SELECT name FROM albums WHERE id=?').get(normal[1].id)?.name, normal[1].name)
  } finally { f.db.close() }
})

test('protected nonowners preview only, cover hidden, both HD intents denied before signing/quota; owners stay free and original rules unchanged', async t => {
  const f = await fixture(); f.mockCos(t)
  try {
    f.sponsor()
    for (const visibility of ['shared', 'public']) {
      const album = await f.create(visibility); const { auth } = await f.authorize(album.id, f.input('original')); await f.complete(auth); await f.publish(auth)
      f.db.prepare('INSERT INTO album_members(album_id,user_id) VALUES(?,2)').run(album.id)
      const photo = String(f.db.prepare('SELECT id FROM album_photos WHERE album_id=?').get(album.id)?.id)
      await f.request(`/${album.id}`, { download_protected: true }, 'PATCH')
      const detail = (await (await f.request(`/photos/${photo}`, undefined, 'GET', 2)).json() as PhotoDetailResponse).photo
      assert.equal(detail.download_protected, true); assert.equal(detail.can_download, false)
      assert.ok(detail.preview_url); assert.equal(detail.hd_url, null); assert.equal(detail.original_available, false)
      const list = (await (await f.request(`/${album.id}/photos`, undefined, 'GET', 2)).json() as AlbumPhotosResponse).photos[0]
      assert.equal(list.download_protected, true); assert.equal(list.can_download, false)
      const card = (await (await f.request(`/${album.id}`, undefined, 'GET', 2)).json() as { album: Album }).album
      assert.equal(card.cover_url, null); assert.equal(card.download_protected, true)
      const before = f.db.prepare('SELECT count(*) AS n FROM sponsor_operations').get()?.n
      const secret = f.env.COS_SECRET_KEY; f.env.COS_SECRET_KEY = ''
      for (const intent of [undefined, 'view', 'download']) {
        const denied = await f.request(`/photos/${photo}/authorize`, { variant: 'hd', operation_id: crypto.randomUUID(), ...(intent ? { intent } : {}) }, 'POST', 2)
        assert.equal(denied.status, 403); assert.equal((await denied.json() as { code: string }).code, 'album_download_protected')
      }
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM sponsor_operations').get()?.n, before)
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM sponsor_daily_usage WHERE user_id=2').get()?.n, 0)
      f.env.COS_SECRET_KEY = secret
      const owner = (await (await f.request(`/photos/${photo}`)).json() as PhotoDetailResponse).photo
      assert.equal(owner.download_protected, true); assert.equal(owner.can_download, true); assert.ok(owner.hd_url); assert.equal(owner.original_available, true)
      assert.ok((await (await f.request(`/${album.id}`)).json() as { album: Album }).album.cover_url)
      const hd = await f.request(`/photos/${photo}/authorize`, { variant: 'hd', intent: 'download', operation_id: crypto.randomUUID() })
      assert.equal(hd.status, 200); assert.equal((await hd.json() as { charged: boolean }).charged, false)
      const originalBody = { variant: 'original', intent: 'download', operation_id: crypto.randomUUID() }
      assert.equal((await f.request(`/photos/${photo}/authorize`, originalBody)).status, 200)
      assert.equal((await f.request(`/photos/${photo}/authorize`, { ...originalBody, intent: 'view' })).status, 409)
      assert.equal((await f.request(`/photos/${photo}/authorize`, { variant: 'original', operation_id: crypto.randomUUID() }, 'POST', 2)).status, 403)
      f.db.exec("UPDATE sponsor_settings SET config_json=json_set(config_json,'$.enabled',json('false'))")
      assert.equal((await f.request(`/photos/${photo}/authorize`, { variant: 'hd', intent: 'view', operation_id: crypto.randomUUID() }, 'POST', 2)).status, 403)
      f.db.exec("UPDATE sponsor_settings SET config_json=json_set(config_json,'$.enabled',json('true'))")
      await f.request(`/${album.id}`, { download_protected: false }, 'PATCH')
      const refreshed = (await (await f.request(`/photos/${photo}`, undefined, 'GET', 2)).json() as PhotoDetailResponse).photo
      assert.equal(refreshed.download_protected, false); assert.equal(refreshed.can_download, true)
    }
  } finally { f.db.close() }
})

test('authorization intent is strict and bound to idempotency; default view stays compatible and protected old retries denied', async t => {
  const f = await fixture(); f.mockCos(t)
  try {
    const album = await f.create('public'); const { auth } = await f.authorize(album.id); await f.complete(auth); await f.publish(auth)
    const photo = String(f.db.prepare('SELECT id FROM album_photos').get()?.id)
    f.db.exec("UPDATE sponsor_settings SET config_json=json_set(config_json,'$.enabled',json('true'))")
    const body = { variant: 'hd', operation_id: crypto.randomUUID(), notice_version: 1 }
    for (const invalid of [null, 0, '', 'save', true, {}]) assert.equal((await f.request(`/photos/${photo}/authorize`, { ...body, intent: invalid }, 'POST', 2)).status, 400)
    assert.equal((await f.request(`/photos/${photo}/authorize`, body, 'POST', 2)).status, 200)
    const repeated = await f.request(`/photos/${photo}/authorize`, { ...body, intent: 'view' }, 'POST', 2)
    assert.equal(repeated.status, 200); assert.equal((await repeated.json() as { charged: boolean }).charged, false)
    assert.equal((await f.request(`/photos/${photo}/authorize`, { ...body, intent: 'download' }, 'POST', 2)).status, 409)
    const download = { ...body, operation_id: crypto.randomUUID(), intent: 'download' }
    assert.equal((await f.request(`/photos/${photo}/authorize`, download, 'POST', 2)).status, 200)
    assert.equal((await f.request(`/photos/${photo}/authorize`, { ...download, notice_version: undefined }, 'POST', 2)).status, 200)
    assert.equal(f.db.prepare('SELECT used FROM sponsor_daily_usage WHERE user_id=2').get()?.used, 2)
    await f.request(`/${album.id}`, { download_protected: true }, 'PATCH')
    for (const old of [body, download]) {
      const r = await f.request(`/photos/${photo}/authorize`, old, 'POST', 2)
      assert.equal(r.status, 403); assert.doesNotMatch(await r.text(), /q-signature|albums\/1\//)
    }
    assert.equal(f.db.prepare('SELECT used FROM sponsor_daily_usage WHERE user_id=2').get()?.used, 2)
    await f.request(`/${album.id}`, { download_protected: false }, 'PATCH')
    const recovered = await f.request(`/photos/${photo}/authorize`, body, 'POST', 2)
    assert.equal(recovered.status, 200); assert.equal((await recovered.json() as { charged: boolean }).charged, false)
  } finally { f.db.close() }
})

test('live protection toggled before quota or inside debit rolls back sponsor operation, usage and in-transaction toggle', async t => {
  const f = await fixture(); f.mockCos(t)
  try {
    const album = await f.create('public'); const { auth } = await f.authorize(album.id); await f.complete(auth); await f.publish(auth)
    const photo = String(f.db.prepare('SELECT id FROM album_photos').get()?.id)
    f.db.exec("UPDATE sponsor_settings SET config_json=json_set(config_json,'$.enabled',json('true'))")
    const body = { variant: 'hd', intent: 'download', operation_id: crypto.randomUUID(), notice_version: 1 }
    f.controls.beforeBatch = () => f.db.prepare('INSERT INTO album_protection(album_id,download_protected) VALUES(?,1)').run(album.id)
    assert.equal((await f.request(`/photos/${photo}/authorize`, body, 'POST', 2)).status, 403)
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM sponsor_operations WHERE kind='original'").get()?.n, 0)
    f.db.exec('UPDATE album_protection SET download_protected=0')
    f.db.exec(`CREATE TRIGGER test_toggle_during_debit AFTER INSERT ON sponsor_operations WHEN NEW.kind='original'
      BEGIN UPDATE album_protection SET download_protected=1; END;`)
    const r = await f.request(`/photos/${photo}/authorize`, body, 'POST', 2)
    assert.equal(r.status, 403); assert.doesNotMatch(await r.text(), /q-signature/)
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM sponsor_operations WHERE kind='original'").get()?.n, 0)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM sponsor_daily_usage').get()?.n, 0)
    assert.equal(f.db.prepare('SELECT download_protected FROM album_protection').get()?.download_protected, 0)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM album_object_cleanup').get()?.n, 0)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM album_uploads').get()?.n, 2)
    assert.equal(f.db.prepare('SELECT used_bytes FROM album_storage').get()?.used_bytes, bytes.byteLength * 2)
  } finally { f.db.close() }
})

test('fresh DTO protection and final authorization read reject post-quota toggles without signed URLs', async t => {
  const f = await fixture(); f.mockCos(t)
  try {
    const album = await f.create('public'); const { auth } = await f.authorize(album.id); await f.complete(auth); await f.publish(auth)
    const photo = String(f.db.prepare('SELECT id FROM album_photos').get()?.id)
    const toggle = () => f.db.prepare('INSERT INTO album_protection(album_id,download_protected) VALUES(?,1) ON CONFLICT(album_id) DO UPDATE SET download_protected=1').run(album.id)
    let reads = 0
    f.controls.beforeFirst = sql => { if (sql.startsWith('SELECT a.*') && ++reads === 3) toggle() }
    const card = (await (await f.request(`/${album.id}`, undefined, 'GET', 2)).json() as { album: Album }).album
    assert.equal(card.download_protected, true); assert.equal(card.cover_url, null)
    f.db.exec('UPDATE album_protection SET download_protected=0'); reads = 0
    f.controls.beforeFirst = sql => { if (sql.startsWith('SELECT EXISTS(SELECT 1 FROM sponsor_memberships') && ++reads === 2) toggle() }
    const dto = (await (await f.request(`/photos/${photo}`, undefined, 'GET', 2)).json() as PhotoDetailResponse).photo
    assert.equal(dto.download_protected, true); assert.equal(dto.can_download, false); assert.equal(dto.hd_url, null)
    for (const finalRead of [2, 3]) {
      f.db.exec('UPDATE album_protection SET download_protected=0'); reads = 0
      f.controls.beforeFirst = sql => { if (sql.startsWith('SELECT p.*') && ++reads === finalRead) toggle() }
      const denied = await f.request(`/photos/${photo}/authorize`, { variant: 'hd', operation_id: crypto.randomUUID() }, 'POST', 2)
      assert.equal(denied.status, 403); assert.doesNotMatch(await denied.text(), /q-signature/)
    }
  } finally { f.db.close() }
})

test('missing protection storage fails503 rather than claiming unprotected, and raw PATCH body is consumed exactly once', async () => {
  const f = await fixture()
  try {
    const album = await f.create('public')
    const raw = new Request(`http://localhost/api/v1/albums/${album.id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${f.tokens[0]}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ download_protected: true }) })
    const response = await f.app.request(raw, undefined, f.env as never)
    assert.equal(response.status, 200); assert.equal((await response.json() as { album: Album }).album.download_protected, true)
    f.controls.beforeFirst = sql => { if (sql.includes('FROM album_protection')) throw new Error('no such table: album_protection') }
    for (const [method, body] of [['GET', undefined], ['PATCH', { download_protected: false }]] as const) {
      const r = await f.request(`/${album.id}`, body, method)
      assert.equal(r.status, 503); assert.equal((await r.json() as { code: string }).code, 'albums_unavailable')
    }
    assert.equal(f.db.prepare('SELECT download_protected FROM album_protection').get()?.download_protected, 1)
  } finally { f.db.close() }
  const old = await fixture(false)
  try {
    old.db.exec("INSERT INTO albums(id,owner_id,name,visibility) VALUES('old-live',1,'old','public')")
    for (const [path, method, body] of [
      ['/old-live', 'GET', undefined], ['/old-live/photos', 'GET', undefined],
      ['/old-live', 'PATCH', { download_protected: true }], ['/old-live', 'PATCH', { download_protected: false }],
    ] as const) {
      const response = await old.request(path, body, method)
      assert.equal(response.status, 503); assert.equal((await response.json() as { code: string }).code, 'albums_unavailable')
    }
    assert.equal(old.db.prepare('SELECT count(*) AS n FROM sqlite_master WHERE name=?').get('album_protection')?.n, 0, 'no request-time table creation')
  } finally { old.db.close() }
})
