/**
 * KV 缓存层 — 用 Cloudflare KV 作为 D1 的「公共数据」缓存层（保守型，免费层）。
 *
 * 定位：
 * - 仅缓存「完全公共、无用户/用户」的数据（instance / version / trends 骨架等），
 *   绝不允许缓存含 favourited/bookmarked 等 per-user 字段的最终响应。
 * - 读优先 KV：命中直接返回；KV 未命中（绑定未配置）或异常 → 空，调用方回 D1。
 * - 受限回填：从 D1 拉取后按需写回 KV；TTL 由调用方传入（建议 ≥15 分钟），
 *   以控制免费层 1 次写/天 配额（默认 key 单 key TTL 15 分钟 ≈ 96 次写/天）。
 *
 * 失败语义（保守型的关键保证）：
 * - 所有 KV 读写/失效都在 try/catch 内，KV 割由/异常时静默返回空值或忽略错误，
 *   主流程（D1 直查）不受影响 —— KV 满限或故障时自动降级原路径，服务不中断。
 */

const KV_PREFIX = 'd1kv:'

/** 读 KV 缓存；KV 未配置 / 未命中 / 异常一律返回 null（不抛错） */
export async function kvCacheGet<T>(kv: KVNamespace | undefined, key: string): Promise<T | null> {
  if (!kv) return null
  try {
    const raw = await kv.get(KV_PREFIX + key, 'json')
    if (raw === null) return null
    return raw as T
  } catch {
    return null
  }
}

/** 写 KV 缓存；失败静默忽略（下个请求回填），ttlSec 下限 1 秒 */
export async function kvCacheSet<T>(kv: KVNamespace | undefined, key: string, value: T, ttlSec: number): Promise<void> {
  if (!kv) return
  try {
    await kv.put(KV_PREFIX + key, JSON.stringify(value), { expirationTtl: Math.max(1, ttlSec) })
  } catch {
    // 忽略写失败：KV 写排除时下个请求再回填，不阻塞主流程
  }
}

/** 失效 KV 缓存（写路径 / 发布路径变更后调用）；失败静默 */
export async function kvCacheInvalidate(kv: KVNamespace | undefined, key: string): Promise<void> {
  if (!kv) return
  try {
    await kv.delete(KV_PREFIX + key)
  } catch {
    // 忽略
  }
}