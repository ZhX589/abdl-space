import test from 'node:test'
import assert from 'node:assert/strict'
import { signJWT } from '../lib/auth.ts'
import { ipSecurityMiddleware } from './ip-security.ts'
import { cacheClear } from '../lib/ttl-cache.ts'

function mockDb(results: Record<string, unknown>[][]) {
  let prepareCount = 0
  const db = {
    prepare() {
      prepareCount++
      const all = async () => ({ success: true, results: results.shift() ?? [] })
      const run = async () => ({ success: true, meta: {} })
      return { all, run, bind() { return { all, run } } }
    },
  }
  return { db, count: () => prepareCount }
}

function makeContext(db: unknown, headers: Record<string, string>) {
  return {
    req: { header: (name: string) => headers[name] },
    env: { abdl_space_db: db, JWT_SECRET: 'test-secret' },
    json: (body: unknown, status?: number) => new Response(JSON.stringify(body), { status: status ?? 200 }),
    set: () => {},
    get: () => undefined,
  } as never
}

const next = async () => 'nexted'

test('unbanned IP lookup is cached within the isolate', async () => {
  cacheClear()
  const { db, count } = mockDb([[]])
  const headers = { 'CF-Connecting-IP': '203.0.113.10' }

  const first = await ipSecurityMiddleware(makeContext(db, headers), next)
  assert.equal(first, 'nexted')
  assert.equal(count(), 1)

  const second = await ipSecurityMiddleware(makeContext(db, headers), next)
  assert.equal(second, 'nexted')
  assert.equal(count(), 1, 'second request must hit the in-memory cache instead of D1')
})

test('banned IP is served 403 from cache without touching D1 again', async () => {
  cacheClear()
  const { db, count } = mockDb([[{ ip: '203.0.113.11' }]])
  const headers = { 'CF-Connecting-IP': '203.0.113.11' }

  const first = await ipSecurityMiddleware(makeContext(db, headers), next)
  assert.equal(first instanceof Response, true)
  assert.equal((first as Response).status, 403)

  const second = await ipSecurityMiddleware(makeContext(db, headers), next)
  assert.equal((second as Response).status, 403)
  assert.equal(count(), 1)
})

test('tracking rule lookup is cached per user', async () => {
  cacheClear()
  const token = await signJWT({ sub: 7, username: 'bob', email: 'bob@example.com', role: 'user' }, 'test-secret')
  const { db, count } = mockDb([[], []])
  const headers = { 'CF-Connecting-IP': '203.0.113.12', Authorization: `Bearer ${token}` }

  const first = await ipSecurityMiddleware(makeContext(db, headers), next)
  assert.equal(first, 'nexted')
  assert.equal(count(), 2, 'first request: ban lookup + tracking rule lookup')

  const second = await ipSecurityMiddleware(makeContext(db, headers), next)
  assert.equal(second, 'nexted')
  assert.equal(count(), 2, 'second request: both lookups served from cache')
})

test('automatic ban replaces an earlier negative cache entry immediately', async () => {
  cacheClear()
  const token = await signJWT({ sub: 9, username: 'tracked', email: 'tracked@example.com', role: 'user' }, 'test-secret')
  const ip = '203.0.113.13'
  const { db, count } = mockDb([[], [{ user_id: 9 }]])

  const trackedResponse = await ipSecurityMiddleware(
    makeContext(db, { 'CF-Connecting-IP': ip, Authorization: `Bearer ${token}` }),
    next,
  )
  assert.equal((trackedResponse as Response).status, 403)
  assert.equal(count(), 4, 'ban lookup + tracking lookup + event insert + ban insert')

  const anonymousResponse = await ipSecurityMiddleware(
    makeContext(db, { 'CF-Connecting-IP': ip }),
    next,
  )
  assert.equal((anonymousResponse as Response).status, 403)
  assert.equal(count(), 4, 'anonymous retry is blocked from the positive cache without D1')
})
