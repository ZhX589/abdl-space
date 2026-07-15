/**
 * ABDL Space → Mastodon Entity Converter
 * All conversion functions are pure — no DB calls.
 */

import type { MastodonAccount, MastodonStatus, MastodonMediaAttachment, MastodonNotification, MastodonPoll } from './types.ts'
import { toMastoId } from './shared.ts'

const INSTANCE_DOMAIN = 'abdl-space.top'
const DEFAULT_AVATAR = 'https://img.abdl-space.top/file/system/1781439303787_play_store_512.png'
const DEFAULT_HEADER = 'https://img.abdl-space.top/file/system/1781439303787_play_store_512.png'

/** Convert date string to ISO 8601 format for Moshidon compatibility */
export function toISOString(dateStr: string): string {
  if (!dateStr) return new Date().toISOString()
  if (dateStr.includes('T')) return dateStr
  return dateStr.replace(' ', 'T') + 'Z'
}

/** ABDL User → Mastodon Account */
export function toAccount(user: {
  id: number
  username: string
  display_name?: string | null
  avatar: string | null
  header?: string | null
  role: string
  bio?: string | null
  profile_fields?: string | null
  nbw_username?: string | null
  created_at: string
}, opts?: {
  statuses_count?: number
  followers_count?: number
  following_count?: number
  last_status_at?: string | null
}): MastodonAccount {
  const avatar = user.avatar || DEFAULT_AVATAR
  const header = user.header || DEFAULT_HEADER
  return {
    id: String(user.id),
    username: user.username,
    acct: user.username,
    display_name: user.display_name || user.username,
    locked: false,
    bot: false,
    discoverable: true,
    group: false,
    created_at: toISOString(user.created_at),
    note: user.bio ? `<p>${escapeHtml(user.bio)}</p>` : '',
    url: `https://${INSTANCE_DOMAIN}/profile/${user.id}`,
    uri: `https://${INSTANCE_DOMAIN}/api/v1/accounts/${user.id}`,
    avatar,
    avatar_static: avatar,
    header,
    header_static: header,
    followers_count: opts?.followers_count ?? 0,
    following_count: opts?.following_count ?? 0,
    statuses_count: opts?.statuses_count ?? 0,
    last_status_at: opts?.last_status_at ?? null,
    emojis: [],
    fields: (() => { try { return JSON.parse(user.profile_fields || '[]') } catch { return [] } })(),
    roles: user.role === 'admin'
      ? [{ id: '1', name: 'Admin', color: '#ff6b6b', permissions: '65536', highlighted: true }]
      : [],
    hide_collections: false,
    noindex: false,
    source: {
      note: user.bio ? `<p>${escapeHtml(user.bio)}</p>` : '',
      fields: (() => { try { return JSON.parse(user.profile_fields || '[]') } catch { return [] } })(),
      privacy: 'public',
      sensitive: false,
      language: 'zh',
    },
    nbw_username: user.nbw_username || null,
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
  bookmarks_count?: number
  shares_count?: number
  has_liked?: boolean
  created_at: string
  images?: { image_url: string; is_nsfw?: boolean | number }[]
  repost?: unknown
  spoiler_text?: string
  visibility?: string
  language?: string
  in_reply_to_id?: string | number | null
  in_reply_to_type?: string | null
  in_reply_to_account_id?: string | number | null
  edited_at?: string | null
  poll?: MastodonPoll | null
  linkCard?: MastodonPreviewCard | null
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
    in_reply_to_id: post.in_reply_to_id ? toMastoId((post.in_reply_to_type || 'post') as 'post' | 'comment', post.in_reply_to_id) : null,
    in_reply_to_account_id: post.in_reply_to_account_id ? String(post.in_reply_to_account_id) : null,
    sensitive: !!post.has_nsfw,
    spoiler_text: post.spoiler_text || '',
    visibility: (post.visibility as MastodonStatus['visibility']) || 'public',
    language: post.language || 'zh',
    uri: `https://${INSTANCE_DOMAIN}/api/v1/statuses/${post.id}`,
    url: `https://${INSTANCE_DOMAIN}/forum/${post.id}`,
    replies_count: post.comment_count ?? 0,
    reblogs_count: post.reblogs_count ?? 0,
    favourites_count: post.like_count ?? 0,
    bookmarks_count: post.bookmarks_count ?? 0,
    shares_count: post.shares_count ?? 0,
    favourited: opts?.favourited ?? false,
    reblogged: opts?.reblogged ?? false,
    muted: false,
    bookmarked: opts?.bookmarked ?? false,
    pinned: !!post.pinned,
    content: contentHtml,
    reblog: opts?.reblog ?? null,
    application: { name: 'ABDL Space', website: `https://${INSTANCE_DOMAIN}` },
    account,
    media_attachments: images.map((img, i) => toMediaAttachment(i, img.image_url, img.alt_text)),
    mentions: [],
    tags: extractTags(post.content),
    emojis: [],
    card: post.linkCard ?? (post.diaper_id ? {
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
    } : null),
    poll: post.poll ?? null,
    edited_at: post.edited_at || null,
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
    uri: `https://${INSTANCE_DOMAIN}/api/v1/statuses/${comment.id}`,
    url: `https://${INSTANCE_DOMAIN}/forum/${comment.id}`,
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
    media_attachments: images.map((img, i) => toMediaAttachment(i, img.image_url, img.alt_text)),
    mentions: [],
    tags: [],
    emojis: [],
    card: null,
    poll: null,
  }
}

/** Image URL → Mastodon MediaAttachment */
function toMediaAttachment(id: number, url: string, description?: string | null, width?: number): MastodonMediaAttachment {
  return {
    id: String(id),
    type: 'image',
    url,
    preview_url: url,
    remote_url: null,
    text_url: null,
    meta: width ? {
      original: { width, height: 0, size: `${width}x0`, aspect: 0 },
    } : {},
    description: description || null,
    blurhash: null,
  }
}

/** NBW get_user_info → Mastodon Account（远程账号，不入库；不暴露 email/手机/QQ） */
export function toAccountFromNBW(user: {
  uid: number
  username?: string
  email?: string
  avatar?: string
  groupid?: number
  groupname?: string
  credits?: number
  regdate?: string
  profile?: Record<string, string>
  extcredits?: Record<string, number>
  posts?: number
  threads?: number
  lastactivity?: string
}): MastodonAccount {
  const uid = Number(user.uid)
  const username = user.username || `nbw_${uid}`
  const avatar = user.avatar || DEFAULT_AVATAR
  const profile = user.profile || {}
  const bio = stripHtml(String(profile['自我介绍'] || '')).trim()
  const createdAt = parseNBWDate(user.regdate)
  const lastActivity = parseNBWLastActivity(user.lastactivity)

  // 公开 fields 白名单（绝不暴露 email/手机/QQ）
  const fieldKeys = ['ABDL属性', '小朋友/家长', '生理性别', '心理性别', '兴趣爱好', '个人主页'] as const
  const fields: MastodonAccount['fields'] = []
  if (user.groupname) fields.push({ name: '用户组', value: escapeHtml(user.groupname), verified_at: null })
  if (user.credits != null) fields.push({ name: '积分', value: String(user.credits), verified_at: null })
  for (const key of fieldKeys) {
    const val = String(profile[key] || '').trim()
    if (val) fields.push({ name: key, value: escapeHtml(val), verified_at: null })
  }

  return {
    id: `nbw_${uid}`,
    username,
    acct: `${username}@newbabyworld.top`,
    display_name: username,
    locked: false,
    bot: false,
    discoverable: true,
    group: false,
    created_at: createdAt,
    note: bio ? `<p>${escapeHtml(bio)}</p>` : '',
    url: `https://www.newbabyworld.top/?${uid}`,
    uri: `https://www.newbabyworld.top/?${uid}`,
    avatar,
    avatar_static: avatar,
    header: DEFAULT_HEADER,
    header_static: DEFAULT_HEADER,
    followers_count: 0,
    following_count: 0,
    statuses_count: Number(user.threads ?? user.posts ?? 0),
    last_status_at: lastActivity,
    emojis: [],
    fields,
    roles: user.groupid === 1
      ? [{ id: 'nbw-admin', name: user.groupname || '管理员', color: '#ff6b6b', permissions: '0', highlighted: true }]
      : [],
    hide_collections: false,
    noindex: false,
  }
}

/** NBW sync thread → Mastodon Status（远程帖，不入库） */
export function toStatusFromNBW(thread: {
  tid: number
  fid?: number
  forum_name?: string
  subject?: string
  abstract?: string
  author?: string
  authorid?: number
  avatar?: string
  dateline?: number | string
  lastpost?: number | string
  views?: number
  replies?: number
  has_image?: number
  image_list?: Array<string | { url: string; width?: number }>
}): MastodonStatus {
  const tid = Number(thread.tid)
  const authorId = Number(thread.authorid || 0)
  const username = thread.author || `nbw_${authorId}`
  const avatar = thread.avatar || DEFAULT_AVATAR
  const createdAt = unixToISO(thread.dateline)

  const account: MastodonAccount = {
    id: `nbw_${authorId}`,
    username,
    acct: `${username}@newbabyworld.top`,
    display_name: username,
    locked: false,
    bot: false,
    discoverable: true,
    group: false,
    created_at: createdAt,
    note: '',
    url: `https://www.newbabyworld.top/?${authorId}`,
    uri: `https://www.newbabyworld.top/?${authorId}`,
    avatar,
    avatar_static: avatar,
    header: DEFAULT_HEADER,
    header_static: DEFAULT_HEADER,
    followers_count: 0,
    following_count: 0,
    statuses_count: 0,
    last_status_at: createdAt,
    emojis: [],
    fields: thread.forum_name
      ? [{ name: '版块', value: escapeHtml(thread.forum_name), verified_at: null }]
      : [],
    roles: [],
    hide_collections: false,
    noindex: false,
  }

  const subject = (thread.subject || '').trim()
  const abstract = (thread.abstract || '').trim()
  const plain = [subject, abstract].filter(Boolean).join('\n\n') || '来自宝宝新天地'
  const contentHtml = formatContent(plain)

  const images = (thread.image_list || []).map((img, i) => {
    if (typeof img === 'string') return toMediaAttachment(i, img)
    return toMediaAttachment(i, img.url, null, img.width)
  })

  const threadUrl = `https://www.newbabyworld.top/forum.php?mod=viewthread&tid=${tid}`

  return {
    id: `nbw_${tid}`,
    created_at: createdAt,
    in_reply_to_id: null,
    in_reply_to_account_id: null,
    sensitive: false,
    spoiler_text: '',
    visibility: 'public',
    language: 'zh',
    uri: threadUrl,
    url: threadUrl,
    replies_count: Number(thread.replies || 0),
    reblogs_count: 0,
    favourites_count: 0,
    bookmarks_count: 0,
    shares_count: 0,
    favourited: false,
    reblogged: false,
    muted: false,
    bookmarked: false,
    content: contentHtml,
    reblog: null,
    application: { name: '宝宝新天地', website: 'https://www.newbabyworld.top' },
    account,
    media_attachments: images,
    mentions: [],
    tags: extractTags(plain),
    emojis: [],
    card: thread.forum_name ? {
      url: threadUrl,
      title: subject || 'NBW 帖子',
      description: abstract || `来自版块：${thread.forum_name}`,
      type: 'link',
      author_name: username,
      author_url: account.url,
      provider_name: '宝宝新天地',
      provider_url: 'https://www.newbabyworld.top',
      html: '',
      width: 0,
      height: 0,
      image: images[0]?.url ?? null,
      embed_url: '',
      blurhash: null,
    } : null,
    poll: null,
    edited_at: null,
  }
}

function unixToISO(value?: number | string): string {
  if (value == null || value === '') return new Date().toISOString()
  if (typeof value === 'string' && value.includes('T')) return value
  const n = typeof value === 'number' ? value : parseInt(value, 10)
  if (!Number.isFinite(n) || n <= 0) return new Date().toISOString()
  // 10-digit unix seconds
  return new Date(n < 1e12 ? n * 1000 : n).toISOString()
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim()
}

/** NBW regdate: "2024-7-21 13:24" / "2024-07-21 13:24:13" */
function parseNBWDate(value?: string): string {
  if (!value) return new Date().toISOString()
  const cleaned = stripHtml(value)
  // title="2026-7-9 17:43"
  const titleMatch = value.match(/title="([^"]+)"/)
  const raw = titleMatch ? titleMatch[1] : cleaned
  const m = raw.match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/)
  if (!m) return new Date().toISOString()
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = m
  const iso = `${y.padStart(4, '0')}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${mi.padStart(2, '0')}:${s.padStart(2, '0')}.000Z`
  const t = Date.parse(iso)
  return Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString()
}

function parseNBWLastActivity(value?: string): string | null {
  if (!value) return null
  const titleMatch = value.match(/title="([^"]+)"/)
  if (titleMatch) return parseNBWDate(titleMatch[1])
  const cleaned = stripHtml(value)
  if (/\d{4}-\d{1,2}-\d{1,2}/.test(cleaned)) return parseNBWDate(cleaned)
  return null
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
  let html = escapeHtml(text)

  // Convert explicit http(s) URLs to clickable links
  // Use negative lookbehind to avoid matching URLs already inside href="..."
  html = html.replace(/(?<!href=")(https?:\/\/[^\s<>]+)/g, '<a href="$1" rel="nofollow noopener noreferrer" target="_blank">$1</a>')

  // Convert bare domains with common TLDs
  const URL_TLDS = 'com|net|org|cn|top|xyz|io|dev|app|co|me|cc|info|edu|gov|club|online|site|tech|store|blog|work|live|video|social|design|shop|icu|ltd|fun|space|host|press|link|buzz|pro|vip|wang|ren'
  html = html.replace(/(?<!href=")(?<!:\/\/)(?<![a-zA-Z0-9])((?:[a-zA-Z0-9][a-zA-Z0-9-]*\.){0,2}[a-zA-Z0-9][a-zA-Z0-9-]+\.)(?:${URL_TLDS})(?:\/[^\s<>]*)?/g, (match, domain, tld) => {
    const full = domain + tld
    const rest = match.substring(full.length)
    return `<a href="https://${full}${rest}" rel="nofollow noopener noreferrer" target="_blank">${full}${rest}</a>`
  })

  // Convert #hashtags
  html = html.replace(/(^|[^\/\w])#([\w\u4e00-\u9fa5]+)/g, `$1<a href="https://${INSTANCE_DOMAIN}/tags/$2" class="mention hashtag" rel="tag">#<span>$2</span></a>`)
  // Convert @mentions
  html = html.replace(/@([\w\u4e00-\u9fa5]+)/g, `<span class="h-card"><a href="https://${INSTANCE_DOMAIN}/@$1" class="u-url mention" rel="nofollow noopener noreferrer" target="_blank">@<span>$1</span></a></span>`)

  // Wrap in paragraphs
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
