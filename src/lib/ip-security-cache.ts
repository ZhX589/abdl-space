import { cacheDelete, cacheDeletePrefix, cacheGet, cacheSet } from './ttl-cache.ts'

const IP_BAN_CACHE_TTL_MS = 30_000
const IP_BAN_CACHE_KEY_PREFIX = 'ipban:'
const TRACKING_RULE_CACHE_TTL_MS = 60_000
const TRACKING_RULE_CACHE_KEY_PREFIX = 'trackrule:'

export function getCachedIpBan(ip: string): boolean | undefined {
  return cacheGet<boolean>(IP_BAN_CACHE_KEY_PREFIX + ip)
}

export function cacheIpBan(ip: string, banned: boolean): void {
  cacheSet(IP_BAN_CACHE_KEY_PREFIX + ip, banned, IP_BAN_CACHE_TTL_MS)
}

export function invalidateIpBan(ip: string): void {
  cacheDelete(IP_BAN_CACHE_KEY_PREFIX + ip)
}

export function clearIpBanCache(): void {
  cacheDeletePrefix(IP_BAN_CACHE_KEY_PREFIX)
}

export function getCachedTrackingRule(userId: number): boolean | undefined {
  return cacheGet<boolean>(TRACKING_RULE_CACHE_KEY_PREFIX + userId)
}

export function cacheTrackingRule(userId: number, enabled: boolean): void {
  cacheSet(TRACKING_RULE_CACHE_KEY_PREFIX + userId, enabled, TRACKING_RULE_CACHE_TTL_MS)
}

export function invalidateTrackingRule(userId: number): void {
  cacheDelete(TRACKING_RULE_CACHE_KEY_PREFIX + userId)
}
