import type { D1Database } from '@cloudflare/workers-types'

/**
 * Compute composite avg_score per API.md §6 formula:
 * IF feeling_count > 0:
 *   avg_score = round(rating_avg × 0.9 + feeling_avg × 0.1, 1)
 * ELSE:
 *   avg_score = round(rating_avg, 1)
 */
/**
 * 贝叶斯平均 — 拉向全局均值，避免少量评分的极端偏差
 * @param R 该条目的平均分
 * @param v 该条目的评分数
 * @param m 最低评分数阈值（全局均值评分数）
 * @param C 全局平均分
 */
export function bayesianAverage(R: number, v: number, m: number, C: number): number {
  if (v === 0) return C
  return (v / (v + m)) * R + (m / (v + m)) * C
}

/**
 * 威尔逊区间下界 — 评分置信度的保守估计，用于排名
 * 将 1-10 分转为 0-1 比例计算后转回
 * @param p 平均分 / 10（比例）
 * @param n 评分数
 * @param z 置信度系数（1.96 = 95%）
 */
export function wilsonLower(p: number, n: number, z = 1.96): number {
  if (n === 0) return 0
  const denom = 1 + z * z / n
  const center = p + z * z / (2 * n)
  const spread = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)
  return (center - spread) / denom
}

/**
 * 组合评分修正：贝叶斯平均 + 威尔逊区间下界
 * 产出单一修正分数，同时用于显示和排名
 */
export function adjustedScore(
  rawScore: number, ratingCount: number,
  globalM: number, globalC: number
): number {
  const bayesian = bayesianAverage(rawScore, ratingCount, globalM, globalC)
  const wilson = wilsonLower(bayesian / 10, Math.max(ratingCount, 1)) * 10
  return Math.round(wilson * 100) / 100
}

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