import type { Context, Next } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import type { AppClientVariables, AppClientPolicy } from '../types/app-clients.ts'
import type { MastodonStatus } from '../mastodon/types.ts'
import { toAccount, toStatus } from '../mastodon/converter.ts'
import { extractBearerUser, assertSessionNotStale } from './auth.ts'
import { queryOne } from '../lib/db.ts'
import { APP_DOWNLOAD_URL, isNativeAppClient, observeAppClient, parseAppVersionCode, readAppClientPolicy, readAppClientReminder } from '../lib/app-clients.ts'

type AppType = { Bindings: Env; Variables: AppClientVariables }

/** Backward-compatible retirement notice API. */
export function appUpdateNotice(policy: AppClientPolicy): MastodonStatus {
  return buildAppUpdateNotice(policy.update_message)
}

/** Synthetic, fully populated Mastodon status from plaintext; never persisted as a real account or post. */
export function buildAppUpdateNotice(message: string): MastodonStatus {
  const createdAt = '2026-10-03T00:00:00.000Z'
  const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
  const account = toAccount({ id: 0, username: 'app-update', avatar: null, role: 'user', bio: null, created_at: createdAt })
  account.id = '-1'
  account.acct = 'app-update'
  account.display_name = 'App 更新提醒'
  account.url = APP_DOWNLOAD_URL
  account.uri = APP_DOWNLOAD_URL
  account.bot = true
  const status = toStatus({ id: 0, user_id: 0, content: '', created_at: createdAt, like_count: 0, comment_count: 0 }, account)
  return { ...status, id: 'app-update-required', uri: `${APP_DOWNLOAD_URL}#update-required`, url: APP_DOWNLOAD_URL,
    content: `<p>${escape(message).replace(/\r\n|\r|\n/g, '<br>')}</p><p><a href="${APP_DOWNLOAD_URL}" rel="nofollow noopener noreferrer" target="_blank">下载最新版本 App</a></p>`,
    text: `${message}\n${APP_DOWNLOAD_URL}`, visibility: 'public', language: 'zh', edited_at: null }
}

async function prependReminder(c: Context<AppType>, message: string): Promise<void> {
  const maximumBytes = 2 * 1024 * 1024
  const response = c.res
  if (response.status !== 200 || response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
    || response.headers.has('Content-Encoding') || Number(response.headers.get('Content-Length')) > maximumBytes) return
  try {
    // Parse only a bounded clone. The original body and shared cached objects remain untouched on every fallback.
    const reader = response.clone().body?.getReader()
    if (!reader) return
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let bytes = 0
    let text = ''
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > maximumBytes) {
          // Tee cancellation may wait for the unread original branch; never await it.
          void reader.cancel().catch(() => {})
          return
        }
        text += decoder.decode(value, { stream: true })
      }
      text += decoder.decode()
    } catch (error) {
      void reader.cancel().catch(() => {})
      throw error
    } finally { reader.releaseLock() }
    const body: unknown = JSON.parse(text)
    // An empty list is the legacy client's terminal pagination signal; never turn it into a cursor.
    if (!Array.isArray(body) || body.length === 0) return
    const realStatuses = body.filter((item: unknown) => !item || typeof item !== 'object' || (item as Record<string, unknown>).id !== 'app-update-required')
    if (realStatuses.length === 0) return
    const updated = JSON.stringify([buildAppUpdateNotice(message), ...realStatuses])
    // Hono's response setter copies old headers, so remove stale validators on both sets.
    const headers = new Headers(response.headers)
    for (const name of ['Content-Length', 'ETag', 'Content-MD5', 'Content-Digest', 'Digest', 'Last-Modified']) {
      c.header(name, undefined)
      headers.delete(name)
    }
    c.res = new Response(updated, { status: response.status, statusText: response.statusText, headers })
  } catch (error) {
    console.error(JSON.stringify({ event: 'app_client_reminder_response_unavailable', error: String(error) }))
  }
}

async function freshSession(c: Context<AppType>): Promise<JWTPayload | null> {
  // Mastodon timeline authentication is bearer-only. Do not broaden it to cookie-only clients.
  if (!/^Bearer\s+/i.test(c.req.header('Authorization') || '')) return null
  const payload = await extractBearerUser(c)
  if (!payload || await assertSessionNotStale(payload, c.env.abdl_space_db)) return null
  const db = c.env.abdl_space_db
  const user = await queryOne<{ id: number; role: string; banned?: number }>(db, 'SELECT id,role,banned FROM users WHERE id=?', [payload.sub]).catch(error => {
    // Base bootstrap still lacks the optional legacy banned column. Never swallow other DB failures.
    if (!/no such column: banned/i.test(String(error))) throw error
    return queryOne<{ id: number; role: string; banned?: number }>(db, 'SELECT id,role FROM users WHERE id=?', [payload.sub])
  })
  if (!user || user.banned) return null
  return { ...payload, role: user.role }
}

function privateHeaders(c: Context<AppType>): void {
  c.header('Cache-Control', 'private, no-store')
  const vary = new Set((c.res.headers.get('Vary') || '').split(',').map(value => value.trim()).filter(Boolean))
  for (const header of ['User-Agent', 'X-App-Version-Code', 'Authorization']) vary.add(header)
  c.header('Vary', [...vary].join(', '))
}

/** Lightweight headers run before rate limiting, without any auth/policy/observation database I/O. */
export async function appClientCacheMiddleware(c: Context<AppType>, next: Next): Promise<void> {
  if (c.req.method !== 'GET' || !isNativeAppClient(c.req.header('User-Agent'))) { await next(); return }
  privateHeaders(c)
  try { await next() } finally { privateHeaders(c) }
}

/** Native GET timelines only: fresh auth and awaited observation precede policy and every cache/upstream handler.
 * Attach before timeline routes (including future timeline stubs), and before the NBW alias.
 * Fail-open storage failures are observable via structured logs and X-App-Client-Observation.
 */
export async function appClientTimelineMiddleware(c: Context<AppType>, next: Next): Promise<Response | void> {
  if (c.req.method !== 'GET' || !isNativeAppClient(c.req.header('User-Agent'))) return next()
  // routes.ts wildcard can also run when the subsequently mounted NBW alias matches.
  if (c.get('appClientSession') !== undefined) return next()
  privateHeaders(c)
  const versionCode = parseAppVersionCode(c.req.header('X-App-Version-Code'))
  let session: JWTPayload | null = null
  try { session = await freshSession(c) } catch (error) {
    console.error(JSON.stringify({ event: 'app_client_auth_unavailable', error: String(error) }))
  }
  c.set('appClientSession', session)
  if (session) {
    try {
      await observeAppClient(c.env.abdl_space_db, session.sub, versionCode)
      c.header('X-App-Client-Observation', 'recorded')
    } catch (error) {
      c.header('X-App-Client-Observation', 'unavailable')
      console.error(JSON.stringify({ event: 'app_client_observation_failed', user_id: session.sub, version_code: versionCode, error: String(error) }))
    }
  }
  // Preserve required timeline auth even when a policy matches (home/list/direct are private feeds).
  if (/\/timelines\/(?:home|direct|list)(?:\/|$)/.test(c.req.path) && !session) {
    return c.json({ error: 'The access token is invalid' }, 401)
  }
  const { policy, available } = await readAppClientPolicy(c.env.abdl_space_db)
  if (!available) c.header('X-App-Client-Policy', 'unavailable')
  if (policy.enabled && (versionCode === null ? policy.block_unversioned : policy.deprecated_version_codes.includes(versionCode))) {
    c.header('Link', undefined)
    return c.json([appUpdateNotice(policy)])
  }
  // Retirement wins without even reading the independent reminder setting.
  const { reminder, available: reminderAvailable } = await readAppClientReminder(c.env.abdl_space_db)
  if (!reminderAvailable) c.header('X-App-Client-Reminder', 'unavailable')
  // A reserved notice ID is never a real next cursor, even after the reminder is disabled.
  if (c.req.query('max_id') === 'app-update-required') {
    c.header('Link', undefined)
    return c.json([])
  }
  // Legacy native pagination/gap filling does not safely deduplicate this stable ID.
  // Initial loads only: retain all real continuation and incremental-refresh pages unchanged.
  const offset = c.req.query('offset')
  const continuation = ['max_id', 'min_id', 'since_id', 'cursor'].some(key => !!c.req.query(key)) || (!!offset && offset !== '0')
  try {
    await next()
    if (!continuation && reminder.enabled && versionCode !== null && reminder.version_codes.includes(versionCode)) await prependReminder(c, reminder.message)
  } finally { privateHeaders(c) }
}
