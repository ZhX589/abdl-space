import assert from 'node:assert/strict'
import test from 'node:test'

import broadcast from './broadcast.ts'
import { cacheClear } from '../lib/ttl-cache.ts'

/** 内存版 KVNamespace 模拟（仅实现本路由用到的 get/put/delete） */
class MockKV {
  private map = new Map<string, string>()

  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null
  }

  async put(key: string, value: string): Promise<void> {
    this.map.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key)
  }
}

const BROADCAST_KEY = 'test-broadcast-key'

function makeEnv(overrides: { kv?: boolean } = {}) {
  return {
    BROADCAST_KEY,
    JPUSH_APP_KEY: undefined,
    JPUSH_MASTER_SECRET: undefined,
    NOTICE_KV: overrides.kv === false ? undefined : (new MockKV() as unknown as KVNamespace),
  }
}

test('GET /notice: 未发布公告时返回 { notice: null }', async () => {
  cacheClear()
  const res = await broadcast.request('/notice', {}, makeEnv())
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.deepEqual(data, { notice: null })
})

test('GET /notice: NOTICE_KV 未绑定时同样返回 { notice: null }（不报错）', async () => {
  cacheClear()
  const res = await broadcast.request('/notice', {}, makeEnv({ kv: false }))
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.deepEqual(data, { notice: null })
})

test('POST /notice: 密钥错误返回 401', async () => {
  cacheClear()
  const res = await broadcast.request('/notice', {
    method: 'POST',
    headers: { 'X-Broadcast-Key': 'wrong-key' },
  }, makeEnv())
  assert.equal(res.status, 401)
})

test('POST /notice: 发布 + GET 生效窗口内返回公告', async () => {
  cacheClear()
  const env = makeEnv()
  const now = Math.floor(Date.now() / 1000)
  const pub = await broadcast.request('/notice', {
    method: 'POST',
    headers: { 'X-Broadcast-Key': BROADCAST_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '服务维护', content: 'TODAY', startAt: now - 10, endAt: now + 3600, push: false }),
  }, env)
  assert.equal(pub.status, 200)
  const pubData = await pub.json()
  assert.equal(pubData.success, true)
  assert.equal(pubData.pushed, false)
  assert.equal(pubData.notice.content, 'TODAY')
  assert.ok(pubData.notice.id)

  const res = await broadcast.request('/notice', {}, env)
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.equal(data.notice.title, '服务维护')
  assert.equal(data.notice.content, 'TODAY')
})

test('GET /notice: startAt 在未来（未生效）时返回 { notice: null }', async () => {
  cacheClear()
  const env = makeEnv()
  const now = Math.floor(Date.now() / 1000)
  await broadcast.request('/notice', {
    method: 'POST',
    headers: { 'X-Broadcast-Key': BROADCAST_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '未来公告', content: 'later', startAt: now + 3600, push: false }),
  }, env)
  const res = await broadcast.request('/notice', {}, env)
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.deepEqual(data, { notice: null })
})

test('POST /notice/clear: 撤销后 GET 返回 { notice: null }', async () => {
  cacheClear()
  const env = makeEnv()
  const now = Math.floor(Date.now() / 1000)
  await broadcast.request('/notice', {
    method: 'POST',
    headers: { 'X-Broadcast-Key': BROADCAST_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'x', content: 'y', startAt: now - 10, push: false }),
  }, env)
  const clear = await broadcast.request('/notice/clear', {
    method: 'POST',
    headers: { 'X-Broadcast-Key': BROADCAST_KEY },
  }, env)
  assert.equal(clear.status, 200)
  const res = await broadcast.request('/notice', {}, env)
  const data = await res.json()
  assert.deepEqual(data, { notice: null })
})

test('POST /notice: endAt 早于 startAt 返回 400', async () => {
  cacheClear()
  const now = Math.floor(Date.now() / 1000)
  const res = await broadcast.request('/notice', {
    method: 'POST',
    headers: { 'X-Broadcast-Key': BROADCAST_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'x', content: 'y', startAt: now + 100, endAt: now, push: false }),
  }, makeEnv())
  assert.equal(res.status, 400)
})

test('POST /notice: content 为空返回 400', async () => {
  cacheClear()
  const res = await broadcast.request('/notice', {
    method: 'POST',
    headers: { 'X-Broadcast-Key': BROADCAST_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'x', content: '', push: false }),
  }, makeEnv())
  assert.equal(res.status, 400)
})