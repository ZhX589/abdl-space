import assert from 'node:assert/strict'
import test from 'node:test'

import { kvCacheGet, kvCacheSet, kvCacheInvalidate } from './kv-cache.ts'

/** 内存版 KVNamespace 模拟（仅实现本库用到的 get/put/delete） */
class MockKV {
  private map = new Map<string, string>()

  async get(key: string, type?: 'json'): Promise<unknown> {
    const raw = this.map.get(key)
    if (raw === undefined) return null
    if (type === 'json') {
      try {
        return JSON.parse(raw)
      } catch {
        return null
      }
    }
    return raw
  }

  async put(key: string, value: string): Promise<void> {
    this.map.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key)
  }
}

test('kvCacheGet: KV 未绑定返回 null（不抛错）', async () => {
  assert.equal(await kvCacheGet(undefined, 'any'), null)
})

test('kvCacheGet: 未命中返回 null', async () => {
  const kv = new MockKV() as unknown as KVNamespace
  assert.equal(await kvCacheGet(kv, 'missing'), null)
})

test('kvCacheSet + kvCacheGet: 写入后可读回', async () => {
  const kv = new MockKV() as unknown as KVNamespace
  await kvCacheSet(kv, 'user:1', { id: 1, name: '测试' }, 900)
  const got = await kvCacheGet<{ id: number; name: string }>(kv, 'user:1')
  assert.deepEqual(got, { id: 1, name: '测试' })
})

test('kvCacheInvalidate: 删除后读回 null', async () => {
  const kv = new MockKV() as unknown as KVNamespace
  await kvCacheSet(kv, 'k', { v: 1 }, 900)
  await kvCacheInvalidate(kv, 'k')
  assert.equal(await kvCacheGet(kv, 'k'), null)
})

test('kvCacheGet: 值被手工破坏（非 JSON）时按未命中处理', async () => {
  const kv = new MockKV() as unknown as KVNamespace
  await kvCacheSet(kv, 'bad', { v: 1 }, 900)
  // 模拟 KV 被外部写入非法 JSON
  await (kv as unknown as { map: Map<string, string> }).map.set('d1kv:bad', '{broken')
  assert.equal(await kvCacheGet(kv, 'bad'), null)
})

test('kvCacheSet: TTL 下限正常（不抛错）', async () => {
  const kv = new MockKV() as unknown as KVNamespace
  // 只验证不抛错（expirationTtl 参数在模拟中被忽略）
  await kvCacheSet(kv, 'ttl', { v: 1 }, 1)
  assert.ok(true)
})