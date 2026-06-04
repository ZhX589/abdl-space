import type { D1Database } from '@cloudflare/workers-types'
import { queryOne } from './db.ts'

/* ============================================================
 * Risk Assessment — 请求风险评判
 *
 * 评判因素：
 * 1. IP 近期请求频率
 * 2. IP 是否有失败验证记录
 * 3. User-Agent 异常检测
 *
 * 返回: 'low' | 'high'
 * ============================================================ */

export type RiskLevel = 'low' | 'high'

interface RiskFactors {
  ipRequestCount: number     // 近 10 分钟请求数
  ipFailureCount: number     // 近 1 小时验证失败次数
  suspiciousUA: boolean      // User-Agent 是否可疑
}

/**
 * 评估请求风险等级
 */
export async function assessRisk(
  db: D1Database,
  ip: string,
  userAgent: string | undefined
): Promise<{ level: RiskLevel; factors: RiskFactors }> {
  const now = Math.floor(Date.now() / 1000)
  const tenMinAgo = now - 600
  const oneHourAgo = now - 3600

  // 并行查询
  const [requestCount, failureCount] = await Promise.all([
    // 近 10 分钟该 IP 的 challenge 请求数
    queryOne<{ cnt: number }>(
      db,
      'SELECT COUNT(*) as cnt FROM captcha_sessions WHERE ip = ? AND created_at > ?',
      [ip, tenMinAgo]
    ),
    // 近 1 小时该 IP 的验证失败次数
    queryOne<{ cnt: number }>(
      db,
      `SELECT COALESCE(SUM(attempts), 0) as cnt FROM captcha_sessions
       WHERE ip = ? AND created_at > ? AND used = 0 AND attempts > 0`,
      [ip, oneHourAgo]
    ),
  ])

  const factors: RiskFactors = {
    ipRequestCount: requestCount?.cnt || 0,
    ipFailureCount: failureCount?.cnt || 0,
    suspiciousUA: isSuspiciousUA(userAgent),
  }

  const level = calculateRiskLevel(factors)
  return { level, factors }
}

/**
 * 判定风险等级
 */
function calculateRiskLevel(factors: RiskFactors): RiskLevel {
  let score = 0

  // 10 分钟内请求超过 3 次 → +30
  if (factors.ipRequestCount > 3) score += 30
  // 10 分钟内请求超过 1 次 → +15
  else if (factors.ipRequestCount > 1) score += 15

  // 1 小时内失败超过 1 次 → +40
  if (factors.ipFailureCount > 1) score += 40
  // 有失败记录 → +25
  else if (factors.ipFailureCount > 0) score += 25

  // 可疑 User-Agent → +30
  if (factors.suspiciousUA) score += 30

  // 阈值: 25 分以上为高风险（严格模式）
  return score >= 25 ? 'high' : 'low'
}

/**
 * 检测可疑 User-Agent
 */
function isSuspiciousUA(ua: string | undefined): boolean {
  if (!ua) return true // 无 UA → 可疑

  const lower = ua.toLowerCase()

  // 已知爬虫/自动化工具
  const suspiciousPatterns = [
    'curl', 'wget', 'python-requests', 'httpclient', 'java/',
    'go-http-client', 'node-fetch', 'axios', 'phantom', 'selenium',
    'headless', 'puppeteer', 'playwright', 'scrapy',
    'bot', 'crawler', 'spider', 'http_', 'libwww', 'urllib',
    'okhttp', 'apache-httpclient', 'winhttp', 'coldfusion',
  ]

  if (suspiciousPatterns.some(p => lower.includes(p))) return true

  // UA 太短（< 50 字符）→ 可疑
  if (ua.length < 50) return true

  return false
}
