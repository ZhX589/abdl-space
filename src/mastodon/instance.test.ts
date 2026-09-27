import assert from 'node:assert/strict'
import test from 'node:test'

import { cacheClear } from '../lib/ttl-cache.ts'
import { buildInstance } from './shared.ts'

const PRIVACY_URL = 'https://abdl-space.top/privacy'
const TERMS_URL = 'https://abdl-space.top/terms'

function database(results: Array<{ cnt: number }> | Error): D1Database {
  return {
    prepare() {
      return {
        async all() {
          if (results instanceof Error) throw results
          const value = results.shift()
          return { success: true, results: value ? [value] : [] }
        },
      }
    },
  } as unknown as D1Database
}

function assertPolicyUrls(instance: Awaited<ReturnType<typeof buildInstance>>): void {
  assert.equal(instance.configuration.urls.privacy_policy, PRIVACY_URL)
  assert.equal(instance.configuration.urls.terms_of_service, TERMS_URL)
}

test('buildInstance publishes canonical policy URLs', async () => {
  cacheClear()
  const instance = await buildInstance(database([{ cnt: 12 }, { cnt: 34 }]))
  assertPolicyUrls(instance)
  assert.equal(instance.stats.user_count, 12)
  assert.equal(instance.stats.status_count, 34)
})

test('buildInstance fallback preserves canonical policy URLs', async () => {
  cacheClear()
  const instance = await buildInstance(database(new Error('D1 unavailable')))
  assertPolicyUrls(instance)
  assert.equal(instance.stats.user_count, 0)
  assert.equal(instance.stats.status_count, 0)
})
