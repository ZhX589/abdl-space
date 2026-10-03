import type { D1Database } from '@cloudflare/workers-types'
import type { AppClientPolicy, AppClientStats, AppClientUsers } from '../types/app-clients.ts'
import { query, queryOne, run } from './db.ts'

/** Reserved JSON document; generic settings must never write this key. */
export const APP_CLIENT_POLICY_KEY = 'app_client_policy'
/** Verified existing public download page; never supplied by an administrator or client. */
export const APP_DOWNLOAD_URL = 'https://abdl-space.top/app'
/** Safe kill-switch defaults, returned as a fresh object on each read. */
export function defaultAppClientPolicy(): AppClientPolicy {
  return { enabled: false, deprecated_version_codes: [], block_unversioned: false, update_message: '当前 App 版本已停止支持，请更新到最新版本后继续使用。' }
}

/** Only the complete native product UA is eligible; browser/header-only requests are excluded. */
export function isNativeAppClient(ua: string | undefined): boolean {
  return !!ua && /^MastodonAndroid\/[0-9]+\.[0-9]+\.[0-9]+(?:(?:-debug|-github)|-nightly\+@[A-Za-z0-9_-]+)?$/.test(ua)
}

/** Strict canonical positive Android int32; every missing/malformed value shares one null bucket. */
export function parseAppVersionCode(value: string | undefined): number | null {
  if (!value || !/^[1-9][0-9]{0,9}$/.test(value)) return null
  const parsed = Number(value)
  return parsed <= 2147483647 ? parsed : null
}

/** Validate the complete four-field policy; no coercion, duplicates or unknown fields. */
export function validateAppClientPolicy(input: unknown): AppClientPolicy | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const value = input as Record<string, unknown>
  if (Object.keys(value).length !== 4 || Object.keys(value).some(key => !['enabled', 'deprecated_version_codes', 'block_unversioned', 'update_message'].includes(key))) return null
  if (typeof value.enabled !== 'boolean' || typeof value.block_unversioned !== 'boolean' || typeof value.update_message !== 'string') return null
  const message = value.update_message.trim()
  if (!message || message.length > 2000 || !Array.isArray(value.deprecated_version_codes) || value.deprecated_version_codes.length > 200) return null
  const codes = value.deprecated_version_codes
  if (codes.some(code => typeof code !== 'number' || !Number.isInteger(code) || code <= 0 || code > 2147483647) || new Set(codes).size !== codes.length) return null
  return { enabled: value.enabled, deprecated_version_codes: codes as number[], block_unversioned: value.block_unversioned, update_message: message }
}

/** Read fresh policy without caching; corrupt/missing infrastructure always fails open. */
export async function readAppClientPolicy(db: D1Database): Promise<{ policy: AppClientPolicy; available: boolean }> {
  try {
    const epoch = await queryOne<{ measurement_started_at: string }>(db, 'SELECT measurement_started_at FROM app_client_measurement WHERE id = 1')
    const row = await queryOne<{ value: string }>(db, 'SELECT value FROM site_settings WHERE key = ?', [APP_CLIENT_POLICY_KEY])
    const policy = row ? validateAppClientPolicy(JSON.parse(row.value)) : null
    if (epoch && policy) return { policy, available: true }
    console.error(JSON.stringify({ event: 'app_client_policy_unavailable', reason: 'missing_epoch_or_invalid_policy' }))
    return { policy: defaultAppClientPolicy(), available: false }
  } catch (error) {
    console.error(JSON.stringify({ event: 'app_client_policy_unavailable', error: String(error) }))
    return { policy: defaultAppClientPolicy(), available: false }
  }
}

/** Atomic validated setting write; missing migration is an explicit error, not an implicit rollout. */
export async function writeAppClientPolicy(db: D1Database, policy: AppClientPolicy): Promise<void> {
  const epoch = await queryOne<{ id: number }>(db, 'SELECT id FROM app_client_measurement WHERE id = 1')
  if (!epoch) throw new Error('App client measurement unavailable')
  await run(db, `INSERT INTO site_settings(key,value,updated_at) VALUES(?,?,datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, [APP_CLIENT_POLICY_KEY, JSON.stringify(policy)])
}

/** Await a D1 transaction: one bounded row per account/version, plus one last-observed row per account.
 * Equal timestamps use transaction order; downgrades are intentional. Older requests cannot regress timestamps.
 */
export async function observeAppClient(db: D1Database, userId: number, versionCode: number | null, now = new Date().toISOString()): Promise<void> {
  const epoch = await queryOne<{ id: number }>(db, 'SELECT id FROM app_client_measurement WHERE id=1')
  if (!epoch) throw new Error('App client measurement unavailable')
  const versionKey = versionCode ?? 0
  const results = await db.batch([
    db.prepare(`INSERT INTO app_client_observations(user_id,version_key,first_seen_at,last_seen_at)
      SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM app_client_measurement WHERE id=1)
      ON CONFLICT(user_id,version_key) DO UPDATE SET
      first_seen_at=MIN(first_seen_at,excluded.first_seen_at),last_seen_at=MAX(last_seen_at,excluded.last_seen_at)`).bind(userId, versionKey, now, now),
    db.prepare(`INSERT INTO app_client_latest(user_id,version_key,first_seen_at,last_seen_at) VALUES(?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET version_key=excluded.version_key,
      first_seen_at=MIN(first_seen_at,excluded.first_seen_at),last_seen_at=excluded.last_seen_at
      WHERE excluded.last_seen_at >= last_seen_at`).bind(userId, versionKey, now, now),
  ])
  if (results.some(result => !result.success)) throw new Error('App client observation transaction failed')
}

function activitySql(alias: string): string {
  return [1, 7, 30].map(days => `COUNT(DISTINCT CASE WHEN ${alias}.last_seen_at >= ? THEN ${alias}.user_id END) AS active_${days}d`).join(',')
}
function windows(now: number): string[] { return [1, 7, 30].map(days => new Date(now - days * 86400000).toISOString()) }

/** Exact observed distinct users and per-version pairs, with explicit missing-migration/read failure availability. */
export async function appClientStats(db: D1Database, now = Date.now()): Promise<AppClientStats> {
  const unavailable: AppClientStats = { available: false, measurement_started_at: null, totals: { observed_users: 0, versioned_users: 0, unversioned_users: 0, active_1d: 0, active_7d: 0, active_30d: 0 }, versions: [] }
  try {
    const epoch = await queryOne<{ measurement_started_at: string }>(db, 'SELECT measurement_started_at FROM app_client_measurement WHERE id=1')
    if (!epoch) return unavailable
    const totals = await queryOne<AppClientStats['totals']>(db, `SELECT COUNT(DISTINCT o.user_id) AS observed_users,
      COUNT(DISTINCT CASE WHEN o.version_key>0 THEN o.user_id END) AS versioned_users,
      COUNT(DISTINCT CASE WHEN o.version_key=0 THEN o.user_id END) AS unversioned_users,${activitySql('o')}
      FROM app_client_observations o JOIN users u ON u.id=o.user_id`, windows(now))
    const versions = await query<AppClientStats['versions'][number]>(db, `SELECT NULLIF(o.version_key,0) AS version_code,
      COUNT(*) AS observed_users,COUNT(CASE WHEN l.version_key=o.version_key THEN 1 END) AS latest_users,${activitySql('o')}
      FROM app_client_observations o JOIN users u ON u.id=o.user_id LEFT JOIN app_client_latest l ON l.user_id=o.user_id
      GROUP BY o.version_key ORDER BY o.version_key DESC`, windows(now))
    if (!totals) return unavailable
    return { available: true, measurement_started_at: epoch.measurement_started_at, totals, versions }
  } catch (error) {
    console.error(JSON.stringify({ event: 'app_client_stats_unavailable', error: String(error) }))
    return unavailable
  }
}

/** Paginated observed pair drilldown; all selects each account's latest pair (not its maximum code). */
export async function appClientUsers(db: D1Database, version: number | null | 'all', page: number, limit: number, q: string): Promise<AppClientUsers> {
  const epoch = await queryOne<{ id: number }>(db, 'SELECT id FROM app_client_measurement WHERE id=1')
  if (!epoch) throw new Error('App client measurement unavailable')
  const base = version === 'all'
    ? 'FROM app_client_latest l JOIN app_client_observations o ON o.user_id=l.user_id AND o.version_key=l.version_key JOIN users u ON u.id=o.user_id'
    : 'FROM app_client_observations o JOIN users u ON u.id=o.user_id'
  const predicates = version === 'all' ? [] : ['o.version_key=?']
  const params: unknown[] = version === 'all' ? [] : [version ?? 0]
  if (q) { predicates.push("(u.username LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')"); const search = `%${q.replace(/[\\%_]/g, '\\$&')}%`; params.push(search, search) }
  const where = predicates.length ? `WHERE ${predicates.join(' AND ')}` : ''
  const total = (await queryOne<{ total: number }>(db, `SELECT COUNT(*) AS total ${base} ${where}`, params))?.total ?? 0
  const users = await query<AppClientUsers['users'][number]>(db, `SELECT u.id,u.username,u.display_name,NULLIF(o.version_key,0) AS version_code,o.first_seen_at,o.last_seen_at
    ${base} ${where} ORDER BY o.last_seen_at DESC,u.id ASC LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit])
  return { users, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } }
}
