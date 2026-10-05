import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import type { Env } from '../types/index.ts'
import { NBW_BASE_URL, NBWUnavailableError, nbwS2SRequest } from '../lib/nbw.ts'
import mastodon from './routes.ts'
import abdl from './abdl.ts'
import { buildNBWTimelineParams, buildNBWTimelineNextLink, hasNextAllTimelinePage, parseNBWSyncData } from './nbw-timeline.ts'

test('maps Mastodon timeline query parameters to get_sync_threads parameters', () => {
  assert.deepEqual(buildNBWTimelineParams({
    limit: '80',
    max_id: '1700000000_42',
    fid: '27',
    orderby: 'lastpost',
  }), {
    limit: 40,
    fid: '27',
    orderby: 'lastpost',
    cursor: '1700000000_42',
    params: {
      perpage: '40',
      orderby: 'lastpost',
      fid: '27',
      cursor: '1700000000_42',
    },
  })
})

test('uses safe defaults and ignores fid zero', () => {
  assert.deepEqual(buildNBWTimelineParams({ cursor: 'next' }), {
    limit: 20,
    fid: '',
    orderby: 'dateline',
    cursor: 'next',
    params: { perpage: '20', orderby: 'dateline', cursor: 'next' },
  })
})

test('keeps the legacy perpage parameter compatible', () => {
  assert.equal(buildNBWTimelineParams({ perpage: '30' }).limit, 30)
  assert.equal(buildNBWTimelineParams({ limit: '10', perpage: '30' }).limit, 10)
})

test('builds a Mastodon next link from the NBW cursor', () => {
  assert.equal(
    buildNBWTimelineNextLink('/api/v1/timelines/nbw', 'next_cursor', 20, '27', 'lastpost'),
    '</api/v1/timelines/nbw?limit=20&max_id=next_cursor&fid=27&orderby=lastpost>; rel="next"',
  )
  assert.equal(buildNBWTimelineNextLink('/api/v1/timelines/nbw', '', 20, '', 'dateline'), null)
})

test('stops merged timeline pagination when NBW cursor cannot advance', () => {
  assert.equal(hasNextAllTimelinePage(0, 20, '', true, ''), false)
  assert.equal(hasNextAllTimelinePage(0, 20, 'cursor_1', true, 'cursor_1'), false)
  assert.equal(hasNextAllTimelinePage(0, 20, 'cursor_1', true, 'cursor_2'), true)
  assert.equal(hasNextAllTimelinePage(20, 20, 'cursor_1', false, ''), true)
})

test('NBW adapter preserves valid envelopes and limits timeline reads to the fixed HTTPS endpoint without redirects', async t => {
  const calls: { url: URL; options?: RequestInit }[] = []
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
    calls.push({ url: new URL(String(input)), options })
    return Response.json({ code: 200, msg: 'ok', data: { list: [], has_more: false } })
  })
  const env = { NBW_API_KEY: 'fixture-api-key' } as never as Env
  assert.deepEqual(await nbwS2SRequest(env, 'get_sync_threads', { cursor: 'opaque/?http://127.0.0.1' }, { timeoutMs: 5000, maxBytes: 1024 }),
    { code: 200, msg: 'ok', data: { list: [], has_more: false } })
  assert.equal(calls[0].url.origin, new URL(NBW_BASE_URL).origin)
  assert.equal(calls[0].url.pathname, '/api/abdl-space/api.php')
  assert.equal(calls[0].url.searchParams.get('cursor'), 'opaque/?http://127.0.0.1')
  assert.equal(calls[0].options?.redirect, 'manual')
  assert.equal(new Headers(calls[0].options?.headers).get('X-ABDL-API-Key'), 'fixture-api-key')
  assert.ok(calls[0].options?.signal)
  await nbwS2SRequest(env, 'create_thread', { subject: 'ordinary action' })
  assert.equal(calls[1].options?.signal, undefined, 'other S2S actions do not get a new 5s deadline')
})

test('NBW adapter maps gateway/text/malformed/redirect/network failures to safe typed errors', async t => {
  const env = { NBW_API_KEY: 'fixture-api-key' } as never as Env
  const cases = [
    { reason: 'http', status: 526, fetch: async () => new Response('error code: 526\nprivate-upstream-body', { status: 526 }) },
    { reason: 'invalid_json', status: 200, fetch: async () => new Response('<html>private-upstream-body</html>') },
    { reason: 'invalid_response', status: 200, fetch: async () => Response.json({ code: '200', data: [] }) },
    { reason: 'invalid_response', status: 200, fetch: async () => Response.json([]) },
    { reason: 'http', status: 302, fetch: async () => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/internal' } }) },
    { reason: 'network', status: null, fetch: async () => { throw new Error('private-network-body-key') } },
  ]
  for (const row of cases) {
    t.mock.method(globalThis, 'fetch', row.fetch)
    await assert.rejects(nbwS2SRequest(env, 'get_sync_threads', {}, { timeoutMs: 5000, maxBytes: 1024 }), error => {
      assert.ok(error instanceof NBWUnavailableError)
      assert.equal(error.reason, row.reason)
      assert.equal(error.upstreamStatus, row.status)
      assert.equal(String(error), 'NBWUnavailableError: NBW service unavailable')
      return true
    })
  }
})

test('NBW timeline JSON cap cancels declared and streamed oversized bodies', async t => {
  const env = { NBW_API_KEY: 'fixture-api-key' } as never as Env
  for (const declared of [false, true]) {
    let canceled = false
    t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(2048))) },
      cancel() { canceled = true },
    }), { headers: declared ? { 'Content-Length': '2048' } : {} }))
    await assert.rejects(nbwS2SRequest(env, 'get_sync_threads', {}, { timeoutMs: 5000, maxBytes: 1024 }),
      error => error instanceof NBWUnavailableError && error.reason === 'response_limit')
    assert.equal(canceled, true)
  }
})

test('NBW deadline covers both stalled fetch and stalled body read, aborting pending requests', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const env = { NBW_API_KEY: 'fixture-api-key' } as never as Env
  for (const bodyStall of [false, true]) {
    let signal: AbortSignal | undefined
    t.mock.method(globalThis, 'fetch', async (_input: Parameters<typeof fetch>[0], options?: RequestInit) => {
      signal = options?.signal ?? undefined
      if (bodyStall) return new Response(new ReadableStream({
        start(controller) { signal?.addEventListener('abort', () => controller.error(new Error('private-stream-timeout'))) },
      }))
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('private-fetch-timeout')))
      })
    })
    const result = nbwS2SRequest(env, 'get_sync_threads', {}, { timeoutMs: 5000, maxBytes: 1024 })
    const check = assert.rejects(result, error => error instanceof NBWUnavailableError && error.reason === 'timeout')
    await Promise.resolve()
    await Promise.resolve()
    t.mock.timers.tick(5000)
    await check
    assert.equal(signal?.aborted, true)
  }
})

test('NBW timeline shape validation rejects rows that would poison native parsing', () => {
  for (const value of [null, {}, { list: {} }, { list: [null] }, { list: [{ tid: 1, subject: {} }] },
    { list: [{ tid: 1, image_list: [null] }] }, { list: [{ tid: 1, image_list: [{ url: {} }] }] },
    { list: [], has_more: 'yes' }, { list: [], next_cursor: {} }]) {
    assert.throws(() => parseNBWSyncData(value), error => error instanceof NBWUnavailableError && error.reason === 'invalid_response')
  }
  assert.deepEqual(parseNBWSyncData({ list: [{ tid: 1, subject: 'ok', image_list: ['https://example.test/a.jpg'] }] }).list.length, 1)
})

test('actual native dedicated NBW and compatibility alias return stable502 for unavailable/malformed sources, preserving business401/403', async t => {
  const env = { NBW_API_KEY: 'fixture-api-key', abdl_space_db: { prepare: () => ({
    bind() { return this },
    async all() { return { success: true, results: [] } },
  }) } } as never as Env
  const app = new Hono()
  app.route('/api/v1', mastodon)
  app.route('/api/v1/abdl', abdl)
  const warnings: string[] = []
  t.mock.method(console, 'warn', (value: unknown) => { warnings.push(String(value)) })
  const headers = { 'User-Agent': 'MastodonAndroid/3.0.1', 'X-App-Version-Code': '32' }
  for (const makeResponse of [
    () => new Response('error code: 526\nprivate-upstream-body', { status: 526 }),
    () => new Response('<html>private-upstream-body</html>'),
    () => Response.json({ code: 200, data: { list: {} } }),
  ]) {
    t.mock.method(globalThis, 'fetch', async () => makeResponse())
    for (const path of ['/api/v1/timelines/nbw?limit=40', '/api/v1/abdl/nbw/sync-threads?perpage=20']) {
      const response = await app.request(path, { headers }, env)
      assert.equal(response.status, 502)
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
      assert.deepEqual(await response.json(), { error: 'NBW 服务暂时不可用', code: 'nbw_unavailable' })
    }
  }
  for (const code of [401, 403]) {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ code, msg: 'business denied', data: null }, { status: code }))
    const response = await app.request('/api/v1/timelines/nbw?limit=20', { headers }, env)
    assert.equal(response.status, code)
    assert.deepEqual(await response.json(), { error: 'business denied', code })
  }
  assert.equal(warnings.join('').includes('private-upstream-body'), false)
  assert.equal(warnings.join('').includes('fixture-api-key'), false)
  assert.equal(warnings.filter(value => JSON.parse(value).event === 'nbw_timeline_unavailable').length, 6)
})
