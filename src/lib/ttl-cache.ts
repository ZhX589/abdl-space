/**
 * 进程内 TTL 缓存（单 Worker 实例生效）。
 *
 * 用途：对高频只读查询（鉴权、实例统计、版本信息、未读数、热门时间线等）
 * 做秒级去重，降低 D1 读取配额消耗。
 *
 * 注意：
 * - 缓存只限当前隔离实例内有效；多实例部署时各实例各自缓存，TTL 内
 *   数据一致性已可接受（都用于短时统计/只读场景）。
 * - 只缓存 幂等、允许短暂过期 的数据；禁止缓存写路径结果。
 * - 淘汰策略：超过 MAX_ENTRIES 时按写入顺序（Map 插入序）淘汰最旧项，
 *   避免 per-token/per-user key 无限增长导致内存泄漏。
 */

const MAX_ENTRIES = 4096

interface CacheEntry {
  value: unknown
  expiresAt: number // epoch millis
}

const store = new Map<string, CacheEntry>()

/** 读取缓存；命中且未过期返回 value，否则返回 undefined */
export function cacheGet<T>(key: string): T | undefined {
  const entry = store.get(key)
  if (!entry) return undefined
  if (Date.now() >= entry.expiresAt) {
    store.delete(key)
    return undefined
  }
  return entry.value as T
}

/** 写入缓存，ttlMs 为存活毫秒数 */
export function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  if (store.has(key)) {
    store.delete(key) // 重新插入以延长淘汰顺序
  }
  store.set(key, { value, expiresAt: Date.now() + ttlMs })

  // 达到上限时淘汰最旧插入项（Map 保持插入顺序）
  if (store.size > MAX_ENTRIES) {
    const oldestKey = store.keys().next().value
    if (oldestKey !== undefined) {
      store.delete(oldestKey)
    }
  }
}

/** 删除缓存项（写路径/撤销路径需要立刻生效时调用） */
export function cacheDelete(key: string): void {
  store.delete(key)
}

/** 清空缓存（测试用） */
export function cacheClear(): void {
  store.clear()
}