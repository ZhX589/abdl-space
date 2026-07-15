import test from 'node:test'
import assert from 'node:assert/strict'
import { isValidJWTPayload, signJWT, verifyJWT } from './auth.ts'

const secret = 'test-secret-long-enough-for-hmac'
const payload = { sub: 1, username: 'tester', email: 'test@example.com', role: 'user' }

test('accepts a valid signed JWT', async () => {
  const token = await signJWT(payload, secret)
  assert.equal((await verifyJWT(token, secret))?.sub, 1)
})

test('rejects a malformed or tampered JWT', async () => {
  assert.equal(await verifyJWT('not-a-token', secret), null)
  const token = await signJWT(payload, secret)
  assert.equal(await verifyJWT(`${token.slice(0, -1)}x`, secret), null)
})

test('rejects an expired JWT even with a valid signature', async () => {
  const originalNow = Date.now
  Date.now = () => 1_700_000_000_000
  try {
    const token = await signJWT(payload, secret)
    Date.now = () => 1_700_000_000_000 + 366 * 24 * 60 * 60 * 1000
    assert.equal(await verifyJWT(token, secret), null)
  } finally {
    Date.now = originalNow
  }
})

test('rejects payloads whose signed lifetime exceeds the limit', () => {
  assert.equal(isValidJWTPayload({
    ...payload,
    iat: 1_700_000_000,
    exp: 1_700_000_000 + 366 * 24 * 60 * 60,
  }), false)
})
