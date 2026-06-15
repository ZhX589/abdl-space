/**
 * ABDL Space → Mastodon Entity Converter
 * All conversion functions are pure — no DB calls.
 */

import type { MastodonAccount, MastodonStatus, MastodonMediaAttachment, MastodonNotification } from './types.ts'
import { toMastoId } from './shared.ts'

const INSTANCE_DOMAIN = 'abdl-space.top'
const DEFAULT_AVATAR = 'https://img.abdl-space.top/file/system/1781439303787_play_store_512.png'
const DEFAULT_HEADER = 'https://img.abdl-space.top/file/system/1781439303787_play_store_512.png'

/** Convert date string to ISO 8601 format for Moshidon compatibility */
function toISOString(dateStr: string): string {
  if (!dateStr) return new Date().toISOString()
  if (dateStr.includes('T')) return dateStr
  return dateStr.replace(' ', 'T') + 'Z'
}

/** ABDL User → Mastodon Account */
export function toAccount(user: {
  id: number
  username: string
  avatar: string | null
  role: string
  bio?: string | null
  created_at: string
}, opts?: {
  statuses_count?: number
  followers_count?: number
  following_count?: number
  last_status_at?: string | null
}): MastodonAccount {
  const avatar = user.avatar || DEFAULT_AVATAR
  return {
    id: String(user.id),
    username: user.username,
    acct: user.username,
    display_name: user.username,
    locked: false,
    bot: false,
    discoverable: true,
    group: false,
    created_at: toISOString(user.created_at),
    note: user.bio ? `<p>${escapeHtml(user.bio)}</p>` : '',
    url: `https://${INSTANCE_DOMAIN}/@${user.username}`,
    uri: `https://${INSTANCE_DOMAIN}/users/${user.username}`,
    avatar,
    avatar_static: avatar,
    header: DEFAULT_HEADER,
    header_static: DEFAULT_HEADER,
    followers_count: opts?.followers_count ?? 0,
    following_count: opts?.following_count ?? 0,
    statuses_count: opts?.statuses_count ?? 0,
    last_status_at: opts?.last_status_at ?? null,
    emojis: [],
    fields: [],
    roles: user.role === 'admin'
      ? [{ id: '1', name: 'Admin', color: '#ff6b6b', permissions: '65536', highlighted: true }]
      : [],
    hide_collections: false,
    noindex: false,
  }
}

/** ABDL Post → Mastodon Status */
export function toStatus(post: {
  id: number
  user_id: number
  content: string
  diaper_id?: number | null
  pinned?: boolean | number
  has_nsfw?: boolean | number
  is_announcement?: boolean | number
  like_count?: number
  comment_count?: number
  reblogs_count?: number
  has_liked?: boolean
  created_at: string
  images?: { image_url: string; is_nsfw?: boolean | number }[]
  repost?: unknown
}, account: MastodonAccount, opts?: {
  favourited?: boolean
  reblogged?: boolean
  reblog?: MastodonStatus
}): MastodonStatus {
  const contentHtml = formatContent(post.content)
  const images = post.images || []

  return {
    id: toMastoId('post', post.id),
    created_at: toISOString(post.created_at),
    in_reply_to_id: null,
    in_reply_to_account_id: null,
    sensitive: !!post.has_nsfw,
    spoiler_text: '',
    visibility: 'public',
    language: 'zh',
    uri: `https://${INSTANCE_DOMAIN}/users/${account.username}/statuses/${post.id}`,
    url: `https://${INSTANCE_DOMAIN}/@${account.username}/${post.id}`,
    replies_count: post.comment_count ?? 0,
    reblogs_count: post.reblogs_count ?? 0,
    favourites_count: post.like_count ?? 0,
    favourited: opts?.favourited ?? false,
    reblogged: opts?.reblogged ?? false,
    muted: false,
    bookmarked: false,
    pinned: !!post.pinned,
    content: contentHtml,
    reblog: opts?.reblog ?? null,
    application: { name: 'ABDL Space', website: `https://${INSTANCE_DOMAIN}` },
    account,
    media_attachments: images.map((img, i) => toMediaAttachment(i, img.image_url)),
    mentions: [],
    tags: extractTags(post.content),
    emojis: [],
    card: post.diaper_id ? {
      url: `https://abdl-space.top/diaper/${post.diaper_id}`,
      title: `纸尿裤 #${post.diaper_id}`,
      description: '查看纸尿裤详情',
      type: 'link',
      author_name: '',
      author_url: '',
      provider_name: 'ABDL Space',
      provider_url: `https://${INSTANCE_DOMAIN}`,
      html: '',
      width: 0,
      height: 0,
      image: null,
      embed_url: '',
      blurhash: null,
    } : null,
    poll: null,
  }
}

/** ABDL Comment → Mastodon Status (as reply) */
export function toStatusFromComment(comment: {
  id: number
  post_id: number
  user_id: number
  parent_id?: number | null
  content: string
  like_count?: number
  has_liked?: boolean
  created_at: string
  images?: { image_url: string; is_nsfw?: boolean | number }[]
}, account: MastodonAccount): MastodonStatus {
  const images = comment.images || []
  const hasNsfwImage = images.some(img => img.is_nsfw)

  return {
    id: toMastoId('comment', comment.id),
    created_at: toISOString(comment.created_at),
    in_reply_to_id: comment.parent_id ? toMastoId('comment', comment.parent_id) : toMastoId('post', comment.post_id),
    in_reply_to_account_id: null,
    sensitive: hasNsfwImage,
    spoiler_text: '',
    visibility: 'public',
    language: 'zh',
    uri: `https://${INSTANCE_DOMAIN}/users/${account.username}/statuses/${comment.id}`,
    url: `https://${INSTANCE_DOMAIN}/@${account.username}/${comment.id}`,
    replies_count: 0,
    reblogs_count: 0,
    favourites_count: comment.like_count ?? 0,
    favourited: comment.has_liked ?? false,
    reblogged: false,
    muted: false,
    bookmarked: false,
    content: formatContent(comment.content),
    reblog: null,
    application: { name: 'ABDL Space', website: `https://${INSTANCE_DOMAIN}` },
    account,
    media_attachments: images.map((img, i) => toMediaAttachment(i, img.image_url)),
    mentions: [],
    tags: [],
    emojis: [],
    card: null,
    poll: null,
  }
}

/** Image URL → Mastodon MediaAttachment */
function toMediaAttachment(id: number, url: string): MastodonMediaAttachment {
  return {
    id: String(id),
    type: 'image',
    url,
    preview_url: url,
    remote_url: null,
    text_url: null,
    meta: {},
    description: null,
    blurhash: null,
  }
}

/** ABDL Notification → Mastodon Notification */
export function toNotification(notif: {
  id: number
  type: string
  message: string
  related_id: number | null
  read: number
  created_at: string
}, account: MastodonAccount, status?: MastodonStatus): MastodonNotification | null {
  const typeMap: Record<string, MastodonNotification['type']> = {
    like: 'favourite',
    comment: 'mention',
    reply: 'mention',
    follow: 'follow',
    repost: 'reblog',
    mention: 'mention',
  }

  const mastoType = typeMap[notif.type]
  if (!mastoType) return null

  return {
    id: String(notif.id),
    type: mastoType,
    created_at: toISOString(notif.created_at),
    account,
    status,
  }
}

/** Extract hashtags from content */
function extractTags(content: string): { name: string; url: string }[] {
  const tags: { name: string; url: string }[] = []
  const regex = /#([\w\u4e00-\u9fa5]+)/g
  let match
  while ((match = regex.exec(content)) !== null) {
    tags.push({ name: match[1], url: `https://${INSTANCE_DOMAIN}/tags/${match[1]}` })
  }
  return tags
}

/** Format plain text content to HTML */
function formatContent(text: string): string {
  // First escape HTML, then apply transformations
  let html = escapeHtml(text)
  // Convert URLs to links (must come before hashtag/mention to avoid double-processing)
  html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" rel="nofollow noopener noreferrer" target="_blank">$1</a>')
  // Convert #hashtags (only word chars + CJK, not HTML entities)
  html = html.replace(/(^|[^\/\w])#([\w\u4e00-\u9fa5]+)/g, `$1<a href="https://${INSTANCE_DOMAIN}/tags/$2" class="mention hashtag" rel="tag">#<span>$2</span></a>`)
  // Convert @mentions (only word chars + CJK)
  html = html.replace(/@([\w\u4e00-\u9fa5]+)/g, `<span class="h-card"><a href="https://${INSTANCE_DOMAIN}/@$1" class="u-url mention" rel="nofollow noopener noreferrer" target="_blank">@<span>$1</span></a></span>`)
  // Convert newlines to paragraphs
  const paragraphs = html.split(/\n\n+/)
  if (paragraphs.length > 1) {
    return paragraphs.map(p => `<p>${p.replace(/\n/g, '<br />')}</p>`).join('')
  }
  return `<p>${html.replace(/\n/g, '<br />')}</p>`
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
