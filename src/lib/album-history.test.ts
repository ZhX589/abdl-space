import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import test from 'node:test'
import { Hono } from 'hono'
import { PhotonImage } from '@cf-wasm/photon'
import { importAlbumHistory, importAlbumHistoryHandler, isVerifiedHistoryCosUrl } from './album-history.ts'
import { cleanupAlbumObjects, type AlbumEnv } from './albums.ts'
import { authorizeSponsorOriginal, getSponsorMe } from './sponsors.ts'
import { assertUploadUnreferenced, deleteCompletedUpload, getCompletedUpload } from './upload-consumer.ts'
import { md5Base64 } from './tencent-cos.ts'
import { inspectMediaImageDimensions } from './media-preview.ts'
import type { Env } from '../types/index.ts'
import { signJWT } from './auth.ts'
import sponsors from '../routes/sponsors.ts'

const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
const origin = 'https://test-123.cos.ap-shanghai.myqcloud.com'
interface SqlStatement { sql: string; values: SQLInputValue[] }

function fixture() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(readFileSync(new URL('../../schemas/schema.sql', import.meta.url), 'utf8'))
  sqlite.exec(readFileSync(new URL('../../migrations/0062_sponsors.sql', import.meta.url), 'utf8'))
  sqlite.exec(readFileSync(new URL('../../migrations/0071_baby_albums.sql', import.meta.url), 'utf8'))
  sqlite.prepare("INSERT INTO users(id,username,email,password_hash) VALUES(42,'owner','o@test','x'),(7,'foreign','f@test','x')").run()
  sqlite.exec('CREATE TABLE IF NOT EXISTS comment_images(id INTEGER PRIMARY KEY,comment_id INTEGER,image_url TEXT,preview_url TEXT);')
  const hooks: { beforeBatch?: (statements: SqlStatement[]) => void; afterBatch?: (statements: SqlStatement[]) => void } = {}
  const adapter = {
    prepare(sql: string) {
      const statement = {
        sql, values: [] as SQLInputValue[],
        bind(...values: SQLInputValue[]) { this.values = values; return this },
        async all() { return { success: true, results: sqlite.prepare(sql).all(...this.values), meta: {} } },
        async first() { return sqlite.prepare(sql).get(...this.values) ?? null },
        async run() { const result = sqlite.prepare(sql).run(...this.values); return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } } },
      }
      return statement
    },
    async batch(statements: SqlStatement[]) {
      hooks.beforeBatch?.(statements)
      sqlite.exec('BEGIN IMMEDIATE')
      try {
        const results = statements.map(statement => {
          const result = sqlite.prepare(statement.sql).run(...statement.values)
          return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }
        })
        sqlite.exec('COMMIT')
        hooks.afterBatch?.(statements)
        return results
      } catch (error) { if (sqlite.isTransaction) sqlite.exec('ROLLBACK'); throw error }
    },
  }
  const env = { abdl_space_db: adapter, COS_SECRET_ID: 'fake-id', COS_SECRET_KEY: 'fake-key', COS_BUCKET: 'test-123', COS_REGION: 'ap-shanghai', SPONSOR_CODE_KEY: '' } as never as AlbumEnv
  return { sqlite, env, hooks }
}

function addImage(sqlite: DatabaseSync, id: number, options: { owner?: number; purpose?: string; url?: string; upload?: boolean; pending?: boolean; preview?: string | null } = {}): { key: string; url: string } {
  const owner = options.owner ?? 42
  const purpose = options.purpose ?? 'generic'
  const key = `${purpose === 'generic' ? 'generic' : 'media/original'}/${owner}/${id}.png`
  const url = options.url ?? `${origin}/${key}`
  sqlite.prepare('INSERT INTO posts(id,user_id,content,created_at) VALUES(?,42,?,?)').run(id, `post ${id}`, '2026-10-01 00:00:00')
  sqlite.prepare('INSERT INTO post_images(id,post_id,image_url,preview_url) VALUES(?,?,?,?)').run(id, id, url, options.preview ?? null)
  if (options.upload !== false) sqlite.prepare(`INSERT INTO media_uploads(id,user_id,purpose,object_key,public_url,mime_type,declared_size,verified_size,width,height,storage_provider,status,created_at,expires_at)
    VALUES(?,?,?,?,?,'image/png',?,?,1,1,'cos',?,unixepoch(),unixepoch()+300)`).run(`upload-${id}`, owner, purpose, key, url, png.byteLength, options.pending ? null : png.byteLength, options.pending ? 'pending' : 'complete')
  return { key, url }
}

function mockCos(sqlite: DatabaseSync, sources: { key: string }[]) {
  const original = globalThis.fetch
  const objects = new Map<string, { bytes: Uint8Array; mime: string }>(sources.map(source => [source.key, { bytes: png, mime: 'image/png' }]))
  const requests: Array<{ method: string; url: string; headers: Headers }> = []
  const modes: { get?: (key: string) => Response | undefined; putFailure?: boolean; deleteFailure?: boolean; afterPut?: () => void } = {}
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    requests.push({ method, url: url.href, headers })
    assert.equal(url.origin, origin, 'No requests to a user-provided/CDN/foreign origin')
    assert.equal(init?.redirect, 'manual')
    const key = decodeURIComponent(url.pathname.slice(1))
    if (method === 'PUT') {
      assert.equal(headers.get('x-cos-acl'), 'private')
      assert.equal(headers.get('x-cos-forbid-overwrite'), 'true')
      assert.ok(headers.get('Authorization')?.includes('x-cos-acl'))
      const reservation = sqlite.prepare('SELECT declared_size,expires_at FROM album_uploads WHERE object_key=?').get(key)!
      assert.ok(reservation, 'Reservation MUST exist before PUT')
      assert.ok(Number(sqlite.prepare('SELECT reserved_bytes FROM album_storage WHERE user_id=42').get()!.reserved_bytes) > 0)
      const expiry = Number(headers.get('Authorization')!.match(/q-sign-time=\d+;(\d+)/)![1])
      assert.ok(expiry <= Number(reservation.expires_at), 'PUT signature MUST NOT outlive DB cleanup lease')
      if (modes.putFailure) return new Response(null, { status: 503 })
      assert.equal(objects.has(key), false)
      const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer())
      assert.equal(bytes.byteLength, Number(reservation.declared_size))
      assert.equal(headers.get('Content-MD5'), md5Base64(bytes))
      objects.set(key, { bytes, mime: headers.get('Content-Type')! })
      modes.afterPut?.()
      return new Response(null, { status: 200 })
    }
    if (method === 'DELETE') {
      if (modes.deleteFailure) return new Response(null, { status: 503 })
      objects.delete(key)
      return new Response(null, { status: 204 })
    }
    const custom = method === 'GET' ? modes.get?.(key) : undefined
    if (custom) return custom
    const object = objects.get(key)
    if (!object) return new Response(null, { status: 404 })
    const etag = Buffer.from(md5Base64(object.bytes), 'base64').toString('hex')
    return new Response(method === 'HEAD' ? null : object.bytes, { headers: { 'Content-Type': object.mime, 'Content-Length': String(object.bytes.byteLength), ETag: `"${etag}"` } })
  }
  return { objects, requests, modes, restore() { globalThis.fetch = original } }
}

function scalar(sqlite: DatabaseSync, sql: string): number { return Number(Object.values(sqlite.prepare(sql).get()!)[0]) }

test('exact COS host verification rejects hostile origin/path/query tricks and missing configuration', () => {
  const env = { COS_BUCKET: 'test-123', COS_REGION: 'ap-shanghai' }
  const key = 'generic/42/1.png'
  assert.equal(isVerifiedHistoryCosUrl(env, `${origin}/${key}`, key), true)
  for (const url of [`http://${origin.slice(8)}/${key}`, 'https://127.0.0.1/a', 'https://169.254.169.254/a', `${origin}.evil.test/${key}`,
    `${origin}:444/${key}`, `https://user@${origin.slice(8)}/${key}`, `${origin}/${key}?x=1`, `${origin}/${key}#x`, `${origin}/generic/42/%2e%2e/1.png`]) assert.equal(isVerifiedHistoryCosUrl(env, url, key), false, url)
  assert.equal(isVerifiedHistoryCosUrl({ COS_BUCKET: '', COS_REGION: '' }, `${origin}/${key}`, key), false)
})

test('owned history uses real private copies with verified bytes/provenance, no reACL, and is idempotent', async () => {
  const { sqlite, env } = fixture()
  const source = addImage(sqlite, 10)
  const cos = mockCos(sqlite, [source])
  try {
    assert.deepEqual(await importAlbumHistory(env, 42), { imported: 1, skipped: 0, remaining: false })
    const row = sqlite.prepare('SELECT * FROM album_photos').get()!
    assert.equal(row.source_post_image_id, 10)
    assert.equal(row.source_upload_id, 'upload-10')
    assert.equal(row.hd_bytes, png.byteLength)
    assert.equal(row.original_key, null)
    assert.equal(row.uploaded_at, Date.parse('2026-10-01T00:00:00Z') / 1000)
    assert.ok(String(row.hd_key).startsWith('albums/42/history/'))
    assert.notEqual(row.hd_key, source.key)
    const preview = cos.objects.get(String(row.preview_key))!
    assert.ok(Math.max(...Object.values(inspectMediaImageDimensions(preview.bytes)!)) <= 540)
    assert.equal(preview.mime, 'image/jpeg')
    assert.equal(scalar(sqlite, 'SELECT used_bytes FROM album_storage WHERE user_id=42'), Number(row.preview_bytes) + Number(row.hd_bytes))
    assert.equal(scalar(sqlite, 'SELECT reserved_bytes FROM album_storage WHERE user_id=42'), 0)
    assert.equal(cos.objects.has(source.key), true)
    assert.equal(cos.requests.filter(request => request.method === 'PUT').length, 2)
    assert.equal(cos.requests.some(request => request.method === 'DELETE'), false)
    cos.requests.length = 0
    assert.deepEqual(await importAlbumHistory(env, 42), { imported: 0, skipped: 0, remaining: false })
    assert.equal(cos.requests.length, 0)
    sqlite.prepare('DELETE FROM posts WHERE id=10').run()
    assert.equal(scalar(sqlite, 'SELECT count(*) FROM album_photos'), 1, 'Deleting the public source must preserve independent album copies')
    assert.ok(cos.objects.has(String(row.hd_key)))
  } finally { cos.restore(); sqlite.close() }
})

test('same-owner status original and exact completed linked preview are copied independently', async () => {
  const { sqlite, env } = fixture()
  const previewKey = 'media/preview/42/proven.jpg'
  const source = addImage(sqlite, 1, { purpose: 'status_original', preview: `${origin}/${previewKey}` })
  const decoded = PhotonImage.new_from_byteslice(png)
  const previewBytes = decoded.get_bytes_jpeg(75)
  decoded.free()
  sqlite.prepare(`INSERT INTO media_uploads(id,user_id,purpose,object_key,public_url,mime_type,declared_size,verified_size,width,height,storage_provider,status,created_at,expires_at)
    VALUES('preview-1',42,'status_preview',?,?,'image/jpeg',?,?,1,1,'cos','complete',unixepoch(),unixepoch()+300)`).run(previewKey, `${origin}/${previewKey}`, previewBytes.byteLength, previewBytes.byteLength)
  sqlite.prepare('UPDATE media_uploads SET preview_upload_id=?,preview_object_key=?,preview_url=? WHERE id=?').run('preview-1', previewKey, `${origin}/${previewKey}`, 'upload-1')
  const cos = mockCos(sqlite, [source])
  cos.objects.set(previewKey, { bytes: previewBytes, mime: 'image/jpeg' })
  try {
    assert.deepEqual(await importAlbumHistory(env, 42), { imported: 1, skipped: 0, remaining: false })
    const row = sqlite.prepare('SELECT * FROM album_photos').get()!
    assert.equal(row.source_upload_id, 'upload-1')
    assert.deepEqual(cos.objects.get(String(row.preview_key))!.bytes, previewBytes)
    assert.equal(row.preview_bytes, previewBytes.byteLength)
    assert.equal(cos.objects.has(previewKey), true)
    assert.equal(cos.objects.has(source.key), true)
    assert.ok(cos.requests.some(request => request.method === 'GET' && new URL(request.url).pathname === `/${previewKey}`))
  } finally { cos.restore(); sqlite.close() }
})

test('actual Android-compatible lossless VP8L linked preview imports with owner proof and no terminal skip', async () => {
  const { sqlite, env } = fixture()
  const previewKey = 'media/preview/42/lossless.webp'
  const source = addImage(sqlite, 1, { purpose: 'status_original', preview: `${origin}/${previewKey}` })
  const decoded = PhotonImage.new_from_byteslice(png)
  const previewBytes = decoded.get_bytes_webp()
  decoded.free()
  assert.equal(new TextDecoder().decode(previewBytes.subarray(12, 16)), 'VP8L', 'Use a real lossless WebP, not a VP8X wrapper')
  assert.equal(inspectMediaImageDimensions(previewBytes), null, 'Regression fixture exercises the old inspector gap')
  sqlite.prepare(`INSERT INTO media_uploads(id,user_id,purpose,object_key,public_url,mime_type,declared_size,verified_size,width,height,storage_provider,status,created_at,expires_at)
    VALUES('preview-1',42,'status_preview',?,?,'image/webp',?,?,1,1,'cos','complete',unixepoch(),unixepoch()+300)`).run(previewKey, `${origin}/${previewKey}`, previewBytes.byteLength, previewBytes.byteLength)
  sqlite.prepare('UPDATE media_uploads SET preview_upload_id=?,preview_object_key=?,preview_url=? WHERE id=?').run('preview-1', previewKey, `${origin}/${previewKey}`, 'upload-1')
  const cos = mockCos(sqlite, [source])
  cos.objects.set(previewKey, { bytes: previewBytes, mime: 'image/webp' })
  try {
    assert.deepEqual(await importAlbumHistory(env, 42), { imported: 1, skipped: 0, remaining: false })
    const row = sqlite.prepare('SELECT * FROM album_photos').get()!
    assert.equal(row.source_upload_id, 'upload-1')
    assert.equal(row.source_post_image_id, 1)
    assert.equal(row.preview_bytes, previewBytes.byteLength)
    assert.deepEqual(cos.objects.get(String(row.preview_key))!.bytes, previewBytes)
    assert.equal(cos.objects.get(String(row.preview_key))!.mime, 'image/webp')
    assert.equal(scalar(sqlite, 'SELECT count(*) FROM album_history_attempts'), 0)
    assert.equal(cos.objects.has(previewKey), true)
    assert.equal(cos.objects.has(source.key), true)
  } finally { cos.restore(); sqlite.close() }
})

test('lossless WebP dimensions remain physically bounded and must match proven upload metadata', async () => {
  const decoded = PhotonImage.new_from_byteslice(png)
  const real = decoded.get_bytes_webp()
  decoded.free()
  for (const [width, height] of [[8193, 1], [4096, 4096], [2, 1]]) {
    const { sqlite, env } = fixture()
    const source = addImage(sqlite, 1, { purpose: 'status_original' })
    const mutated = real.slice()
    new DataView(mutated.buffer).setUint32(21, ((width - 1) | ((height - 1) << 14)) >>> 0, true)
    sqlite.prepare("UPDATE media_uploads SET mime_type='image/webp',declared_size=?,verified_size=?,width=?,height=? WHERE id='upload-1'").run(mutated.byteLength, mutated.byteLength, width === 2 ? 1 : width, height)
    const cos = mockCos(sqlite, [source])
    cos.objects.set(source.key, { bytes: mutated, mime: 'image/webp' })
    try {
      assert.deepEqual(await importAlbumHistory(env, 42), { imported: 0, skipped: 1, remaining: false })
      assert.equal(sqlite.prepare('SELECT reason FROM album_history_attempts').get()!.reason, 'source_dimensions')
      assert.equal(cos.requests.some(request => request.method === 'PUT'), false)
    } finally { cos.restore(); sqlite.close() }
  }
})

test('foreign, copied, pending, hostile URL and foreign preview sources skip without fetching and do not starve later pages', async () => {
  const { sqlite, env } = fixture()
  const good = addImage(sqlite, 1)
  addImage(sqlite, 6, { owner: 7 })
  addImage(sqlite, 5, { upload: false })
  addImage(sqlite, 4, { pending: true })
  addImage(sqlite, 3, { url: 'https://169.254.169.254/private' })
  addImage(sqlite, 2, { preview: `${origin}/media/preview/7/foreign.jpg` })
  const cos = mockCos(sqlite, [good])
  try {
    assert.deepEqual(await importAlbumHistory(env, 42), { imported: 0, skipped: 4, remaining: true })
    assert.equal(cos.requests.length, 0)
    assert.deepEqual(await importAlbumHistory(env, 42), { imported: 1, skipped: 1, remaining: false })
    assert.equal(scalar(sqlite, "SELECT count(*) FROM album_history_attempts WHERE outcome='skipped'"), 5)
    assert.equal(scalar(sqlite, 'SELECT count(*) FROM album_photos'), 1)
  } finally { cos.restore(); sqlite.close() }
})

test('no redirects or missing object fetch fallback; streaming size ceilings cancel before copying', async () => {
  for (const mode of ['redirect', 'missing', 'oversize']) {
    const { sqlite, env } = fixture()
    const source = addImage(sqlite, 1)
    const cos = mockCos(sqlite, [source])
    const cancelled = { value: false }
    try {
      cos.modes.get = key => key === source.key
        ? mode === 'redirect' ? new Response(null, { status: 302, headers: { Location: 'https://169.254.169.254/secret' } })
          : mode === 'missing' ? new Response(null, { status: 404 })
            : new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(10 * 1024 * 1024 + 1)) }, cancel() { cancelled.value = true } }), { headers: { 'Content-Type': 'image/png' } })
        : undefined
      const result = await importAlbumHistory(env, 42)
      assert.equal(result.imported, 0)
      assert.equal(result.skipped, 1)
      assert.equal(cos.requests.length, 1)
      assert.equal(cos.requests[0].method, 'GET')
      assert.equal(scalar(sqlite, 'SELECT count(*) FROM album_batches'), 0)
      if (mode === 'oversize') assert.equal(cancelled.value, true)
    } finally { cos.restore(); sqlite.close() }
  }
})

test('live transaction quota race rejects before PUT and concurrent duplicate imports reserve/copy once', async () => {
  const first = fixture()
  const source = addImage(first.sqlite, 1)
  const cos = mockCos(first.sqlite, [source])
  try {
    first.hooks.beforeBatch = statements => {
      if (statements.some(statement => statement.sql.includes('INSERT INTO album_batches'))) first.sqlite.prepare('UPDATE album_storage SET used_bytes=3221225471 WHERE user_id=42').run()
    }
    const result = await importAlbumHistory(first.env, 42)
    assert.equal(result.imported, 0)
    assert.equal(result.remaining, true)
    assert.equal(cos.requests.some(request => request.method === 'PUT'), false)
    assert.equal(scalar(first.sqlite, 'SELECT reserved_bytes FROM album_storage WHERE user_id=42'), 0)
    assert.equal(scalar(first.sqlite, 'SELECT count(*) FROM album_batches'), 0)
  } finally { cos.restore(); first.sqlite.close() }
  const second = fixture()
  const duplicate = addImage(second.sqlite, 1)
  const otherCos = mockCos(second.sqlite, [duplicate])
  try {
    const results = await Promise.all([importAlbumHistory(second.env, 42), importAlbumHistory(second.env, 42)])
    assert.equal(results.reduce((sum, result) => sum + result.imported, 0), 1)
    assert.equal(scalar(second.sqlite, 'SELECT count(*) FROM album_photos'), 1)
    assert.equal(otherCos.requests.filter(request => request.method === 'PUT').length, 2)
  } finally { otherCos.restore(); second.sqlite.close() }
})

test('copy failure retains durable reserved cleanup bytes until signature expiry and successful deletion', async () => {
  const { sqlite, env } = fixture()
  const source = addImage(sqlite, 1)
  const cos = mockCos(sqlite, [source])
  try {
    cos.modes.putFailure = true
    const result = await importAlbumHistory(env, 42)
    assert.equal(result.imported, 0)
    assert.equal(result.remaining, true)
    assert.equal(scalar(sqlite, 'SELECT count(*) FROM album_photos'), 0)
    assert.equal(scalar(sqlite, "SELECT count(*) FROM album_batches WHERE status='cancelled'"), 1)
    const reserved = scalar(sqlite, 'SELECT reserved_bytes FROM album_storage WHERE user_id=42')
    assert.ok(reserved > 0)
    assert.equal(cos.requests.some(request => request.method === 'DELETE'), false)
    sqlite.prepare('UPDATE album_uploads SET expires_at=unixepoch()-1').run()
    cos.modes.deleteFailure = true
    await cleanupAlbumObjects(env, 42)
    assert.equal(scalar(sqlite, 'SELECT reserved_bytes FROM album_storage WHERE user_id=42'), reserved)
    cos.modes.deleteFailure = false
    await cleanupAlbumObjects(env, 42)
    assert.equal(scalar(sqlite, 'SELECT reserved_bytes FROM album_storage WHERE user_id=42'), 0)
    assert.equal(cos.objects.has(source.key), true)
  } finally { cos.restore(); sqlite.close() }
})

test('ambiguous committed publication never cancels or deletes the private copies', async () => {
  const { sqlite, env, hooks } = fixture()
  const source = addImage(sqlite, 1)
  const cos = mockCos(sqlite, [source])
  try {
    hooks.afterBatch = statements => {
      if (statements.some(statement => statement.sql.includes("SET status='published'"))) { hooks.afterBatch = undefined; throw new Error('lost reply after commit') }
    }
    const result = await importAlbumHistory(env, 42)
    assert.equal(result.imported, 0)
    assert.equal(scalar(sqlite, 'SELECT count(*) FROM album_photos'), 1)
    assert.equal(scalar(sqlite, "SELECT count(*) FROM album_batches WHERE status='published'"), 1)
    assert.equal(scalar(sqlite, 'SELECT count(*) FROM album_object_cleanup'), 0)
    assert.equal(cos.requests.some(request => request.method === 'DELETE'), false)
  } finally { cos.restore(); sqlite.close() }
})

test('image deletion refuses attached/shared references and only deletes the public source after unlinking', async () => {
  const { sqlite, env } = fixture()
  const source = addImage(sqlite, 1)
  const cos = mockCos(sqlite, [source])
  try {
    const upload = await getCompletedUpload(env.abdl_space_db, 'upload-1', 42, 'generic')
    await assert.rejects(assertUploadUnreferenced(env.abdl_space_db, upload), /referenced/)
    const options = { db: env.abdl_space_db, id: upload.id, userId: 42, purpose: 'generic' as const, cos: { secretId: env.COS_SECRET_ID, secretKey: env.COS_SECRET_KEY, bucket: env.COS_BUCKET, region: env.COS_REGION } }
    await assert.rejects(deleteCompletedUpload(options), /referenced/)
    assert.equal(cos.requests.length, 0)
    await importAlbumHistory(env, 42)
    const album = sqlite.prepare('SELECT hd_key FROM album_photos').get()!
    sqlite.prepare('DELETE FROM posts WHERE id=1').run()
    await deleteCompletedUpload(options)
    assert.equal(cos.objects.has(source.key), false)
    assert.equal(cos.objects.has(String(album.hd_key)), true)
  } finally { cos.restore(); sqlite.close() }
})

test('POST handler accepts only selected owner empty bounded input and fails safe before migration', async () => {
  const app = new Hono<{ Bindings: Env; Variables: { user: { sub: number; username: string; email: string; role: string; iat: number; exp: number } } }>()
  app.use('*', async (c, next) => { c.set('user', { sub: 42, username: 'owner', email: 'o@test', role: 'user', iat: 0, exp: 9999999999 }); await next() })
  app.post('/import-history', importAlbumHistoryHandler)
  const { sqlite, env } = fixture()
  try {
    for (const [body, status] of [['{"url":"https://169.254.169.254"}', 400], ['[]', 400], ['x'.repeat(1025), 413]]) {
      const response = await app.request('/import-history', { method: 'POST', body: String(body) }, env as never)
      assert.equal(response.status, status)
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
    }
    const response = await app.request('/import-history', { method: 'POST', body: '{}' }, env as never)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { imported: 0, skipped: 0, remaining: false })
    assert.equal(scalar(sqlite, 'SELECT owner_id FROM albums WHERE is_default=1'), 42)
    sqlite.exec('DROP TABLE album_history_attempts')
    const unavailable = await app.request('/import-history', { method: 'POST', body: '{}' }, env as never)
    assert.equal(unavailable.status, 503)
    assert.equal((await unavailable.json() as { code: string }).code, 'albums_unavailable')
  } finally { sqlite.close() }
})

test('sponsor album guards deny revoked access before charging, rollback guard writes and recheck replay', async () => {
  const { sqlite, env } = fixture()
  try {
    sqlite.prepare("UPDATE sponsor_settings SET config_json=json_set(config_json,'$.enabled',json('true')) WHERE id=1").run()
    sqlite.exec('CREATE TABLE test_album_acl(id INTEGER PRIMARY KEY CHECK(id=1));')
    const allow = env.abdl_space_db.prepare('INSERT INTO test_album_acl(id) VALUES(?) ON CONFLICT DO NOTHING').bind(1)
    const deny = env.abdl_space_db.prepare('INSERT INTO test_album_acl(id) VALUES(?) ON CONFLICT DO NOTHING').bind(0)
    const body = { operation_id: crypto.randomUUID(), media_key: 'a'.repeat(64), notice_version: 1 }
    await assert.rejects(authorizeSponsorOriginal(env, 42, body, [allow, deny]))
    assert.equal(scalar(sqlite, 'SELECT count(*) FROM test_album_acl'), 0)
    assert.equal((await getSponsorMe(env, 42)).quota.used, 0)
    assert.equal(scalar(sqlite, 'SELECT count(*) FROM sponsor_operations'), 0)
    const first = await authorizeSponsorOriginal(env, 42, body, [allow])
    assert.equal(first.replayed, false)
    assert.equal(first.quota.used, 1)
    await assert.rejects(authorizeSponsorOriginal(env, 42, body, [deny]))
    assert.equal((await getSponsorMe(env, 42)).quota.used, 1)
    const replay = await authorizeSponsorOriginal(env, 42, body, [allow])
    assert.equal(replay.replayed, true)
    assert.equal(replay.quota.used, 1)
    assert.equal((await authorizeSponsorOriginal(env, 42, { ...body, operation_id: crypto.randomUUID() })).quota.used, 2, 'unguarded legacy behavior preserved')
  } finally { sqlite.close() }
})

test('sponsor me adds actual album quota with retained bytes after expiry; catalog benefits stay additive', async () => {
  const { sqlite, env } = fixture()
  const key = 'quota-test-secret'
  const requestEnv = { ...env, JWT_SECRET: key }
  const app = new Hono()
  app.route('/api/v1/sponsors', sponsors)
  try {
    const token = await signJWT({ sub: 42, username: 'owner', email: 'o@test', role: 'user' }, key)
    sqlite.prepare("UPDATE sponsor_settings SET config_json=json_set(config_json,'$.enabled',json('true')) WHERE id=1").run()
    sqlite.prepare('INSERT INTO album_storage(user_id,used_bytes,reserved_bytes) VALUES(42,12345,678)').run()
    sqlite.prepare('INSERT INTO sponsor_memberships(user_id,expires_at) VALUES(42,unixepoch()+3600)').run()
    const plan = String(sqlite.prepare("SELECT plan_json FROM sponsor_plans WHERE id='month'").get()!.plan_json)
    sqlite.prepare(`INSERT INTO sponsor_operations(id,operation_id,user_id,actor_id,kind,request_hash,reason,plan_json)
      VALUES('grant',?,42,'1','grant','hash','actual grant',?)`).run(crypto.randomUUID(), plan)
    const read = () => app.request('/api/v1/sponsors/me', { headers: { Authorization: `Bearer ${token}` } }, requestEnv as never)
    const active = await read()
    assert.equal(active.status, 200, await active.clone().text())
    const activeBody = await active.json() as { album_quota: { used_bytes: number; reserved_bytes: number; tier: string; limit_bytes: number; original_upload_allowed: boolean } }
    assert.equal(activeBody.album_quota.tier, 'month')
    assert.equal(activeBody.album_quota.used_bytes, 12345)
    assert.equal(activeBody.album_quota.reserved_bytes, 678)
    assert.equal(activeBody.album_quota.limit_bytes, 10 * 1024 ** 3)
    assert.equal(activeBody.album_quota.original_upload_allowed, true)
    sqlite.prepare('UPDATE sponsor_memberships SET expires_at=unixepoch()-1 WHERE user_id=42').run()
    const expiredBody = await (await read()).json() as typeof activeBody
    assert.equal(expiredBody.album_quota.tier, 'free')
    assert.equal(expiredBody.album_quota.limit_bytes, 3 * 1024 ** 3)
    assert.equal(expiredBody.album_quota.used_bytes, 12345)
    assert.equal(expiredBody.album_quota.original_upload_allowed, false)
    const catalog = await app.request('/api/v1/sponsors/catalog', {}, requestEnv as never)
    assert.equal(catalog.status, 200, await catalog.clone().text())
    const benefits = (await catalog.json() as { config: { benefits: Array<{ id: string; status: string; action: string; description: string }> } }).config.benefits
    assert.ok(benefits.some(benefit => benefit.id === 'original'))
    const album = benefits.find(benefit => benefit.id === 'album_storage')!
    assert.equal(album.status, 'automatic')
    assert.equal(album.action, 'none')
    assert.match(album.description, /100 GiB/)
    assert.equal(active.headers.get('Cache-Control'), 'private, no-store')
  } finally { sqlite.close() }
})
