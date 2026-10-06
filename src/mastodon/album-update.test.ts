import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import test from 'node:test'
import { Hono } from 'hono'
import { ALBUM_POST_FALLBACK, hydrateAlbumPostResponse, hydrateAlbumPostUpdates, toAccount, toStatus } from './converter.ts'
import mastodon from './routes.ts'
import webPosts from '../routes/posts.ts'
import { signJWT } from '../lib/auth.ts'
import type { Env } from '../types/index.ts'
import type { AlbumPostUpdate, MastodonStatus } from './types.ts'

function fixture() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(readFileSync(new URL('../../schemas/schema.sql', import.meta.url), 'utf8'))
  sqlite.exec(readFileSync(new URL('../../migrations/0062_sponsors.sql', import.meta.url), 'utf8'))
  sqlite.exec(readFileSync(new URL('../../migrations/0071_baby_albums.sql', import.meta.url), 'utf8'))
  sqlite.exec(`CREATE TABLE IF NOT EXISTS user_badges(user_id INTEGER,badge_key TEXT,displayed INTEGER DEFAULT 0,unlocked_at TEXT);
    CREATE TABLE IF NOT EXISTS badges(key TEXT,name TEXT,color TEXT);`)
  for (const column of ['header', 'display_name', 'profile_fields', 'nbw_username']) {
    if (!sqlite.prepare('PRAGMA table_info(users)').all().some(row => row.name === column)) sqlite.exec(`ALTER TABLE users ADD COLUMN ${column} TEXT`)
  }
  sqlite.prepare("INSERT INTO users(id,username,email,password_hash) VALUES(42,'owner','owner@example.test','x')").run()
  sqlite.prepare("INSERT INTO posts(id,user_id,content) VALUES(100,42,?)").run(ALBUM_POST_FALLBACK)
  sqlite.prepare("INSERT INTO albums(id,owner_id,name,visibility) VALUES('album',42,'公开相册','public')").run()
  sqlite.prepare(`INSERT INTO album_batches(id,album_id,owner_id,operation_id,request_hash,description,quality,photo_count,reserved_bytes,expires_at)
    VALUES('batch','album',42,'op','hash','描述只在原生渠道显示','hd',1,8,unixepoch()+300)`).run()
  // Construct the read fixture without emulating publication triggers (core tests cover that transaction).
  sqlite.exec('DROP TRIGGER album_batch_publish_validate; DROP TRIGGER album_batch_publish_apply;')
  sqlite.prepare("UPDATE album_batches SET status='published',post_id=100 WHERE id='batch'").run()
  sqlite.prepare(`INSERT INTO album_photos(id,album_id,batch_id,owner_id,client_id,uploaded_at,width,height,preview_key,hd_key,preview_bytes,hd_bytes)
    VALUES('photo','album','batch',42,'client',unixepoch(),1000,800,'albums/42/preview','albums/42/hd',4,4)`).run()
  const calls: string[] = []
  const hooks: { beforeQuery?: (sql: string) => void } = {}
  const db = {
    prepare(sql: string) {
      calls.push(sql)
      const params: { values: SQLInputValue[] } = { values: [] }
      return {
        bind(...values: SQLInputValue[]) { params.values = values; return this },
        async all() { hooks.beforeQuery?.(sql); return { success: true, results: sqlite.prepare(sql).all(...params.values), meta: {} } },
        async first() { return sqlite.prepare(sql).get(...params.values) ?? null },
        async run() { const result = sqlite.prepare(sql).run(...params.values); return { success: true, meta: { changes: Number(result.changes) } } },
      }
    },
  }
  const env = { abdl_space_db: db, COS_SECRET_ID: 'test-id', COS_SECRET_KEY: 'test-key', COS_BUCKET: 'test-123', COS_REGION: 'ap-shanghai' } as never as Env
  return { sqlite, env, calls, hooks }
}

const account = toAccount({ id: 42, username: 'owner', avatar: null, role: 'user', created_at: '2026-10-05 01:00:00' })
const rawPost = { id: 100, user_id: 42, content: ALBUM_POST_FALLBACK, created_at: '2026-10-05 01:00:00' }
const metadata: AlbumPostUpdate = { album_id: 'album', album_name: '公开相册', description: 'secret', photo_count: 1, cover_url: 'https://old.test/preview', width: 1000, height: 800, download_protected: false }

test('sync converter uses exact fallback and no attachments, only explicitly current public metadata', () => {
  const rich = toStatus({ ...rawPost, content: 'private description must never replace fallback', album_update: metadata, album_visibility: 'public',
    images: [{ image_url: 'https://public.test/hd' }] }, account)
  assert.equal(rich.content, `<p>${ALBUM_POST_FALLBACK}</p>`)
  assert.deepEqual(rich.media_attachments, [])
  assert.deepEqual(rich.album_update, metadata)
  assert.equal(rich.card, null)
  const hidden = toStatus({ ...rawPost, album_update: metadata, album_visibility: 'private' }, account)
  assert.equal('album_update' in hidden, false)
  const unverified = toStatus({ ...rawPost, album_update: metadata }, account)
  assert.equal('album_update' in unverified, false)
  const legacy = toStatus({ ...rawPost, content: 'ordinary post' }, account)
  assert.equal(legacy.content, '<p>ordinary post</p>')
  assert.equal('album_update' in legacy, false)
})

test('native public album rehydration signs only private preview keys in one batch', async () => {
  const { sqlite, env, calls } = fixture()
  try {
    const status = toStatus(rawPost, account)
    const result = [status, { ...status, id: 'p_101' }]
    assert.equal(await hydrateAlbumPostUpdates(env, result, true), true)
    assert.equal(status.album_update?.description, '描述只在原生渠道显示')
    const cover = new URL(status.album_update!.cover_url)
    assert.equal(cover.hostname, 'test-123.cos.ap-shanghai.myqcloud.com')
    assert.equal(cover.pathname, '/albums/42/preview')
    assert.ok(cover.searchParams.has('q-signature'))
    assert.equal(Number(cover.searchParams.get('q-sign-time')!.split(';')[1]) - Number(cover.searchParams.get('q-sign-time')!.split(';')[0]), 60)
    assert.equal(JSON.stringify(result).includes('/albums/42/hd'), false)
    assert.equal(calls.filter(sql => sql.includes('FROM album_batches')).length, 2)
    assert.equal('album_update' in result[1], false)
  } finally { sqlite.close() }
})

test('nested cached public cards cannot survive current private/shared visibility or deletion', async () => {
  const { sqlite, env } = fixture()
  try {
    for (const visibility of ['private', 'shared']) {
      sqlite.prepare('UPDATE albums SET visibility=? WHERE id=?').run(visibility, 'album')
      const old = { ...toStatus(rawPost, account), album_update: metadata, content: '<p>stale description</p>', media_attachments: [{ url: 'https://stale.test/hd' }] }
      const payload = { notifications: [{ status: { ...toStatus({ ...rawPost, id: 200, content: '' }, account), reblog: old } }] }
      await hydrateAlbumPostUpdates(env, payload, true)
      assert.equal('album_update' in old, false)
      assert.equal(old.content, `<p>${ALBUM_POST_FALLBACK}</p>`)
      assert.deepEqual(old.media_attachments, [])
      assert.equal(JSON.stringify(payload).includes('secret'), false)
    }
    sqlite.prepare("UPDATE albums SET visibility='public',deleted_at=unixepoch() WHERE id='album'").run()
    const status = { ...toStatus(rawPost, account), album_update: metadata }
    await hydrateAlbumPostUpdates(env, status, true)
    assert.equal('album_update' in status, false)
  } finally { sqlite.close() }
})

test('web response has fallback only and pagination headers survive, native response has additive card', async () => {
  const { sqlite, env } = fixture()
  try {
    for (const native of [false, true]) {
      const original = Response.json([toStatus(rawPost, account)], { headers: { Link: '</next>; rel="next"', 'X-Cursor': 'keep', 'Cache-Control': 'public, max-age=900', ETag: 'old' } })
      const response = await hydrateAlbumPostResponse(env, original, native)
      const [status] = await response.json() as MastodonStatus[]
      assert.equal(!!status.album_update, native)
      assert.equal(status.content, `<p>${ALBUM_POST_FALLBACK}</p>`)
      assert.deepEqual(status.media_attachments, [])
      assert.equal(response.headers.get('Link'), '</next>; rel="next"')
      assert.equal(response.headers.get('X-Cursor'), 'keep')
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
      assert.equal(response.headers.has('ETag'), false)
    }
  } finally { sqlite.close() }
})

test('missing migration fails safe, logs explicitly and removes cached private payload', async () => {
  const warnings: string[] = []
  const warn = console.warn
  console.warn = value => { warnings.push(String(value)) }
  try {
    const env = { abdl_space_db: { prepare() { throw new Error('no such table: album_batches') } } } as never as Env
    const status = { ...toStatus(rawPost, account), album_update: metadata }
    await hydrateAlbumPostUpdates(env, status, true)
    assert.equal('album_update' in status, false)
    assert.equal(status.content, `<p>${ALBUM_POST_FALLBACK}</p>`)
    assert.ok(warnings.some(value => value.includes('album_post_metadata_unavailable')))
  } finally { console.warn = warn }
})

test('actual Mastodon profile, public timeline and detail routes are covered for native and web', async () => {
  const { sqlite, env } = fixture()
  const app = new Hono()
  app.route('/api/v1', mastodon)
  try {
    for (const path of ['/api/v1/accounts/42/statuses', '/api/v1/timelines/public', '/api/v1/statuses/p_100']) {
      for (const ua of ['MastodonAndroid/3.0.1', 'Mozilla/5.0']) {
        const response = await app.request(path, { headers: { 'User-Agent': ua } }, env)
        assert.equal(response.status, 200, await response.clone().text())
        const payload = await response.json()
        const status = (Array.isArray(payload) ? payload.find(item => item.id === 'p_100') : payload) as MastodonStatus
        assert.ok(status)
        assert.equal(!!status.album_update, ua.startsWith('MastodonAndroid/'), path)
        assert.equal(status.content, `<p>${ALBUM_POST_FALLBACK}</p>`)
        assert.deepEqual(status.media_attachments, [])
      }
    }
    sqlite.prepare("UPDATE albums SET visibility='private' WHERE id='album'").run()
    const response = await app.request('/api/v1/statuses/p_100', { headers: { 'User-Agent': 'MastodonAndroid/3.0.1' } }, env)
    assert.equal(response.status, 200)
    const hidden = await response.json() as Record<string, unknown>
    assert.equal('album_update' in hidden, false)
  } finally { sqlite.close() }
})

test('public-to-private race while signing withholds the card after final live recheck', async () => {
  const { sqlite, env, hooks } = fixture()
  try {
    const count = { reads: 0 }
    hooks.beforeQuery = sql => {
      if (sql.includes('FROM album_batches') && ++count.reads === 2) sqlite.prepare("UPDATE albums SET visibility='private' WHERE id='album'").run()
    }
    const status = toStatus(rawPost, account)
    await hydrateAlbumPostUpdates(env, status, true)
    assert.equal(count.reads, 2)
    assert.equal('album_update' in status, false)
    assert.equal(status.content, `<p>${ALBUM_POST_FALLBACK}</p>`)
  } finally { sqlite.close() }
})

test('batch cover uses selected order, never another batch or deleted first photo', async () => {
  const { sqlite, env } = fixture()
  try {
    sqlite.prepare("UPDATE album_photos SET sort_order=1 WHERE id='photo'").run()
    sqlite.prepare(`INSERT INTO album_photos(id,album_id,batch_id,owner_id,client_id,sort_order,uploaded_at,width,height,preview_key,hd_key,preview_bytes,hd_bytes)
      VALUES('z-first','album','batch',42,'z-client',0,unixepoch(),800,600,'albums/42/first-preview','albums/42/first-hd',4,4)`).run()
    const status = toStatus(rawPost, account)
    await hydrateAlbumPostUpdates(env, status, true)
    assert.equal(new URL(status.album_update!.cover_url).pathname, '/albums/42/first-preview')
    assert.equal(status.album_update!.photo_count, 2)
    sqlite.prepare("UPDATE album_photos SET deleted_at=unixepoch() WHERE id='z-first'").run()
    await hydrateAlbumPostUpdates(env, status, true)
    assert.equal(new URL(status.album_update!.cover_url).pathname, '/albums/42/preview')
    sqlite.prepare("UPDATE album_photos SET deleted_at=unixepoch() WHERE id='photo'").run()
    await hydrateAlbumPostUpdates(env, status, true)
    assert.equal('album_update' in status, false)
  } finally { sqlite.close() }
})

test('oversized stale snapshot is sanitized before response middleware size bypass, without reading unavailable D1', async () => {
  const app = new Hono()
  app.route('/api/v1', mastodon)
  const stale = { ...toStatus(rawPost, account), album_update: metadata, content: '<p>stale-secret</p>', account: { ...account, note: 'x'.repeat(2 * 1024 * 1024) } }
  const env = { abdl_space_db: { prepare() { throw new Error('unavailable') } }, NOTICE_KV: { async get() { return [stale] } } } as never as Env
  const response = await app.request('/api/v1/timelines/public', { headers: { 'User-Agent': 'MastodonAndroid/3.0.1' } }, env)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('X-ABDL-Timeline-Fallback'), 'snapshot')
  const [status] = await response.json() as MastodonStatus[]
  assert.equal('album_update' in status, false)
  assert.equal(status.content, `<p>${ALBUM_POST_FALLBACK}</p>`)
  assert.deepEqual(status.media_attachments, [])
})

test('protected native cards are metadata-only for old/new native clients and web stays plain fallback', async () => {
  const { sqlite, env } = fixture()
  try {
    sqlite.exec("INSERT INTO album_protection(album_id,download_protected) VALUES('album',1)")
    for (const native of [false, true]) {
      const status = { ...toStatus(rawPost, account), album_update: metadata, media_attachments: [{ url: 'https://cached.test/private.jpg' }] }
      await hydrateAlbumPostUpdates(env, status, native)
      assert.equal(status.content, `<p>${ALBUM_POST_FALLBACK}</p>`); assert.deepEqual(status.media_attachments, [])
      if (native) {
        assert.equal(status.album_update?.download_protected, true); assert.equal(status.album_update?.cover_url, '')
        assert.equal(status.album_update?.width, 1000); assert.equal(status.album_update?.height, 800)
      } else assert.equal('album_update' in status, false)
      assert.doesNotMatch(JSON.stringify(status), /q-signature|cached.test|old.test/)
    }
    const app = new Hono(); app.route('/api/v1', mastodon)
    for (const ua of ['MastodonAndroid/3.0.1', 'MastodonAndroid/3.1.0', 'Mozilla/5.0']) {
      const response = await app.request('/api/v1/statuses/p_100', { headers: { 'User-Agent': ua } }, env)
      assert.equal(response.status, 200)
      const status = await response.json() as MastodonStatus
      assert.equal(status.content, `<p>${ALBUM_POST_FALLBACK}</p>`); assert.deepEqual(status.media_attachments, [])
      if (ua.startsWith('MastodonAndroid/')) { assert.equal(status.album_update?.download_protected, true); assert.equal(status.album_update?.cover_url, '') }
      else assert.equal('album_update' in status, false)
      assert.doesNotMatch(JSON.stringify(status), /q-signature|albums\/42\//)
    }
  } finally { sqlite.close() }
})

test('native card final live protection read strips signed cover on toggle and ignores cached metadata', async () => {
  const { sqlite, env, hooks } = fixture()
  try {
    let reads = 0
    hooks.beforeQuery = sql => { if (sql.includes('FROM album_batches') && ++reads === 2) sqlite.exec("INSERT INTO album_protection(album_id,download_protected) VALUES('album',1)") }
    const status = { ...toStatus(rawPost, account), album_update: metadata }
    await hydrateAlbumPostUpdates(env, status, true)
    assert.equal(reads, 2); assert.equal(status.album_update?.download_protected, true); assert.equal(status.album_update?.cover_url, '')
    assert.doesNotMatch(JSON.stringify(status), /q-signature|old.test/)
    hooks.beforeQuery = undefined
    sqlite.exec('UPDATE album_protection SET download_protected=0')
    await hydrateAlbumPostUpdates(env, status, true)
    assert.equal(status.album_update?.download_protected, false); assert.match(status.album_update!.cover_url, /q-signature/)
  } finally { sqlite.close() }
})

test('unavailable protection table fails closed even with an old cached authorized cover', async () => {
  const { sqlite, env, hooks } = fixture()
  try {
    hooks.beforeQuery = sql => { if (sql.includes('album_protection')) throw new Error('no such table: album_protection') }
    const status = { ...toStatus(rawPost, account), album_update: metadata }
    await hydrateAlbumPostUpdates(env, status, true)
    assert.equal('album_update' in status, false); assert.equal(status.content, `<p>${ALBUM_POST_FALLBACK}</p>`)
    assert.doesNotMatch(JSON.stringify(status), /old.test|q-signature/)
  } finally { sqlite.close() }
})

test('ordinary native and web edits cannot rewrite album fallback posts or attach standard media', async () => {
  const { sqlite, env } = fixture()
  const key = 'edit-album-test'
  const token = await signJWT({ sub: 42, username: 'owner', email: 'owner@example.test', role: 'user' }, key)
  const app = new Hono()
  app.route('/api/v1', mastodon)
  app.route('/api/posts', webPosts)
  try {
    for (const [path, method, body] of [
      ['/api/v1/statuses/p_100', 'PUT', { status: 'leak private description', media_ids: ['https://img.abdl-space.top/file/copy.jpg'] }],
      ['/api/posts/100', 'PATCH', { content: 'leak private description' }],
    ] as const) {
      const response = await app.request(path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, { ...env, JWT_SECRET: key })
      assert.equal(response.status, 409, await response.clone().text())
      assert.equal((await response.json() as { code: string }).code, 'use_album_endpoint')
    }
    assert.equal(sqlite.prepare('SELECT content FROM posts WHERE id=100').get()!.content, ALBUM_POST_FALLBACK)
    assert.equal(sqlite.prepare('SELECT count(*) AS count FROM post_images WHERE post_id=100').get()!.count, 0)
  } finally { sqlite.close() }
})
