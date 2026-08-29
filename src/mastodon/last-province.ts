import { query } from '../lib/db.ts'

/**
 * Batch-fetch each user's latest-post province (the geo_province of their
 * most recent post that has one). Returns Map<userId, province|null>.
 *
 * Uses MAX(id) as the "latest" proxy (id is AUTOINCREMENT primary key),
 * avoiding timestamp-tie ambiguity. Users with no post carrying a
 * province map to null.
 */
export async function getLastStatusProvinces(
  db: D1Database,
  userIds: number[]
): Promise<Map<number, string | null>> {
  const result = new Map<number, string | null>()
  if (userIds.length === 0) return result
  const placeholders = userIds.map(() => '?').join(',')
  const rows = await query<{ user_id: number; geo_province: string | null }>(
    db,
    `SELECT p.user_id AS user_id, p.geo_province AS geo_province
     FROM posts p
     WHERE p.id IN (
       SELECT MAX(id) FROM posts
       WHERE user_id IN (${placeholders}) AND geo_province IS NOT NULL
       GROUP BY user_id
     )`,
    userIds
  )
  for (const r of rows) result.set(r.user_id, r.geo_province)
  for (const id of userIds) if (!result.has(id)) result.set(id, null)
  return result
}
