import type { Context, Next } from 'hono'

/**
 * 简单的内存限速器（适用于 Cloudflare Worker 单实例场景）
 * 基于 IP 的滑动窗口限速
 */

interface RateLimitEntry {
  count: number
  resetAt: number
}

const stores = new Map<string, Map<string, RateLimitEntry>>()

/**
 * 创建限速中间件
 * @param name - 限速器名称（隔离不同端点的计数）
 * @param windowMs - 时间窗口（毫秒）
 * @param maxRequests - 窗口内最大请求数
 * @param keyFn - 自定义 key 函数，默认用 IP
 */
export function rateLimit(
  name: string,
  windowMs: number,
  maxRequests: number,
  keyFn?: (c: Context) => string
) {
  if (!stores.has(name)) stores.set(name, new Map())
  const store = stores.get(name)!

  return async (c: Context, next: Next) => {
    const key = keyFn ? keyFn(c) : (
      c.req.header('CF-Connecting-IP')
      || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim()
      || 'unknown'
    )

    const now = Date.now()
    const entry = store.get(key)

    if (!entry || now > entry.resetAt) {
      store.set(key, { count: 1, resetAt: now + windowMs })
      c.header('X-RateLimit-Limit', String(maxRequests))
      c.header('X-RateLimit-Remaining', String(maxRequests - 1))
      await next()
      return
    }

    if (entry.count >= maxRequests) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000)
      c.header('Retry-After', String(retryAfter))
      c.header('X-RateLimit-Limit', String(maxRequests))
      c.header('X-RateLimit-Remaining', '0')
      return c.json({ error: 'Too many requests', retry_after: retryAfter }, 429)
    }

    entry.count++
    c.header('X-RateLimit-Limit', String(maxRequests))
    c.header('X-RateLimit-Remaining', String(maxRequests - entry.count))
    await next()
  }
}

/**
 * 清理过期条目（可定期调用）
 */
export function cleanupRateLimits() {
  const now = Date.now()
  for (const [, store] of stores) {
    for (const [key, entry] of store) {
      if (now > entry.resetAt) store.delete(key)
    }
  }
}
