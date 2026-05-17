import type { D1Database } from '@cloudflare/workers-types'

/**
 * Compute composite avg_score per API.md §6 formula:
 * IF feeling_count > 0:
 *   avg_score = round(rating_avg × 0.9 + feeling_avg × 0.1, 1)
 * ELSE:
 *   avg_score = round(rating_avg, 1)
 */
export function computeAvgScore(ratingAvg: number, _ratingCount: number, feelingAvg: number | null, feelingCount: number): number {
  if (feelingCount > 0 && feelingAvg !== null) {
    return Math.round((ratingAvg * 0.9 + feelingAvg * 0.1) * 10) / 10
  }
  return Math.round(ratingAvg * 10) / 10
}

/**
 * 执行 D1 查询并返回结果行
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function query<T extends Record<string, any>>(
  db: D1Database,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const stmt = db.prepare(sql)
  const result = params.length > 0 ? await stmt.bind(...params).all() : await stmt.all()
  if (!result.success) {
    throw new Error('Database query failed')
  }
  return result.results as T[]
}

/**
 * 执行 D1 写操作（INSERT / UPDATE / DELETE）
 */
export async function run(
  db: D1Database,
  sql: string,
  params: unknown[] = []
): Promise<D1Result> {
  const stmt = db.prepare(sql)
  const result = params.length > 0 ? await stmt.bind(...params).run() : await stmt.run()
  if (!result.success) {
    throw new Error('Database operation failed')
  }
  return result
}

/**
 * 获取单行记录，未找到时返回 null
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function queryOne<T extends Record<string, any>>(
  db: D1Database,
  sql: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await query<T>(db, sql, params)
  return rows.length > 0 ? rows[0] : null
}