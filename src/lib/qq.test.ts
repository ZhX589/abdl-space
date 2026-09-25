import assert from 'node:assert/strict'
import test from 'node:test'
import { assertSafeQQUrl, isForbiddenQQHostname, QQAuthError, verifyQQAndroidCode } from './qq.ts'

const appId = '1905661071'
const appKey = 'test-app-key'
const hmacKey = 'test-hmac-key'
const originalFetch = globalThis.fetch

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

test.afterEach(() => {
  globalThis.fetch = originalFetch
})

test('requires unionid and never returns raw QQ identifiers', async () => {
  const requests: URL[] = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    requests.push(url)
    assert.equal(init?.redirect, 'manual')
    if (url.pathname === '/oauth2.0/token') {
      assert.equal(init?.method, 'POST')
      const body = new URLSearchParams(String(init?.body))
      assert.equal(body.get('grant_type'), 'authorization_code')
      assert.equal(body.get('redirect_uri'), 'auth://tauth.qq.com/')
      assert.equal(body.get('fmt'), 'json')
      assert.equal(body.get('need_openid'), '1')
      return jsonResponse({ access_token: 'access-secret', client_id: appId, openid: 'raw-openid' })
    }
    return jsonResponse({ client_id: appId, openid: 'raw-openid' })
  }

  await assert.rejects(
    verifyQQAndroidCode('authorization-secret', appId, appId, appKey, hmacKey),
    (error: unknown) => error instanceof QQAuthError && error.code === 'QQ_UNIONID_REQUIRED'
  )
  assert.equal(requests.length, 2)
})

test('rejects client_id mismatch from caller or QQ identity response', async () => {
  await assert.rejects(
    verifyQQAndroidCode('code', 'wrong-app', appId, appKey, hmacKey),
    (error: unknown) => error instanceof QQAuthError && error.code === 'QQ_REQUEST_INVALID'
  )

  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname === '/oauth2.0/token') {
      return jsonResponse({ access_token: 'access-secret', client_id: appId, openid: 'openid' })
    }
    return jsonResponse({ client_id: 'other-app', openid: 'openid', unionid: 'unionid' })
  }
  await assert.rejects(
    verifyQQAndroidCode('code', appId, appId, appKey, hmacKey),
    (error: unknown) => error instanceof QQAuthError && error.code === 'QQ_CREDENTIAL_INVALID'
  )
})

test('returns versioned client-bound HMAC identities and normalized profile', async () => {
  const seenUrls: URL[] = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    seenUrls.push(url)
    assert.equal(url.hostname, 'graph.qq.com')
    assert.equal(init?.redirect, 'manual')
    if (url.pathname === '/oauth2.0/token') {
      return jsonResponse({ access_token: 'access-secret', client_id: appId, openid: 'raw-openid' })
    }
    if (url.pathname === '/oauth2.0/me') {
      return jsonResponse({ client_id: appId, openid: 'raw-openid', unionid: 'raw-unionid' })
    }
    return jsonResponse({ ret: 0, nickname: `${'😀'.repeat(105)}tail`, figureurl_qq_2: 'http://q.qlogo.cn/avatar' })
  }

  const result = await verifyQQAndroidCode('authorization-secret', appId, appId, appKey, hmacKey)
  assert.match(result.unionidHmac, /^[a-f0-9]{64}$/)
  assert.match(result.openidHmac, /^[a-f0-9]{64}$/)
  assert.equal(Array.from(result.nickname).length, 100)
  assert.equal(result.avatar, '')

  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(hmacKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const expectedHex = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))))
    .map(byte => byte.toString(16).padStart(2, '0')).join('')
  assert.equal(result.unionidHmac, await expectedHex(`qq:unionid:v1\0${appId}\0raw-unionid`))
  assert.equal(result.openidHmac, await expectedHex(`qq:openid:v1\0${appId}\0raw-openid`))

  const otherClient = await expectedHex('qq:openid:v1\0other-client\0raw-openid')
  assert.notEqual(result.openidHmac, otherClient)
  assert.equal(seenUrls.length, 3)
})

test('allows only fixed HTTPS graph.qq.com and rejects local, private, loopback, and reserved hosts', () => {
  assert.doesNotThrow(() => assertSafeQQUrl(new URL('https://graph.qq.com/oauth2.0/me')))
  for (const value of [
    'http://graph.qq.com/oauth2.0/me',
    'https://graph.qq.com:8443/oauth2.0/me',
    'https://graph.qq.com@example.test/oauth2.0/me',
    'https://localhost/oauth2.0/me',
    'https://127.0.0.1/oauth2.0/me',
    'https://10.0.0.1/oauth2.0/me',
    'https://172.16.0.1/oauth2.0/me',
    'https://192.168.0.1/oauth2.0/me',
    'https://169.254.1.1/oauth2.0/me',
    'https://192.0.2.1/oauth2.0/me',
    'https://[::1]/oauth2.0/me',
    'https://example.test/oauth2.0/me',
  ]) {
    assert.throws(() => assertSafeQQUrl(new URL(value)), (error: unknown) => error instanceof QQAuthError && error.code === 'QQ_REQUEST_INVALID')
  }
  for (const host of ['localhost', '127.0.0.1', '10.0.0.1', '172.31.0.1', '192.168.0.1', '169.254.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '::1', 'fc00::1', '2001:db8::1']) {
    assert.equal(isForbiddenQQHostname(host), true, host)
  }
})

test('rejects redirects and oversized upstream responses', async () => {
  globalThis.fetch = async () => new Response('', { status: 302, headers: { Location: 'https://example.test/' } })
  await assert.rejects(
    verifyQQAndroidCode('code', appId, appId, appKey, hmacKey),
    (error: unknown) => error instanceof QQAuthError && error.code === 'QQ_UPSTREAM_UNAVAILABLE'
  )

  globalThis.fetch = async () => new Response(`{"access_token":"${'x'.repeat(40_000)}"}`, { status: 200 })
  await assert.rejects(
    verifyQQAndroidCode('code', appId, appId, appKey, hmacKey),
    (error: unknown) => error instanceof QQAuthError && error.code === 'QQ_UPSTREAM_UNAVAILABLE'
  )
})
