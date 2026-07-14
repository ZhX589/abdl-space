import test from 'node:test'
import assert from 'node:assert/strict'
import { signJWT } from '../lib/auth.ts'
import { authMiddleware } from './auth.ts'

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
    { password_changed_at: null },
    { role: 'user' },
  ]
  const db = {
    prepare() {
      return {
        bind() {
          return { all: async () => ({ success: true, results: [rows.shift()].filter(Boolean) }) }
        },
      }
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
