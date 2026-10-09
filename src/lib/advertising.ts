import type { D1Database } from '@cloudflare/workers-types'
import { queryOne, run } from './db.ts'
import type { MastodonAccount, MastodonStatus } from '../mastodon/types.ts'

export const AD_EVENT_TYPES = ['impression', 'link_click', 'image_view', 'ad_navigation'] as const
export type AdvertisingEventType = typeof AD_EVENT_TYPES[number]

export interface AdvertisingUrlResult {
  url: string
  protocol: 'http:' | 'https:'
}

export interface AdvertisingPolicy {
  enabled: boolean
  max_per_timeline: number
  min_interval_seconds: number
  ad_probability: number
  fallback_probability: number
}

export interface AdvertisementRow {
  id: number
  merchant_id: number
  merchant_name: string
  merchant_avatar: string | null
  ad_type: 'merchant' | 'official' | 'system'
  title: string
  body: string
  landing_url: string | null
  image_url: string | null
  status: string
  starts_at: string | null
  ends_at: string | null
  impression_count: number
  link_click_count: number
  image_view_count: number
  ad_navigation_count: number
}

const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback'])
const IPV4_RE = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/
const IPV6_RE = /^[0-9a-f:]+$/i

function isDecimalOctet(value: string): boolean {
  return /^(?:0|[1-9]\d*)$/.test(value) && Number(value) <= 255
}

function isBlockedIpv4(host: string): boolean {
  const match = IPV4_RE.exec(host)
  if (!match || !match.slice(1).every(isDecimalOctet)) return false
  const [a, b] = match.slice(1).map(Number)
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19))
    || (a === 203 && b === 0)
    || a >= 224
}

function isBlockedIpv6(host: string): boolean {
  const normalized = host.toLowerCase()
  if (!IPV6_RE.test(normalized)) return false
  if (normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true
  if (normalized.startsWith('ff')) return true
  const mapped = normalized.match(/(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/)
  return !!mapped && isBlockedIpv4(mapped[1])
}

function isReservedHostname(host: string): boolean {
  const lower = host.toLowerCase().replace(/\.$/, '')
  if (BLOCKED_HOSTS.has(lower) || lower.endsWith('.localhost') || lower.endsWith('.local') || lower.endsWith('.internal') || lower.endsWith('.test') || lower.endsWith('.invalid') || lower.endsWith('.example')) return true
  return lower === 'metadata.google.internal' || lower === 'metadata.google.com'
}

/** Validate an advertiser-controlled external URL without making a network request. */
export function validateAdvertisingUrl(value: unknown): AdvertisingUrlResult {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048 || [...value].some(char => char.charCodeAt(0) <= 0x20) || /[<>"']/.test(value)) throw new Error('Invalid advertising URL')
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error('Invalid advertising URL') }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.port) throw new Error('Invalid advertising URL')
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host || isReservedHostname(host) || isBlockedIpv4(host) || isBlockedIpv6(host)) throw new Error('Invalid advertising URL')
  return { url: parsed.toString(), protocol: parsed.protocol }
}

function validEventType(value: unknown): value is AdvertisingEventType {
  return typeof value === 'string' && (AD_EVENT_TYPES as readonly string[]).includes(value)
}

/** Hash a client event key so raw identifiers are not persisted. */
export async function hashAdvertisingEventKey(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes)).map(v => v.toString(16).padStart(2, '0')).join('')
}

/** Record one idempotent event and increment its matching aggregate counter. */
export async function recordAdvertisingEvent(db: D1Database, adId: number, userId: number | null, eventType: unknown, eventKey: string): Promise<{ recorded: boolean }> {
  if (!validEventType(eventType) || !Number.isSafeInteger(adId) || adId <= 0 || !eventKey || eventKey.length > 200) throw new Error('Invalid advertising event')
  const hashedKey = await hashAdvertisingEventKey(eventKey)
  const inserted = await run(db, `INSERT OR IGNORE INTO advertising_events (advertisement_id,user_id,event_key,event_type) VALUES (?,?,?,?)`, [adId, userId, hashedKey, eventType])
  if (Number(inserted.meta?.changes ?? 0) === 0) return { recorded: false }
  const column: Record<AdvertisingEventType, string> = { impression: 'impression_count', link_click: 'link_click_count', image_view: 'image_view_count', ad_navigation: 'ad_navigation_count' }
  await run(db, `UPDATE advertisements SET ${column[eventType]} = ${column[eventType]} + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [adId])
  return { recorded: true }
}

/** Return the currently deliverable ad under the global policy, or null when unavailable. */
export async function pickTimelineAdvertisement(db: D1Database, options: { isSponsor?: boolean; random?: () => number } = {}): Promise<AdvertisementRow | null> {
  if (options.isSponsor) return null
  const policy = await queryOne<{ enabled: number; max_per_timeline: number; ad_probability: number; fallback_probability: number }>(db, 'SELECT enabled,max_per_timeline,ad_probability,fallback_probability FROM advertising_policies WHERE id=1').catch(() => null)
  if (!policy?.enabled || policy.max_per_timeline < 1) return null
  const random = options.random ?? Math.random
  const selectCandidate = async (kind: 'merchant' | 'official') => queryOne<AdvertisementRow>(db, `SELECT a.id,a.merchant_id,m.display_name AS merchant_name,m.avatar_url AS merchant_avatar,a.ad_type,a.title,a.body,a.landing_url,a.image_url,a.status,a.starts_at,a.ends_at,a.impression_count,a.link_click_count,a.image_view_count,a.ad_navigation_count
    FROM advertisements a JOIN merchants m ON m.id=a.merchant_id
    WHERE a.status='active' AND m.status='active' AND (a.starts_at IS NULL OR a.starts_at <= CURRENT_TIMESTAMP) AND (a.ends_at IS NULL OR a.ends_at > CURRENT_TIMESTAMP)
      AND ${kind === 'merchant' ? "a.ad_type='merchant'" : "a.ad_type IN ('official','system')"}
    ORDER BY a.updated_at ASC, a.id ASC LIMIT 1`).catch(() => null)
  if (random() * 100 < policy.ad_probability) {
    const merchant = await selectCandidate('merchant')
    if (merchant) return merchant
  }
  if (random() * 100 < policy.fallback_probability) return selectCandidate('official')
  return null
}

/** Build the synthetic status shape used by Mastodon timeline clients. */
export function toAdvertisementStatus(ad: AdvertisementRow, account: MastodonAccount): MastodonStatus {
  const now = new Date().toISOString()
  return {
    id: `ad_${ad.id}`, created_at: now, in_reply_to_id: null, in_reply_to_account_id: null, sensitive: false, mental_crisis: false,
    spoiler_text: '', visibility: 'public', language: 'zh', uri: `https://abdl-space.top/api/v1/advertisements/${ad.id}`, url: ad.landing_url || `https://abdl-space.top/merchant?ad=${ad.id}`,
    replies_count: 0, reblogs_count: 0, favourites_count: 0, bookmarks_count: 0, shares_count: 0, views_count: 0, heat: 0,
    favourited: false, reblogged: false, muted: false, bookmarked: false,
    content: `<p>${ad.ad_type === 'merchant' ? '商家广告' : '官方广告'}</p><p>${escapeHtml(ad.title)}</p><p>${escapeHtml(ad.body)}</p>`, reblog: null, application: { name: 'ABDL Space Advertising', website: 'https://abdl-space.top' },
    account, media_attachments: ad.image_url ? [{ id: `ad_image_${ad.id}`, type: 'image', url: ad.image_url, preview_url: ad.image_url, remote_url: null, text_url: null, meta: {}, description: ad.title, blurhash: null }] : [],
    mentions: [], tags: [], emojis: [], card: null, poll: null, advertisement: { id: ad.id, merchant_id: ad.merchant_id, merchant_name: ad.merchant_name, title: ad.title, landing_url: ad.landing_url, image_url: ad.image_url, type: ad.ad_type, official: ad.ad_type !== 'merchant' },
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] ?? ch))
}
