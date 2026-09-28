import type { Env } from '../types/index.ts'
import { cacheDelete, cacheGet, cacheSet } from './ttl-cache.ts'
import { kvCacheGet, kvCacheInvalidate, kvCacheSet } from './kv-cache.ts'

export const FEED_COUNT_CACHE_KEY = 'feed:top:total'
const FEED_COUNT_KV_BYPASS_KEY = 'feed:top:total:kv-bypass'
const FEED_COUNT_MEM_TTL_MS = 60_000
const FEED_COUNT_KV_BYPASS_TTL_MS = 60_000
const FEED_COUNT_KV_TTL_SEC = 900

export function getFeedCountFromMemory(): number | undefined {
  return cacheGet<number>(FEED_COUNT_CACHE_KEY)
}

export function cacheFeedCountInMemory(total: number): void {
  cacheSet(FEED_COUNT_CACHE_KEY, total, FEED_COUNT_MEM_TTL_MS)
}

export async function getFeedCountFromKv(env: Env): Promise<number | null> {
  if (cacheGet<boolean>(FEED_COUNT_KV_BYPASS_KEY)) return null
  return kvCacheGet<number>(env.NOTICE_KV, FEED_COUNT_CACHE_KEY)
}

export async function cacheFeedCount(env: Env, total: number): Promise<void> {
  cacheFeedCountInMemory(total)
  // 不提前清 bypass：KV 写失败被封装为静默降级时，仍要等最终一致窗口过去。
  await kvCacheSet(env.NOTICE_KV, FEED_COUNT_CACHE_KEY, total, FEED_COUNT_KV_TTL_SEC)
}

export async function invalidateFeedCount(env: Env): Promise<void> {
  cacheDelete(FEED_COUNT_CACHE_KEY)
  // KV delete 是最终一致；短期绕过旧副本，确保下一次请求从 D1 重算并回填新值。
  cacheSet(FEED_COUNT_KV_BYPASS_KEY, true, FEED_COUNT_KV_BYPASS_TTL_MS)
  await kvCacheInvalidate(env.NOTICE_KV, FEED_COUNT_CACHE_KEY)
}
