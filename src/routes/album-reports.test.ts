import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import test, { type TestContext } from 'node:test'
import { Hono } from 'hono'
import albums from './albums.ts'
import albumReports from './album-reports.ts'
import { hydrateAlbumPostUpdates } from '../mastodon/converter.ts'
import { signJWT } from '../lib/auth.ts'
import type { AlbumEnv } from '../lib/albums.ts'
import type { Album, AlbumBatchAuthorization, AlbumPhotosResponse, AlbumPublishResponse, AlbumReportDetail, AlbumReportListItem, AlbumReportListResponse, AlbumReportResponse, PhotoDetailResponse } from '../types/albums.ts'

const root = new URL('../../', import.meta.url)
const file = (path: string) => readFileSync(new URL(path, root), 'utf8')
const schema = file('schemas/schema.sql')
const migration = file('migrations/0073_album_reports.sql')
const jpeg = (width = 320, height = 240) => Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0, 0xff, 0xd9])
const bytes = jpeg()
const md5 = createHash('md5').update(bytes).digest('base64')
const md5hex = createHash('md5').update(bytes).digest('hex')
interface Control { beforeFirst?: (sql: string) => void; diagnostics: string[] }
interface Statement { sql: string; params: SQLInputValue[] }

function d1(db: DatabaseSync, controls: Control) {
  const statement = (sql: string, params: SQLInputValue[] = []) => ({
    sql, params, bind: (...values: SQLInputValue[]) => statement(sql, values),
    first: async <T>() => { controls.beforeFirst?.(sql); return (db.prepare(sql).get(...params) ?? null) as T | null },
    all: async <T>() => ({ success: true, results: db.prepare(sql).all(...params) as T[], meta: {} }),
    run: async () => { db.prepare(sql).run(...params); return { success: true, meta: {} } },
  })
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Statement[]) => {
      db.exec('BEGIN IMMEDIATE')
      try {
        const results = statements.map(s => ({ success: true, results: db.prepare(s.sql).all(...s.params), meta: {} }))
        db.exec('COMMIT'); return results
      } catch (error) { controls.diagnostics.push(String(error)); db.exec('ROLLBACK'); throw error }
    },
  }
}

type TestUser = 0 | 1 | 2 | 'admin'

async function fixture(reportsAvailable = true) {
  const text = reportsAvailable ? schema : schema.slice(0, schema.indexOf(migration.trim()))
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); db.exec(text)
  db.exec(file('migrations/oauth.sql')); db.exec(file('migrations/0062_sponsors.sql')); db.exec(file('migrations/0071_baby_albums.sql'))
  db.exec("ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0; INSERT INTO users(id,email,password_hash,username) VALUES(1,'one@test.invalid','x','one'),(2,'two@test.invalid','x','two'),(3,'admin@test.invalid','x','admin'); UPDATE users SET role='admin' WHERE id=3")
  const controls: Control = { diagnostics: [] }
  const env = { abdl_space_db: d1(db, controls), JWT_SECRET: 'album-report-test-secret', COS_SECRET_ID: 'test-id', COS_SECRET_KEY: 'test-key', COS_BUCKET: 'album-test-123', COS_REGION: 'ap-shanghai' }
  const tokens = await Promise.all([1, 2, 3].map(sub => signJWT({ sub, username: ['one', 'two', 'admin'][sub - 1], email: `${['one', 'two', 'admin'][sub - 1]}@test.invalid`, role: sub === 3 ? 'admin' : 'user' }, env.JWT_SECRET)))
  const app = new Hono(); app.route('/api/v1/albums', albums); app.route('/api/admin/album-reports', albumReports)
  const bearer = (user: TestUser): Record<string, string> => (user === 0 ? {} : { Authorization: `Bearer ${user === 'admin' ? tokens[2] : tokens[user - 1]}` })
  const requestHeaders = (method: string, user: TestUser): Record<string, string> => ({ ...bearer(user), ...(['GET', 'HEAD'].includes(method) ? {} : { 'Content-Type': 'application/json' }) })
  const requestBody = (method: string, payload: unknown) => (['GET', 'HEAD'].includes(method) ? {} : { body: JSON.stringify(payload ?? {}) })
  const request = (path: string, payload: unknown = undefined, method = payload === undefined ? 'GET' : 'POST', user: TestUser = 1) => app.request(`/api/v1/albums${path.startsWith('/?') ? path.slice(1) : path}`, { method, headers: requestHeaders(method, user), ...requestBody(method, payload) }, env as never)
  const admin = (path: string, payload: unknown = undefined, method = payload === undefined ? 'GET' : 'POST', user: TestUser = 'admin') => app.request(`/api/admin/album-reports${path === '/' ? '' : path.startsWith('/?') ? path.slice(1) : path}`, { method, headers: requestHeaders(method, user), ...requestBody(method, payload) }, env as never)
  const mockCos = (t: TestContext) => {
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => new Response(init?.method === 'HEAD' ? null : bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength), 'content-type': 'image/jpeg', etag: md5hex } }))
  }
  const input = (operationId = crypto.randomUUID()) => ({ operation_id: operationId, description: '批量描述', captured_at: null, quality: 'hd', photos: [{ client_id: 'z-first', width: 1600, height: 1200, variants: [{ kind: 'preview', mime_type: 'image/jpeg', size: bytes.byteLength, content_md5: md5, width: 320, height: 240 }, { kind: 'hd', mime_type: 'image/jpeg', size: bytes.byteLength, content_md5: md5 }] }, { client_id: 'a-second', width: 1600, height: 1200, variants: [{ kind: 'preview', mime_type: 'image/jpeg', size: bytes.byteLength, content_md5: md5, width: 320, height: 240 }, { kind: 'hd', mime_type: 'image/jpeg', size: bytes.byteLength, content_md5: md5 }] }] })
  const publishPublic = async () => {
    const created = await request('/', { name: '公开相册', visibility: 'public' }); assert.equal(created.status, 201)
    const album = (await created.json() as { album: Album }).album
    const response = await request(`/${album.id}/batches/authorize`, input()); assert.equal(response.status, 200, await response.clone().text())
    const auth = await response.json() as AlbumBatchAuthorization
    for (const upload of auth.uploads) assert.equal((await request(`/uploads/${upload.upload_id}/complete`, {})).status, 200)
    const published = await request(`/batches/${auth.batch_id}/publish`, {}); assert.equal(published.status, 200)
    await published.json() as AlbumPublishResponse
    const photos = (await (await request(`/${album.id}/photos`)).json() as AlbumPhotosResponse).photos
    assert.equal(photos.length, 2)
    return { album, photos, batchId: auth.batch_id }
  }
  const report = async (albumId: string, user: TestUser = 2, body: Record<string, unknown> = {}) => {
    const response = await request(`/${albumId}/report`, { reason: 'spam', detail: '违规内容', operation_id: crypto.randomUUID(), ...body }, 'POST', user)
    const payload = await response.clone().json() as AlbumReportResponse & { code?: string }
    return { response, body: payload }
  }
  return { db, env, libEnv: env as never as AlbumEnv, controls, request, admin, mockCos, input, publishPublic, report }
}

test('album report migration is additive, replay-safe, registered and constraint-checked', () => {
  assert.ok(schema.includes(migration.trim()))
  assert.ok(file('scripts/database-bootstrap-files.mjs').includes('migrations/0073_album_reports.sql'))
  assert.doesNotMatch(migration, /\b(?:ALTER|DROP)\b/i)
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('PRAGMA foreign_keys=ON'); db.exec(schema)
    db.exec("INSERT INTO users(id,email,password_hash,username) VALUES(1,'r@test.invalid','x','r'),(2,'a@test.invalid','x','a'); INSERT INTO albums(id,owner_id,name,visibility) VALUES('album',1,'相册','public')")
    db.exec(migration); db.exec(migration)
    const insert = (id: string, operation: string, detail: 'null' | 'long' = 'null', status = 'open', resolved = false) => db.exec(`INSERT INTO album_reports(id,album_id,reporter_id,reason,detail,operation_id,request_hash,status,resolved_at,resolved_by) VALUES('${id}','album',2,'spam',${detail === 'long' ? `'${'x'.repeat(2001)}'` : 'NULL'},'${operation}','hash','${status}',${resolved ? 'unixepoch()' : 'NULL'},${resolved ? 1 : 'NULL'})`)
    insert('r1', 'op-1')
    assert.throws(() => insert('r2', 'op-2'), /UNIQUE/, 'one open report per reporter and album')
    db.exec("UPDATE album_reports SET status='resolved',resolved_at=unixepoch(),resolved_by=1 WHERE id='r1'")
    insert('r2', 'op-2')
    assert.throws(() => insert('r3', 'op-2'), /UNIQUE/, 'operation_id is globally unique')
    assert.throws(() => db.exec("INSERT INTO album_reports(id,album_id,reporter_id,reason,operation_id,request_hash) VALUES('r9','album',2,'violence','op-9','hash')"), /CHECK/, 'reason enum enforced')
    assert.throws(() => insert('r9', 'op-9', 'long'), /CHECK/, 'detail length enforced')
    assert.throws(() => db.exec("INSERT INTO album_reports(id,album_id,reporter_id,reason,operation_id,request_hash,status) VALUES('r9','album',2,'spam','op-9','hash','resolved')"), /CHECK/, 'resolved requires timestamp and actor')
    db.exec("INSERT INTO album_batches(id,album_id,owner_id,operation_id,request_hash,quality,photo_count,reserved_bytes,expires_at) VALUES('batch','album',1,'op','hash','hd',1,8,unixepoch()+300)")
    db.exec("INSERT INTO album_photos(id,album_id,batch_id,owner_id,client_id,uploaded_at,width,height,preview_key,hd_key,preview_bytes,hd_bytes) VALUES('photo','album','batch',1,'c',unixepoch(),10,10,'albums/1/p','albums/1/h',4,4)")
    db.exec("INSERT INTO album_photo_blocks(album_id,photo_id,admin_id) VALUES('album','photo',2)")
    assert.throws(() => db.exec("INSERT INTO album_photo_blocks(album_id,photo_id,admin_id) VALUES('album','photo',2)"), /UNIQUE|PRIMARY/)
    assert.throws(() => db.exec("INSERT INTO album_photo_blocks(album_id,photo_id,admin_id) VALUES('album','missing',2)"), /FOREIGN KEY/)
  } finally { db.close() }
})

test('report submission enforces ACL, ownership, idempotency, duplicate-open and the hourly album-report bucket', async t => {
  const f = await fixture(); f.mockCos(t)
  try {
    const { album } = await f.publishPublic()
    const first = await f.report(album.id)
    assert.equal(first.response.status, 201, await first.response.clone().text())
    const submitted = first.body.report
    assert.equal(submitted.status, 'open'); assert.equal(submitted.album_id, album.id); assert.equal(submitted.reporter_id, 2)
    assert.equal(submitted.reason, 'spam'); assert.equal(submitted.detail, '违规内容'); assert.equal(submitted.resolved_at, null)
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM album_rate_limits WHERE bucket='user:2:album-report'").get()?.n, 1)
    const sameOperation = f.db.prepare('SELECT operation_id FROM album_reports').get()?.operation_id as string
    const replay = await f.report(album.id, 2, { operation_id: sameOperation })
    assert.equal(replay.response.status, 201); assert.equal(replay.body.report.id, submitted.id)
    const differentOperation = await f.report(album.id, 2, {})
    assert.equal(differentOperation.response.status, 409); assert.equal(differentOperation.body.code, 'duplicate_open')
    const changedBody = await f.report(album.id, 2, { operation_id: sameOperation, detail: '不同内容' })
    assert.equal(changedBody.response.status, 409); assert.equal(changedBody.body.code, 'idempotency_conflict')
    assert.equal((await f.report(album.id, 1)).response.status, 403)
    assert.equal((await f.report(album.id, 0)).response.status, 401)
    for (const invalid of [{ reason: 'violence' }, { detail: 'x'.repeat(2001) }, { extra: 1 }, { operation_id: 'not-a-uuid' }]) {
      assert.equal((await f.report(album.id, 2, invalid)).response.status, 400)
    }
    f.db.exec("INSERT INTO albums(id,owner_id,name,visibility) VALUES('secret',1,'私密','private')")
    assert.equal((await f.report('secret', 2)).response.status, 404)
    f.db.prepare("UPDATE album_rate_limits SET count=10 WHERE bucket='user:2:album-report'").run()
    const limited = await f.report(album.id, 2, {})
    assert.equal(limited.response.status, 429); assert.equal(limited.body.code, 'rate_limited')
  } finally { t.mock.restoreAll(); f.db.close() }
})

test('admin console lists, filters, resolves first-write-wins and enforces role access', async t => {
  const f = await fixture(); f.mockCos(t)
  try {
    const { album } = await f.publishPublic()
    const submitted = await f.report(album.id)
    const reportId = submitted.body.report.id
    assert.equal((await f.admin('/', undefined, 'GET', 1)).status, 403)
    assert.equal((await f.admin('/', undefined, 'GET', 0)).status, 401)
    const list = await (await f.admin('/', undefined, 'GET')).json() as AlbumReportListResponse
    assert.equal(list.total, 1); assert.equal(list.reports.length, 1)
    const item = list.reports[0]
    assert.equal(item.id, reportId); assert.equal(item.album_name, '公开相册'); assert.equal(item.owner_id, 1)
    assert.equal(item.blocked_photo_count, 0); assert.equal(item.album_photo_count, 2); assert.equal(item.status, 'open')
    assert.equal((await (await f.admin('/?status=resolved')).json() as AlbumReportListResponse).total, 0)
    assert.equal((await (await f.admin('/?status=all')).json() as AlbumReportListResponse).total, 1)
    for (const query of ['/?status=bogus', '/?limit=garbage', '/?limit=101', '/?offset=-1']) assert.equal((await f.admin(query, undefined, 'GET')).status, 400)
    assert.equal((await f.admin('/missing-report', undefined, 'GET')).status, 404)
    assert.equal((await f.admin(`/${reportId}/resolve`, { extra: 1 })).status, 400)
    const resolved = await (await f.admin(`/${reportId}/resolve`, {})).json() as { report: AlbumReportListItem }
    assert.equal(resolved.report.status, 'resolved'); assert.equal(typeof resolved.report.resolved_at, 'number')
    const repeat = await (await f.admin(`/${reportId}/resolve`, {})).json() as { report: AlbumReportListItem }
    assert.equal(repeat.report.resolved_at, resolved.report.resolved_at, 'first resolution wins')
    assert.equal((await (await f.admin('/?status=open')).json() as AlbumReportListResponse).total, 0)
    assert.equal((await (await f.admin('/?status=resolved')).json() as AlbumReportListResponse).reports[0].id, reportId)
    const again = await f.report(album.id, 2, {})
    assert.equal(again.response.status, 201, 'a resolved report never blocks a fresh one')
    assert.equal((await (await f.admin('/?status=all')).json() as AlbumReportListResponse).total, 2)
  } finally { t.mock.restoreAll(); f.db.close() }
})

test('admin review detail signs 60s previews only for unblocked photos and never exposes originals', async t => {
  const f = await fixture(); f.mockCos(t)
  try {
    const { album } = await f.publishPublic()
    const reportId = (await f.report(album.id)).body.report.id
    assert.equal((await f.admin(`/${reportId}`, undefined, 'GET', 2)).status, 403)
    const detail = await (await f.admin(`/${reportId}`)).json() as AlbumReportDetail
    assert.equal(detail.report.id, reportId); assert.equal(detail.report.album_photo_count, 2)
    assert.equal(detail.album.id, album.id); assert.equal(detail.album.owner_id, 1); assert.equal(detail.album.visibility, 'public')
    assert.equal(detail.album.is_default, false); assert.equal(detail.album.download_protected, false)
    assert.equal(detail.download_protected, false); assert.equal(detail.photos.length, 2)
    assert.doesNotMatch(JSON.stringify(detail), /hd_key|preview_key|object_key|original_key|hd_url|original_available/)
    for (const photo of detail.photos) {
      assert.equal(photo.admin_blocked, false)
      const url = new URL(photo.preview_url!)
      assert.equal(url.hostname, 'album-test-123.cos.ap-shanghai.myqcloud.com')
      assert.ok(url.searchParams.has('q-signature'))
      assert.equal(Number(url.searchParams.get('q-sign-time')!.split(';')[1]) - Number(url.searchParams.get('q-sign-time')!.split(';')[0]), 60)
    }
    f.db.prepare('INSERT INTO album_photo_blocks(album_id,photo_id,admin_id) VALUES(?,?,3)').run(album.id, detail.photos[0].id)
    const blocked = await (await f.admin(`/${reportId}`)).json() as AlbumReportDetail
    assert.equal(blocked.photos[0].admin_blocked, true); assert.equal(blocked.photos[0].preview_url, null)
    assert.ok(blocked.photos[1].preview_url)
  } finally { t.mock.restoreAll(); f.db.close() }
})

test('block desired-state replaces and unblocks; blocked photos are hidden from every viewer including the owner', async t => {
  const f = await fixture(); f.mockCos(t)
  try {
    const { album } = await f.publishPublic()
    const reportId = (await f.report(album.id)).body.report.id
    // Cover order is sort-order based (z-first), DTO list order is timestamp/id based; derive both from the row order.
    const cover = f.db.prepare('SELECT id FROM album_photos WHERE album_id=? ORDER BY sort_order,id LIMIT 1').get(album.id)?.id as string
    const second = f.db.prepare('SELECT id FROM album_photos WHERE album_id=? ORDER BY sort_order DESC,id LIMIT 1').get(album.id)?.id as string
    const block = async (photoIds: string[], body: Record<string, unknown> = {}) => f.admin(`/${reportId}/block`, { photo_ids: photoIds, operation_id: crypto.randomUUID(), ...body })
    assert.deepEqual(await (await block([cover])).json(), { blocked_photo_ids: [cover] })
    assert.deepEqual(await (await block([cover])).json(), { blocked_photo_ids: [cover] }, 'repeats are idempotent')
    const both = await (await block([cover, second])).json() as { blocked_photo_ids: string[] }
    assert.deepEqual([...both.blocked_photo_ids].sort(), [cover, second].sort(), 'desired state replaces')
    assert.deepEqual(await (await block([])).json(), { blocked_photo_ids: [] }, 'empty list unblocks all')
    assert.deepEqual(await (await block([cover])).json(), { blocked_photo_ids: [cover] })
    assert.equal((await block(Array.from({ length: 21 }, () => cover))).status, 400)
    assert.equal((await block([cover, cover])).status, 400)
    assert.equal((await block([crypto.randomUUID()])).status, 400)
    assert.equal((await block([cover], { operation_id: 'not-a-uuid' })).status, 400)
    assert.equal((await f.admin('/missing-report/block', { photo_ids: [cover] })).status, 404)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM album_photos WHERE id=?').get(cover)?.n, 1, 'blocked photos are never deleted')

    const ownerList = (await (await f.request(`/${album.id}/photos`)).json() as AlbumPhotosResponse).photos
    const blockedDto = ownerList.find(photo => photo.id === cover)!
    const normalDto = ownerList.find(photo => photo.id === second)!
    assert.equal(blockedDto.admin_blocked, true); assert.equal(blockedDto.preview_url, null); assert.equal(blockedDto.hd_url, null)
    assert.equal(blockedDto.can_download, false); assert.equal(blockedDto.original_available, false)
    assert.equal(normalDto.admin_blocked, false); assert.ok(normalDto.preview_url)
    const memberList = (await (await f.request(`/${album.id}/photos`, undefined, 'GET', 2)).json() as AlbumPhotosResponse).photos
    assert.equal(memberList.find(photo => photo.id === cover)!.preview_url, null, 'blocks apply to other viewers too')
    const ownerDetail = (await (await f.request(`/photos/${cover}`)).json() as PhotoDetailResponse).photo
    assert.equal(ownerDetail.admin_blocked, true); assert.equal(ownerDetail.preview_url, null)
    for (const [path, body] of [['/like', { liked: true }], ['/comments', { content: '评论', operation_id: crypto.randomUUID() }]] as const) {
      const denied = await f.request(`/photos/${cover}${path}`, body)
      assert.equal(denied.status, 404); assert.equal((await denied.json() as { code: string }).code, 'photo_blocked')
    }
    assert.equal((await f.request(`/photos/${cover}/comments`, undefined, 'GET')).status, 404)
    const likeOther = await f.request(`/photos/${second}/like`, { liked: true })
    assert.equal(likeOther.status, 200, 'unblocked photos stay fully interactive')
    const authorize = await f.request(`/photos/${cover}/authorize`, { variant: 'hd', operation_id: crypto.randomUUID() })
    assert.equal(authorize.status, 404); assert.equal((await authorize.json() as { code: string }).code, 'photo_blocked')
    const memberAuthorize = await f.request(`/photos/${cover}/authorize`, { variant: 'hd', operation_id: crypto.randomUUID() }, 'POST', 2)
    assert.equal(memberAuthorize.status, 404); assert.equal((await memberAuthorize.json() as { code: string }).code, 'photo_blocked')

    const card = (await (await f.request(`/${album.id}`)).json() as { album: Album }).album
    assert.equal(card.photo_count, 1, 'card counts exclude blocked photos')
    assert.ok(card.cover_url?.includes(second), 'cover falls back to the first unblocked photo')
    await block([cover, second])
    const empty = (await (await f.request(`/${album.id}`)).json() as { album: Album }).album
    assert.equal(empty.photo_count, 0); assert.equal(empty.cover_url, null)
    await block([])
    const restored = (await (await f.request(`/${album.id}`)).json() as { album: Album }).album
    assert.equal(restored.photo_count, 2); assert.ok(restored.cover_url?.includes(cover))
    await block([cover])
    assert.equal((await (await f.admin('/?status=open')).json() as AlbumReportListResponse).reports[0].blocked_photo_count, 1)
  } finally { t.mock.restoreAll(); f.db.close() }
})

test('native album metadata uses the first unblocked photo, keeps the total count and omits the card when all are blocked', async t => {
  const f = await fixture(); f.mockCos(t)
  try {
    const { album, batchId } = await f.publishPublic()
    const postId = f.db.prepare('SELECT post_id FROM album_batches WHERE id=?').get(batchId)?.post_id as number
    const coverId = f.db.prepare('SELECT id FROM album_photos WHERE album_id=? ORDER BY sort_order,id LIMIT 1').get(album.id)?.id as string
    const otherId = f.db.prepare('SELECT id FROM album_photos WHERE album_id=? ORDER BY sort_order DESC,id LIMIT 1').get(album.id)?.id as string
    const status: Record<string, unknown> = { id: `p_${postId}`, account: { id: 1 }, content: 'ignored', media_attachments: [] }
    assert.equal(await hydrateAlbumPostUpdates(f.env as never, [status], true), true)
    const metadata = status.album_update as { album_id: string; photo_count: number; cover_url: string; width: number; height: number }
    assert.equal(metadata.album_id, album.id); assert.equal(metadata.photo_count, 2)
    assert.equal(new URL(metadata.cover_url).pathname, `/albums/1/${batchId}/${coverId}/preview.jpg`)
    const submitted = await f.report(album.id)
    assert.equal(submitted.response.status, 201)
    const block = async (photoIds: string[]) => {
      const reportId = (await (await f.admin('/?status=open')).json() as AlbumReportListResponse).reports[0].id
      const response = await f.admin(`/${reportId}/block`, { photo_ids: photoIds })
      assert.equal(response.status, 200, await response.clone().text())
    }
    await block([coverId])
    const switched: Record<string, unknown> = { ...status, album_update: { cover_url: 'https://stale.test/x' } }
    assert.equal(await hydrateAlbumPostUpdates(f.env as never, [switched], true), true)
    const switchedMeta = switched.album_update as { photo_count: number; cover_url: string }
    assert.equal(switchedMeta.photo_count, 2, 'metadata keeps the total photo count')
    assert.equal(new URL(switchedMeta.cover_url).pathname, `/albums/1/${batchId}/${otherId}/preview.jpg`, 'cover falls to the first unblocked photo')
    await block([coverId, otherId])
    const all: Record<string, unknown> = { ...status, album_update: { cover_url: 'https://stale.test/x' } }
    await hydrateAlbumPostUpdates(f.env as never, [all], true)
    assert.equal('album_update' in all, false, 'an album with no unblocked photo exposes no card')
  } finally { t.mock.restoreAll(); f.db.close() }
})

test('missing report storage fails closed 503 without creating tables at request time', async () => {
  const f = await fixture(false)
  try {
    f.db.exec("INSERT INTO albums(id,owner_id,name,visibility) VALUES('legacy',1,'旧相册','public')")
    const submission = await f.report('legacy')
    assert.equal(submission.response.status, 503); assert.equal(submission.body.code, 'albums_unavailable')
    const list = await f.admin('/', undefined, 'GET')
    assert.equal(list.status, 503); assert.equal((await list.json() as { code: string }).code, 'albums_unavailable')
    const photos = await f.request('/legacy/photos')
    assert.equal(photos.status, 503); assert.equal((await photos.json() as { code: string }).code, 'albums_unavailable')
    const card = await f.request('/legacy')
    assert.equal(card.status, 503); assert.equal((await card.json() as { code: string }).code, 'albums_unavailable')
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('album_reports','album_photo_blocks')").get()?.n, 0)
  } finally { f.db.close() }
})
