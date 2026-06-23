/**
 * Link Preview Card Generator
 * Extracts Open Graph metadata from URLs found in post content.
 */

import type { MastodonPreviewCard } from './types.ts'

const DOMAIN = 'abdl-space.top'
const FETCH_TIMEOUT_MS = 3000
const CACHE_TTL_MS = 30 * 60 * 1000 // 30 minutes
const MAX_CONTENT_LENGTH = 512 * 1024 // 512KB max to parse

// In-memory cache: url → { card, expiresAt }
const cardCache = new Map<string, { card: MastodonPreviewCard | null; expiresAt: number }>()
let lastCleanup = Date.now()

/** Clean expired entries (called on each request, throttled to once per minute) */
function cleanupCache() {
  const now = Date.now()
  if (now - lastCleanup < 60_000) return
  lastCleanup = now
  for (const [url, entry] of cardCache) {
    if (entry.expiresAt < now) cardCache.delete(url)
  }
}

// Common TLDs whitelist (same as frontend RichContent.jsx)
const TLDS = /^(com|net|org|cn|top|xyz|io|dev|app|co|me|cc|info|edu|gov|mil|club|online|site|tech|store|blog|work|live|video|social|design|shop|icu|ltd|fun|space|host|press|link|click|buzz|pro|vip|wang|ren)$/i

/** Extract the first URL from HTML or plain text content */
export function extractFirstUrl(content: string): string | null {
  // 0. Before stripping HTML, extract URLs from <a href="..."> tags first
  const hrefMatch = content.match(/href="(https?:\/\/[^"]+)"/i)
  if (hrefMatch) {
    let url = hrefMatch[1].replace(/[.,;:!?)]+$/, '')
    try { new URL(url); return url } catch {}
  }

  // Strip HTML tags
  const text = content.replace(/<[^>]*>/g, ' ')

  // 1. Try explicit http(s) URLs — exclude CJK to avoid "https://site.com/中文帖子内容" 误匹配
  let match = text.match(/https?:\/\/[^\s<>"'`,;)}\]\u3000-\u303f\uff00-\uffef\u4e00-\u9fff]+/)
  if (match) {
    let url = match[0].replace(/[.,;:!?)]+$/, '')
    try { new URL(url); return url } catch {}
  }

  // 2. Try bare domain with www prefix — exclude CJK from path
  match = text.match(/(?:^|\s)(www\.[a-zA-Z0-9][-a-zA-Z0-9]*(?:\.[a-zA-Z0-9][-a-zA-Z0-9]*)+(?:\/[^\s<>"'`,;)}\]\u3000-\u303f\uff00-\uffef\u4e00-\u9fff]*)?)/)
  if (match) {
    let url = 'https://' + match[1].replace(/[.,;:!?)]+$/, '')
    try { new URL(url); return url } catch {}
  }

  // 3. Bare domain with TLD whitelist — exclude CJK from path
  const delim = '(?:^|[\\s.,;:!?([{\u201c"])'
  const domainBody = '(?:[a-zA-Z0-9][a-zA-Z0-9-]*\\.){0,2}([a-zA-Z0-9][a-zA-Z0-9-]+\\.(?:' + TLDS.source.replace(/\^|\$/g, '') + '))(?:/[^\\s<>\\u2018\\u2019`,;)}\\]\\u3000-\\u303f\\uff00-\\uffef\\u4e00-\\u9fff]*)?'
  const domainRe = new RegExp(delim + '(' + domainBody + ')', 'i')
  match = text.match(domainRe)
  if (match) {
    // match[1] is the full domain (e.g., "baidu.com"), match[2] is just the domain part before TLD
    const fullDomain = match[1]
    let url = 'https://' + fullDomain
    try { new URL(url); return url } catch {}
  }

  return null
}

/** Fetch and parse Open Graph metadata from a URL */
async function fetchOgMetadata(url: string): Promise<MastodonPreviewCard | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ABDL-Space/1.0; +https://abdl-space.top)',
        'Accept': 'text/html',
      },
      redirect: 'follow',
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!res.ok) return null

    const contentType = res.headers.get('content-type') || ''
    if (!contentType.includes('text/html')) return null

    const html = await res.text()
    // Limit parse size
    const limitedHtml = html.substring(0, MAX_CONTENT_LENGTH)

    // Extract meta tags
    const getMeta = (property: string): string | null => {
      // Try property attribute first, then name
      const patterns = [
        new RegExp(`<meta[^>]*property="${property}"[^>]*content="([^"]*)"`, 'i'),
        new RegExp(`<meta[^>]*content="([^"]*)"[^>]*property="${property}"`, 'i'),
        new RegExp(`<meta[^>]*name="${property}"[^>]*content="([^"]*)"`, 'i'),
        new RegExp(`<meta[^>]*content="([^"]*)"[^>]*name="${property}"`, 'i'),
      ]
      for (const p of patterns) {
        const m = limitedHtml.match(p)
        if (m) return m[1]
      }
      return null
    }

    const title = getMeta('og:title') || getMeta('twitter:title') || ''
    const description = getMeta('og:description') || getMeta('twitter:description') || getMeta('description') || ''
    const image = getMeta('og:image') || getMeta('twitter:image') || null
    const type = getMeta('og:type') || 'link'

    // Try to get site name
    const siteName = getMeta('og:site_name') || ''
    let providerName = siteName
    let providerUrl = ''

    if (!providerName) {
      try {
        const u = new URL(url)
        providerName = u.hostname.replace(/^www\./, '')
        providerUrl = u.origin
      } catch {}
    } else {
      try {
        const u = new URL(url)
        providerUrl = u.origin
      } catch {}
    }

    // Make relative image URLs absolute
    let absoluteImage = image
    if (image && !image.startsWith('http')) {
      try {
        const u = new URL(url)
        absoluteImage = new URL(image, u.origin).href
      } catch {}
    }

    return {
      url,
      title: title.substring(0, 256),
      description: description.substring(0, 512),
      type: mapOgType(type),
      author_name: '',
      author_url: '',
      provider_name: providerName.substring(0, 100),
      provider_url: providerUrl,
      html: '',
      width: 0,
      height: 0,
      image: absoluteImage,
      embed_url: '',
      blurhash: null,
    }
  } catch {
    clearTimeout(timeout)
    return null
  }
}

function mapOgType(ogType: string): string {
  const typeMap: Record<string, string> = {
    'article': 'link',
    'website': 'link',
    'blog': 'link',
    'video.other': 'video',
    'video.movie': 'video',
    'video.episode': 'video',
    'video.tv_show': 'video',
    'music.song': 'music',
    'music.album': 'music',
    'music.playlist': 'music',
    'profile': 'link',
  }
  return typeMap[ogType] || 'link'
}

/** Get or generate a preview card for a URL, with caching */
export async function getLinkPreviewCard(url: string): Promise<MastodonPreviewCard | null> {
  cleanupCache()

  // Check cache
  const cached = cardCache.get(url)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.card
  }

  // Don't fetch cards for ABDL Space internal links
  if (url.includes(DOMAIN) || url.includes('abdl-space.top')) {
    return null
  }

  // Try to fetch OG metadata, but always return at least a basic card
  let card: MastodonPreviewCard | null = null
  try {
    card = await fetchOgMetadata(url)
  } catch {}

  // If OG fetch failed or returned null, create a basic card from URL info
  if (!card) {
    try {
      const u = new URL(url)
      const providerName = u.hostname.replace(/^www\./, '')
      card = {
        url,
        title: providerName,
        description: url,
        type: 'link',
        author_name: '',
        author_url: '',
        provider_name: providerName,
        provider_url: u.origin,
        html: '',
        width: 0,
        height: 0,
        image: null,
        embed_url: '',
        blurhash: null,
      }
    } catch {}
  }

  cardCache.set(url, { card, expiresAt: Date.now() + CACHE_TTL_MS })
  return card
}

/** Generate a link preview card for the first URL found in content */
export async function generateCardForContent(content: string): Promise<MastodonPreviewCard | null> {
  const url = extractFirstUrl(content)
  if (!url) return null
  return getLinkPreviewCard(url)
}

/** Batch generate link preview cards for multiple posts. Returns Map<postId, card> */
export async function generateCardsForPosts(
  posts: { id: number | string; content: string; diaper_id?: number | null }[]
): Promise<Map<number, MastodonPreviewCard>> {
  const results = new Map<number, MastodonPreviewCard>()
  // Only process posts that don't have a diaper_id (already have cards) and have URLs
  const candidates = posts.filter(p => !p.diaper_id && extractFirstUrl(p.content))
  // Process in parallel, limit concurrency to 5
  const CONCURRENCY = 5
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY)
    const cards = await Promise.allSettled(
      batch.map(async (p) => {
        const card = await generateCardForContent(p.content)
        return { id: Number(p.id), card }
      })
    )
    for (const r of cards) {
      if (r.status === 'fulfilled' && r.value.card) {
        results.set(r.value.id, r.value.card)
      }
    }
  }
  return results
}
