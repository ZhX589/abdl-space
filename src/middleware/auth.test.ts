import test from 'node:test'
import assert from 'node:assert/strict'
import { signJWT } from '../lib/auth.ts'
import { assertSessionNotStale, authMiddleware } from './auth.ts'

test('authMiddleware installs a valid current user payload', async () => {
  const secret = 'test-secret'
  const token = await signJWT({
    sub: 1,
    username: 'alice',
    email: 'alice@example.com',
    role: 'user',
  }, secret)
  let installedUser: unknown = null
  let nextCalled = false
  const rows = [
    { name: 'auth_invalid_before' },
    { password_changed_at: null, auth_invalid_before: null },
    { role: 'user' },
  ]
  const db = {
    prepare() {
      const all = async () => ({ success: true, results: [rows.shift()].filter(Boolean) })
      return { all, bind() { return { all } } }
    },
  }
  const context = {
    req: { header: (name: string) => name === 'Authorization' ? `Bearer ${token}` : undefined },
    env: { JWT_SECRET: secret, abdl_space_db: db },
    set: (_key: string, value: unknown) => { installedUser = value },
    json: (body: unknown, status: number) => new Response(JSON.stringify(body), { status }),
  }

  await authMiddleware(context as never, async () => { nextCalled = true })

  assert.equal(nextCalled, true)
  assert.equal((installedUser as { sub: number }).sub, 1)
  assert.equal((installedUser as { role: string }).role, 'user')
})

test('assertSessionNotStale rejects a token issued in the password-change second', async () => {
  const issuedAt = 1_786_111_234
  const rows = [
    { name: 'auth_invalid_before' },
    { password_changed_at: new Date(issuedAt * 1000).toISOString(), auth_invalid_before: null },
  ]
  const db = {
    prepare() {
      const all = async () => ({ success: true, results: [rows.shift()].filter(Boolean) })
      return { all, bind() { return { all } } }
    },
  }

  const error = await assertSessionNotStale({ sub: 1, username: 'alice', email: 'alice@example.com', role: 'user', iat: issuedAt, exp: issuedAt + 300 }, db as never)
  assert.equal(error, 'Session expired, please login again')
})

test('assertSessionNotStale rejects auth-invalidated JWTs and supports legacy databases', async () => {
  const issuedAt = 1_786_111_234
  const currentRows = [
    { name: 'auth_invalid_before' },
    { password_changed_at: null, auth_invalid_before: issuedAt },
  ]
  const currentDb = {
    prepare() { const all = async () => ({ success: true, results: [currentRows.shift()].filter(Boolean) }); return { all, bind() { return { all } } } },
  }
  const payload = { sub: 1, username: 'alice', email: 'alice@example.com', role: 'user', iat: issuedAt, exp: issuedAt + 300 }
  assert.equal(await assertSessionNotStale(payload, currentDb as never), 'Session expired, please login again')

  const legacyRows = [null, { password_changed_at: null }]
  const legacyDb = {
    prepare() { const all = async () => ({ success: true, results: [legacyRows.shift()].filter(Boolean) }); return { all, bind() { return { all } } } },
  }
  assert.equal(await assertSessionNotStale(payload, legacyDb as never), null)
})
