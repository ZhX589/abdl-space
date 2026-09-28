import test from 'node:test'
import assert from 'node:assert/strict'
import { cacheClear } from './ttl-cache.ts'
import { cacheFeedCount, getFeedCountFromKv, getFeedCountFromMemory, invalidateFeedCount } from './post-count-cache.ts'

function mockKv() {
  const data = new Map<string, string>()
  const deleted: string[] = []
  return {
    data,
    deleted,
    namespace: {
      async get(key: string, type?: string) {
        const value = data.get(key)
        if (value === undefined) return null
        return type === 'json' ? JSON.parse(value) : value
      },
      async put(key: string, value: string) { data.set(key, value) },
      async delete(key: string) { deleted.push(key); data.delete(key) },
    },
  }
}

test('invalidateFeedCount clears both isolate memory and KV', async () => {
  cacheClear()
  const kv = mockKv()
  const env = { NOTICE_KV: kv.namespace } as never

  await cacheFeedCount(env, 42)
  assert.equal(getFeedCountFromMemory(), 42)
  assert.equal(kv.data.get('d1kv:feed:top:total'), '42')

  await invalidateFeedCount(env)
  assert.equal(getFeedCountFromMemory(), undefined)
  assert.deepEqual(kv.deleted, ['d1kv:feed:top:total'])
  assert.equal(kv.data.has('d1kv:feed:top:total'), false)

  // 即使远端 KV 副本仍短暂返回旧值，当前 isolate 也必须绕过它并回 D1。
  kv.data.set('d1kv:feed:top:total', '42')
  assert.equal(await getFeedCountFromKv(env), null)

  await cacheFeedCount(env, 43)
  assert.equal(getFeedCountFromMemory(), 43)
  assert.equal(await getFeedCountFromKv(env), null, 'bypass remains active until KV consistency window expires')
})
