import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Env } from '../types/index.ts'
import type { MastodonStatus } from './types.ts'
import mastodon from './routes.ts'
import { mergeAllTimelinePage } from './all-timeline.ts'

test('advances only sources actually returned by the merged timeline page', () => {
  const result = mergeAllTimelinePage(
    [
      { id: 'p_10', created_at: '2026-01-04T00:00:00.000Z' },
      { id: 'p_9', created_at: '2026-01-03T00:00:00.000Z' },
    ],
    [
      { id: 'nbw_8', created_at: '2026-01-02T00:00:00.000Z' },
      { id: 'nbw_7', created_at: '2026-01-01T00:00:00.000Z' },
    ],
    [],
    2,
    undefined,
    '',
    undefined,
    false,
    '',
  )

  assert.deepEqual(result.statuses.map((status) => status.id), ['p_10', 'p_9'])
  assert.equal(result.nextAbdlMaxId, 9)
  assert.equal(result.nextNBWCursor, '')
  assert.equal(result.nextFriendMaxId, -1)
  assert.equal(result.hasMore, true)
})

test('marks NBW exhausted when ABDL still has another page', () => {
  const result = mergeAllTimelinePage(
    [{ id: 'p_6', created_at: '2026-01-01T00:00:00.000Z' }],
    [{ id: 'nbw_8', created_at: '2026-01-02T00:00:00.000Z' }],
    [],
    1,
    7,
    'cursor_1',
    undefined,
    true,
    'cursor_1',
  )

  assert.deepEqual(result.statuses.map((status) => status.id), ['nbw_8'])
  assert.equal(result.nextNBWCursor, '!')
  assert.equal(result.hasMore, true)
})

test('merges friend requests as a third source by time', () => {
  const result = mergeAllTimelinePage(
    [{ id: 'p_6', created_at: '2026-01-01T00:00:00.000Z' }],
    [{ id: 'nbw_8', created_at: '2026-01-02T00:00:00.000Z' }],
[
      { id: 'fr_12', created_at: '2026-01-04T00:00:00.000Z' },
      { id: 'fr_11', created_at: '2026-01-03T00:00:00.000Z' },
    ],
    4,
    100,
    undefined,
    undefined,
    false,
    '',
  )

  assert.deepEqual(result.statuses.map((status) => status.id), ['fr_12', 'fr_11', 'nbw_8', 'p_6'])
  assert.equal(result.nextFriendMaxId, -1)
  assert.equal(result.nextAbdlMaxId, -1)
  assert.equal(result.hasMore, false)
})

test('advances friend cursor when cut mid-friend-page', () => {
  const result = mergeAllTimelinePage(
    [],
    [],
    [
      { id: 'fr_12', created_at: '2026-01-04T00:00:00.000Z' },
      { id: 'fr_11', created_at: '2026-01-03T00:00:00.000Z' },
      { id: 'fr_10', created_at: '2026-01-02T00:00:00.000Z' },
    ],
    2,
    undefined,
    '',
    undefined,
    false,
    '',
  )

  assert.deepEqual(result.statuses.map((status) => status.id), ['fr_12', 'fr_11'])
  assert.equal(result.nextFriendMaxId, 11)
  assert.equal(result.hasMore, true)
})

test('unavailable NBW preserves its opaque cursor and only healthy sources generate continuation', () => {
  const result = mergeAllTimelinePage(
    [{ id: 'p_10', created_at: '2026-01-04T00:00:00Z' }], [], [], 1,
    20, 'opaque/do-not-consume', undefined, false, 'opaque/do-not-consume', true,
  )
  assert.equal(result.nextAbdlMaxId, 10)
  assert.equal(result.nextNBWCursor, 'opaque/do-not-consume')
  assert.equal(result.hasMore, true)
  const empty = mergeAllTimelinePage([], [], [], 1, -1, 'opaque/do-not-consume', -1, false, '', true)
  assert.equal(empty.nextNBWCursor, 'opaque/do-not-consume')
  assert.equal(empty.hasMore, false)
})

const nativeHeaders = { 'User-Agent': 'MastodonAndroid/3.0.1', 'X-App-Version-Code': '32', Origin: 'https://m.abdl-space.top' }

function routeFixture() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(readFileSync(new URL('../../schemas/schema.sql', import.meta.url), 'utf8'))
  sqlite.exec(readFileSync(new URL('../../migrations/0070_app_clients.sql', import.meta.url), 'utf8'))
  sqlite.exec(`CREATE TABLE user_badges(user_id INTEGER,badge_key TEXT,displayed INTEGER,unlocked_at TEXT);
    CREATE TABLE badges(key TEXT,name TEXT,color TEXT);
    INSERT INTO users(id,username,email,password_hash) VALUES(42,'owner','owner@example.test','unused');`)
  for (let id = 1; id <= 4; id++) {
    sqlite.prepare('INSERT INTO posts(id,user_id,content,created_at) VALUES(?,42,?,?)')
      .run(id, `local ${id}`, `2026-10-05T00:00:0${id * 2}Z`)
    sqlite.prepare(`INSERT INTO friend_requests(id,user_id,title,looking_for,description,created_at,updated_at)
      VALUES(?,42,?,'friends','friend description',?,?)`)
      .run(id, `friend ${id}`, `2026-10-05T00:00:0${id * 2 - 1}Z`, `2026-10-05T00:00:0${id * 2 - 1}Z`)
  }
  const statement = (sql: string, params: SQLInputValue[] = []) => ({
    bind: (...values: SQLInputValue[]) => statement(sql, values),
    async all() { return { success: true, results: sqlite.prepare(sql).all(...params) } },
  })
  const env = { abdl_space_db: { prepare: (sql: string) => statement(sql) }, NBW_API_KEY: 'fixture-not-a-production-key' } as never as Env
  const app = new Hono()
  app.use('*', cors({ origin: '*' }))
  app.route('/api/v1', mastodon)
  return { sqlite, env, app }
}

function nextPage(response: Response): { url: string; cursor: { a: number; n: string; f: number } } {
  const link = response.headers.get('Link') || ''
  const match = /<([^>]+)>;\s*rel="next"/.exec(link)
  assert.ok(match, `missing next Link: ${link}`)
  const url = new URL(match[1], 'https://fixture.test')
  return { url: url.pathname + url.search, cursor: JSON.parse(atob(url.searchParams.get('max_id')!)) }
}

test('actual native merged feed survives NBW 526 across pages without losing local/friend posts or duplicating reminders', async () => {
  const f = routeFixture()
  const originalFetch = globalThis.fetch
  const originalWarn = console.warn
  const warnings: string[] = []
  console.warn = value => { warnings.push(String(value)) }
  globalThis.fetch = async () => new Response('error code: 526\nprivate-upstream-payload', { status: 526 })
  try {
    f.sqlite.prepare('INSERT INTO site_settings(key,value) VALUES(?,?)')
      .run('app_client_reminder', JSON.stringify({ enabled: true, version_codes: [32], include_unversioned: true, message: 'test update' }))
    let url = '/api/v1/timelines/all?limit=3'
    const realIds: string[] = []
    for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
      const response = await f.app.request(url, { headers: nativeHeaders }, f.env)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('X-ABDL-Timeline-Degraded'), 'nbw')
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*')
      assert.ok(response.headers.get('Vary')?.includes('X-App-Version-Code'))
      const statuses = await response.json() as MastodonStatus[]
      assert.equal(statuses.filter(s => s.id === 'app-update-required').length, pageIndex === 0 ? 1 : 0)
      for (const status of statuses) {
        assert.ok(status.id && status.uri && status.created_at && status.account)
        for (const key of ['media_attachments', 'mentions', 'tags', 'emojis'] as const) assert.ok(Array.isArray(status[key]))
      }
      realIds.push(...statuses.filter(s => s.id !== 'app-update-required').map(s => s.id))
      if (pageIndex < 2) {
        const next = nextPage(response)
        assert.equal(next.cursor.n, '')
        assert.notEqual(next.cursor.n, '!')
        url = next.url
      } else assert.equal(response.headers.get('Link'), null)
    }
    assert.deepEqual(realIds, ['p_4', 'fr_4', 'p_3', 'fr_3', 'p_2', 'fr_2', 'p_1', 'fr_1'])
    assert.equal(new Set(realIds).size, 8)
    const entries = warnings.map(value => JSON.parse(value))
    assert.equal(entries.filter(event => event.event === 'nbw_timeline_unavailable' && event.upstream_status === 526).length, 3)
    assert.equal(warnings.join('').includes('private-upstream-payload'), false)
    assert.equal(warnings.join('').includes('fixture-not-a-production-key'), false)
  } finally { globalThis.fetch = originalFetch; console.warn = originalWarn; f.sqlite.close() }
})

test('native merged feed normal20/40 and continuation40 survive malformed NBW without dropping real posts', async t => {
  const f = routeFixture()
  t.mock.method(globalThis, 'fetch', async () => Response.json({ code: 200, data: { list: [null] } }))
  t.mock.method(console, 'warn', () => {})
  try {
    f.sqlite.exec('DELETE FROM posts; DELETE FROM friend_requests')
    for (let id = 1; id <= 81; id++) {
      f.sqlite.prepare('INSERT INTO posts(id,user_id,content,created_at) VALUES(?,42,?,?)')
        .run(id, `local ${id}`, new Date(Date.UTC(2026, 9, 5) + id * 1000).toISOString())
    }
    for (const limit of [20, 40]) {
      const response = await f.app.request(`/api/v1/timelines/all?limit=${limit}`, { headers: nativeHeaders }, f.env)
      assert.equal(response.status, 200)
      const body = await response.json() as MastodonStatus[]
      assert.deepEqual(body.map(s => s.id), Array.from({ length: limit }, (_, i) => `p_${81 - i}`))
      const next = nextPage(response)
      assert.equal(next.cursor.n, '')
      assert.equal(next.cursor.f, -1)
      assert.equal(next.cursor.a, 82 - limit)
      if (limit === 40) {
        const second = await f.app.request(next.url, { headers: nativeHeaders }, f.env)
        assert.equal(second.status, 200)
        assert.deepEqual((await second.json() as MastodonStatus[]).map(s => s.id), Array.from({ length: 40 }, (_, i) => `p_${41 - i}`))
        const last = await f.app.request(nextPage(second).url, { headers: nativeHeaders }, f.env)
        assert.deepEqual((await last.json() as MastodonStatus[]).map(s => s.id), ['p_1'])
        assert.equal(last.headers.get('Link'), null)
      }
    }
  } finally { f.sqlite.close() }
})

test('actual native merged feed survives a stalled NBW read after the5s deadline without waiting for native60s timeout', async t => {
  const f = routeFixture()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let started!: () => void
  const fetching = new Promise<void>(resolve => { started = resolve })
  let signal: AbortSignal | undefined
  t.mock.method(globalThis, 'fetch', async (_input: Parameters<typeof fetch>[0], options?: RequestInit) => {
    signal = options?.signal ?? undefined
    started()
    return await new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('private-timeout-message')))
    })
  })
  t.mock.method(console, 'warn', () => {})
  try {
    const pending = f.app.request('/api/v1/timelines/all?limit=20', { headers: nativeHeaders }, f.env)
    await fetching
    t.mock.timers.tick(5000)
    const response = await pending
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('X-ABDL-Timeline-Degraded'), 'nbw')
    assert.equal((await response.json() as MastodonStatus[]).length, 8)
    assert.equal(signal?.aborted, true)
  } finally { f.sqlite.close() }
})

test('actual native merged feed keeps an opaque NBW cursor through non-JSON/network failure and resumes it on recovery', async () => {
  const f = routeFixture()
  const originalFetch = globalThis.fetch
  let mode: 'json' | 'network' | 'healthy' = 'json'
  const seenCursors: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    assert.equal(url.origin, 'https://www.newbabyworld.top')
    assert.equal(init?.redirect, 'manual')
    assert.ok(init?.signal)
    seenCursors.push(url.searchParams.get('cursor') || '')
    if (mode === 'network') throw new Error('private-network-secret')
    if (mode === 'json') return new Response('<html>private-proxy-error</html>', { status: 200 })
    return Response.json({ code: 200, data: { has_more: false, next_cursor: '', list: [
      { tid: 90, authorid: 9, author: 'NBW', subject: 'recovered', dateline: 1791158399 },
    ] } })
  }
  try {
    const initialCursor = btoa(JSON.stringify({ a: 0, n: 'opaque/+unconsumed=', f: 0 }))
    const first = await f.app.request(`/api/v1/timelines/all?limit=2&max_id=${encodeURIComponent(initialCursor)}`, { headers: nativeHeaders }, f.env)
    assert.equal(first.status, 200)
    assert.deepEqual((await first.json() as MastodonStatus[]).map(s => s.id), ['p_4', 'fr_4'])
    const secondRequest = nextPage(first)
    assert.equal(secondRequest.cursor.n, 'opaque/+unconsumed=')
    mode = 'network'
    const second = await f.app.request(secondRequest.url, { headers: nativeHeaders }, f.env)
    assert.equal(second.status, 200)
    assert.deepEqual((await second.json() as MastodonStatus[]).map(s => s.id), ['p_3', 'fr_3'])
    const thirdRequest = nextPage(second)
    assert.equal(thirdRequest.cursor.n, 'opaque/+unconsumed=')
    mode = 'healthy'
    const third = await f.app.request(thirdRequest.url, { headers: nativeHeaders }, f.env)
    assert.equal(third.status, 200)
    assert.equal(third.headers.get('X-ABDL-Timeline-Degraded'), null)
    assert.deepEqual((await third.json() as MastodonStatus[]).map(s => s.id), ['p_2', 'fr_2'])
    // The recovered NBW row was not returned yet, so its opaque cursor is still not consumed.
    const fourthRequest = nextPage(third)
    assert.equal(fourthRequest.cursor.n, 'opaque/+unconsumed=')
    const fourth = await f.app.request(fourthRequest.url, { headers: nativeHeaders }, f.env)
    assert.deepEqual((await fourth.json() as MastodonStatus[]).map(s => s.id), ['p_1', 'fr_1'])
    const fifth = await f.app.request(nextPage(fourth).url, { headers: nativeHeaders }, f.env)
    assert.deepEqual((await fifth.json() as MastodonStatus[]).map(s => s.id), ['nbw_90'])
    assert.equal(fifth.headers.get('Link'), null)
    assert.deepEqual(seenCursors, Array(5).fill('opaque/+unconsumed='))
  } finally { globalThis.fetch = originalFetch; f.sqlite.close() }
})

test('unavailable NBW-only native page returns safe503, while healthy terminal empty and local DB errors stay distinct', async () => {
  const f = routeFixture()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('error code: 526\nsecret-body', { status: 526 })
  try {
    const terminalCursor = btoa(JSON.stringify({ a: -1, n: 'opaque-retry', f: -1 }))
    const url = `/api/v1/timelines/all?limit=20&max_id=${encodeURIComponent(terminalCursor)}`
    const failed = await f.app.request(url, { headers: nativeHeaders }, f.env)
    assert.equal(failed.status, 503)
    assert.equal(failed.headers.get('Link'), null)
    assert.equal(failed.headers.get('X-ABDL-Timeline-Degraded'), 'nbw')
    assert.deepEqual(await failed.json(), { error: 'NBW 服务暂时不可用', code: 'nbw_unavailable' })
    globalThis.fetch = async () => Response.json({ code: 200, data: { list: [], has_more: false } })
    const empty = await f.app.request(url, { headers: nativeHeaders }, f.env)
    assert.equal(empty.status, 200)
    assert.deepEqual(await empty.json(), [])
    f.sqlite.exec('DROP TABLE posts')
    const dbFailure = await f.app.request('/api/v1/timelines/all?limit=20', { headers: nativeHeaders }, f.env)
    assert.equal(dbFailure.status, 500)
    assert.deepEqual(await dbFailure.json(), { error: 'Internal Server Error' })
    const home = await f.app.request('/api/v1/timelines/home?limit=20', { headers: nativeHeaders }, f.env)
    assert.equal(home.status, 401)
  } finally { globalThis.fetch = originalFetch; f.sqlite.close() }
})
