import type { D1Database } from '@cloudflare/workers-types'

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