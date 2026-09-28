import test from 'node:test'
import assert from 'node:assert/strict'
import { signJWT } from '../lib/auth.ts'
import { assertSessionNotStale, authMiddleware } from './auth.ts'

function mockDb(rows: Array<Record<string, unknown> | null>, options: { legacy?: boolean } = {}) {
  const sqlLog: string[] = []
  const db = {
    prepare(sql: string) {
      sqlLog.push(sql)
      const all = async () => {
        if (options.legacy && sql.includes('auth_invalid_before')) {
          throw new Error('no such column: auth_invalid_before')
        }
        return { success: true, results: [rows.shift()].filter(Boolean) }
      }
      return { all, bind() { return { all } } }
    },
  }
  return { db, sqlLog }
}

test('authMiddleware installs a valid current user payload with one merged users query', async () => {
  const secret = 'test-secret'
  const token = await signJWT({
    sub: 1,
    username: 'alice',
    email: 'alice@example.com',
    role: 'user',
  }, secret)
  let installedUser: unknown = null
  let nextCalled = false
  const { db, sqlLog } = mockDb([
    { role: 'user', password_changed_at: null, auth_invalid_before: null },
  ])
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
  assert.equal(sqlLog.length, 1)
  assert.match(sqlLog[0], /role, password_changed_at, auth_invalid_before/)
})

test('assertSessionNotStale rejects a token issued in the password-change second', async () => {
  const issuedAt = 1_786_111_234
  const { db } = mockDb([
    { password_changed_at: new Date(issuedAt * 1000).toISOString(), auth_invalid_before: null },
  ])

  const error = await assertSessionNotStale({ sub: 1, username: 'alice', email: 'alice@example.com', role: 'user', iat: issuedAt, exp: issuedAt + 300 }, db as never)
  assert.equal(error, 'Session expired, please login again')
})

test('assertSessionNotStale rejects auth-invalidated JWTs and supports legacy databases', async () => {
  const issuedAt = 1_786_111_234
  const { db: currentDb } = mockDb([
    { password_changed_at: null, auth_invalid_before: issuedAt },
  ])
  const payload = { sub: 1, username: 'alice', email: 'alice@example.com', role: 'user', iat: issuedAt, exp: issuedAt + 300 }
  assert.equal(await assertSessionNotStale(payload, currentDb as never), 'Session expired, please login again')

  const { db: legacyDb, sqlLog } = mockDb([{ password_changed_at: null }], { legacy: true })
  assert.equal(await assertSessionNotStale(payload, legacyDb as never), null)
  assert.equal(sqlLog.length, 2, 'legacy database retries once without auth_invalid_before')
  assert.match(sqlLog[0], /auth_invalid_before/)
  assert.doesNotMatch(sqlLog[1], /auth_invalid_before/)
})
