/**
 * ABDL Space → Mastodon Entity Converter
 * All conversion functions are pure — no DB calls.
 */

import type { AlbumPostUpdate, MastodonAccount, MastodonStatus, MastodonMediaAttachment, MastodonNotification, MastodonPoll, MastodonStatusQuote } from './types.ts'
import type { Env } from '../types/index.ts'
import { createCosGetAuthorization } from '../lib/tencent-cos.ts'
import { toMastoId } from './shared.ts'
import { query } from '../lib/db.ts'
import { buildAvatarPreviewUrl, buildMediaPreviewUrl } from '../lib/media-preview.ts'

const INSTANCE_DOMAIN = 'abdl-space.top'
const DEFAULT_AVATAR = 'https://img.abdl-space.top/file/system/1781439303787_play_store_512.png'
const DEFAULT_HEADER = 'https://img.abdl-space.top/file/system/1781439303787_play_store_512.png'

// 头像统一改走 160px 预览端点：客户端里实际只显示 24–80px，直发原图（COS 上均 ~53KB、默认头像还是
// 512px PNG）是 App 侧最大的一块图片下行。NBW 等非可信源会被原样返回，不受影响。
function avatarPreviewUrl(raw: string | null | undefined): string {
  return buildAvatarPreviewUrl(raw || DEFAULT_AVATAR)
}
/** Required fallback for all channels, including native clients which receive extra card metadata. */
export const ALBUM_POST_FALLBACK = '【宝宝相册】当前渠道不支持查看此内容，请下载最新版ABDL Space APP查看详情'

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
  last_status_province?: string | null
  verified?: boolean
  badge?: { name: string; color: string } | null
}): MastodonAccount {
  const avatar = avatarPreviewUrl(user.avatar)
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
    last_status_province: opts?.last_status_province ?? null,
    badge: opts?.badge ?? null,
    baby_verification: opts?.baby_verification ?? null,
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
    verified: opts?.verified ?? false,
  }
}

/** 组合省市区为展示用位置串；null 表示无位置信息 */
function buildGeoLocation(province?: string | null, city?: string | null, district?: string | null): string | null {
  if (district) return `${province ?? ''}${city ?? ''}${district}`
  if (city) return `${province ?? ''}${city}`
  if (province) return province
  return null
}

/** 从 p.* 查询结果提取 geo 字段对象（透传给 toStatus） */
export function geoFromPost(r: Record<string, unknown>): { geo_province: string | null; geo_city: string | null; geo_district: string | null } {
  return {
    geo_province: r.geo_province as string | null,
    geo_city: r.geo_city as string | null,
    geo_district: r.geo_district as string | null,
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
  mental_crisis?: boolean | number
  is_announcement?: boolean | number
  like_count?: number
  comment_count?: number
  reblogs_count?: number
  bookmarks_count?: number
  shares_count?: number
  views_count?: number
  heat?: number
  has_liked?: boolean
  created_at: string
  images?: { image_url: string; is_nsfw?: boolean | number; alt_text?: string | null; blurhash?: string | null; preview_url?: string | null; storage_provider?: string | null }[]
  repost?: unknown
  spoiler_text?: string
  visibility?: string
  language?: string
  in_reply_to_id?: string | number | null
  in_reply_to_type?: string | null
  in_reply_to_account_id?: string | number | null
  edited_at?: string | null
  geo_province?: string | null
  geo_city?: string | null
  geo_district?: string | null
  poll?: MastodonPoll | null
  linkCard?: MastodonPreviewCard | null
  album_update?: AlbumPostUpdate | null
  album_visibility?: string | null
  is_album_update?: boolean
}, account: MastodonAccount, opts?: {
  favourited?: boolean
  reblogged?: boolean
  bookmarked?: boolean
  reblog?: MastodonStatus
}): MastodonStatus {
  const isAlbumUpdate = post.is_album_update === true || post.album_update != null || post.content === ALBUM_POST_FALLBACK
  const content = isAlbumUpdate ? ALBUM_POST_FALLBACK : post.content
  const contentHtml = formatContent(content)
  const images = isAlbumUpdate ? [] : post.images || []
  const albumUpdate = post.album_visibility === 'public' && post.album_update ? post.album_update : undefined

  return {
    id: toMastoId('post', post.id),
    created_at: toISOString(post.created_at),
    in_reply_to_id: post.in_reply_to_id ? toMastoId((post.in_reply_to_type || 'post') as 'post' | 'comment', post.in_reply_to_id) : null,
    in_reply_to_account_id: post.in_reply_to_account_id ? String(post.in_reply_to_account_id) : null,
    sensitive: !!post.has_nsfw,
    mental_crisis: !!post.mental_crisis,
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
    views_count: post.views_count ?? 0,
    heat: post.heat ?? 0,
    favourited: opts?.favourited ?? false,
    reblogged: opts?.reblogged ?? false,
    muted: false,
    bookmarked: opts?.bookmarked ?? false,
    pinned: !!post.pinned,
    content: contentHtml,
    reblog: opts?.reblog ?? null,
    application: { name: 'ABDL Space', website: `https://${INSTANCE_DOMAIN}` },
    geo_location: buildGeoLocation(post.geo_province, post.geo_city, post.geo_district),
    account,
    media_attachments: images.map((img, i) => toMediaAttachment(i, img.image_url, img.alt_text, undefined, img.blurhash, img.preview_url, img.storage_provider)),
    mentions: [],
    tags: isAlbumUpdate ? [] : extractTags(content),
    emojis: [],
    ...(albumUpdate ? { album_update: albumUpdate } : {}),
    card: isAlbumUpdate ? null : post.linkCard ?? (post.diaper_id ? {
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
    poll: isAlbumUpdate ? null : post.poll ?? null,
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
  images?: { image_url: string; is_nsfw?: boolean | number; alt_text?: string | null; blurhash?: string | null; preview_url?: string | null; storage_provider?: string | null }[]
}, account: MastodonAccount): MastodonStatus {
  const images = comment.images || []
  const hasNsfwImage = images.some(img => img.is_nsfw)

  return {
    id: toMastoId('comment', comment.id),
    created_at: toISOString(comment.created_at),
    in_reply_to_id: comment.parent_id ? toMastoId('comment', comment.parent_id) : toMastoId('post', comment.post_id),
    in_reply_to_account_id: null,
    sensitive: hasNsfwImage,
    mental_crisis: false,
    spoiler_text: '',
    visibility: 'public',
    language: 'zh',
    uri: `https://${INSTANCE_DOMAIN}/api/v1/statuses/${comment.id}`,
    url: `https://${INSTANCE_DOMAIN}/forum/${comment.id}`,
    replies_count: 0,
    reblogs_count: 0,
    favourites_count: comment.like_count ?? 0,
    bookmarks_count: 0,
    shares_count: 0,
    views_count: 0,
    heat: 0,
    favourited: comment.has_liked ?? false,
    reblogged: false,
    muted: false,
    bookmarked: false,
    content: formatContent(comment.content),
    reblog: null,
    application: { name: 'ABDL Space', website: `https://${INSTANCE_DOMAIN}` },
    account,
    media_attachments: images.map((img, i) => toMediaAttachment(i, img.image_url, img.alt_text, undefined, img.blurhash, img.preview_url, img.storage_provider)),
    mentions: [],
    tags: [],
    emojis: [],
    card: null,
    poll: null,
  }
}

/** Image URL → Mastodon MediaAttachment */
function toMediaAttachment(id: number, url: string, description?: string | null, width?: number, blurhash?: string | null, previewUrl?: string | null, storageProvider?: string | null): MastodonMediaAttachment {
  return {
    id: String(id),
    type: 'image',
    url,
    preview_url: previewUrl ?? buildMediaPreviewUrl(url, undefined, storageProvider === 'cos'),
    remote_url: null,
    text_url: null,
    meta: width ? {
      original: { width, height: 0, size: `${width}x0`, aspect: 0 },
    } : {},
    description: description || null,
    blurhash: blurhash || null,
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
  // get_user_info 偶发不带 avatar；用 Discuz 标准头像 URL 兜底（不要用 ABDL 默认图）
  const avatar = (typeof user.avatar === 'string' && user.avatar.trim())
    ? user.avatar.trim()
    : `https://www.newbabyworld.top/uc_server/avatar.php?uid=${uid}&size=middle`
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
    last_status_province: null,
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
  const avatar = (typeof thread.avatar === 'string' && thread.avatar.trim())
    ? thread.avatar.trim()
    : (authorId > 0
      ? `https://www.newbabyworld.top/uc_server/avatar.php?uid=${authorId}&size=middle`
      : DEFAULT_AVATAR)
  const createdAt = nbwThreadDateToISO(thread.dateline)

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
    last_status_province: null,
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
    mental_crisis: false,
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
    views_count: 0,
    heat: 0,
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

export type NBWReplyItem = {
  pid?: number
  author?: string
  authorid?: number
  avatar?: string
  dateline?: string
  position?: number
  support?: number
  ratetimes?: number
  content?: string
  quote_info?: {
    pid?: number
    author?: string
    dateline?: string
    message?: string
  } | null
  attachment_list?: Array<{
    aid?: number
    is_image?: number
    filename?: string
    filesize?: string
    width?: number
    price?: number
    readperm?: number
    extension?: string
    url?: string
  }> | null
}

/**
 * NBW 楼层回复 → Mastodon Status（远程回复，不入库）
 * - content 已由合作方剥离 [quote]，这里再兜底剥离 [attach] 等 bbcode
 * - 图片附件映射成 media_attachments，由 App 原生渲染
 * - quote_info 映射成 Mastodon quote 卡片，由 App 原生渲染引用 UI
 */
export function toStatusFromNBWReply(tid: number, reply: NBWReplyItem): MastodonStatus {
  const threadTid = Number(tid)
  const pid = Number(reply.pid ?? 0)
  const authorId = Number(reply.authorid ?? 0)
  const username = reply.author || `nbw_${authorId}`
  const threadUrl = `https://www.newbabyworld.top/forum.php?mod=viewthread&tid=${threadTid}`
  const createdAt = nbwThreadDateToISO(reply.dateline)

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
    url: authorId > 0 ? `https://www.newbabyworld.top/?${authorId}` : threadUrl,
    uri: authorId > 0 ? `https://www.newbabyworld.top/?${authorId}` : threadUrl,
    avatar: (typeof reply.avatar === 'string' && reply.avatar.trim())
      ? reply.avatar.trim()
      : (authorId > 0
        ? `https://www.newbabyworld.top/uc_server/avatar.php?uid=${authorId}&size=middle`
        : DEFAULT_AVATAR),
    avatar_static: (typeof reply.avatar === 'string' && reply.avatar.trim())
      ? reply.avatar.trim()
      : (authorId > 0
        ? `https://www.newbabyworld.top/uc_server/avatar.php?uid=${authorId}&size=middle`
        : DEFAULT_AVATAR),
    header: DEFAULT_HEADER,
    header_static: DEFAULT_HEADER,
    followers_count: 0,
    following_count: 0,
    statuses_count: 0,
    last_status_at: createdAt,
    last_status_province: null,
    emojis: [],
    fields: [],
    roles: [],
    hide_collections: false,
    noindex: false,
  }

  const quoteInfo = reply.quote_info && Number(reply.quote_info.pid) > 0 && reply.quote_info.message
    ? reply.quote_info
    : null
  const quotedPid = quoteInfo ? Number(quoteInfo.pid) : 0

  const attachments = (reply.attachment_list || [])
    .filter(a => a && Number(a.is_image) === 1 && typeof a.url === 'string' && a.url.trim())
    .map((a, i) => toMediaAttachment(i, a.url as string, a.filename || null, Number(a.width) || undefined))

  let quote: MastodonStatusQuote | null = null
  if (quoteInfo) {
    const quotedStatus: MastodonStatus = {
      id: `nbw_${threadTid}_${quotedPid}`,
      created_at: nbwThreadDateToISO(quoteInfo.dateline),
      in_reply_to_id: null,
      in_reply_to_account_id: null,
      sensitive: false,
      mental_crisis: false,
      spoiler_text: '',
      visibility: 'public',
      language: 'zh',
      uri: threadUrl,
      url: threadUrl,
      replies_count: 0,
      reblogs_count: 0,
      favourites_count: 0,
      bookmarks_count: 0,
      shares_count: 0,
      views_count: 0,
      heat: 0,
      favourited: false,
      reblogged: false,
      muted: false,
      bookmarked: false,
      content: formatContent(quoteInfo.message ?? ''),
      reblog: null,
      application: { name: '宝宝新天地', website: 'https://www.newbabyworld.top' },
      account: {
        id: `nbw_quote_${quotedPid}`,
        username: quoteInfo.author || '引用',
        acct: quoteInfo.author ? `${quoteInfo.author}@newbabyworld.top` : '引用',
        display_name: quoteInfo.author || '引用',
        locked: false,
        bot: false,
        discoverable: true,
        group: false,
        created_at: nbwThreadDateToISO(quoteInfo.dateline),
        note: '',
        url: threadUrl,
        uri: threadUrl,
        avatar: avatarPreviewUrl(DEFAULT_AVATAR),
        avatar_static: avatarPreviewUrl(DEFAULT_AVATAR),
        header: DEFAULT_HEADER,
        header_static: DEFAULT_HEADER,
        followers_count: 0,
        following_count: 0,
        statuses_count: 0,
        last_status_at: null,
        last_status_province: null,
        emojis: [],
        fields: [],
        roles: [],
        hide_collections: false,
        noindex: false,
      },
      media_attachments: [],
      mentions: [],
      tags: [],
      emojis: [],
      card: null,
      poll: null,
    }
    quote = {
      state: 'accepted',
      quoted_status: quotedStatus,
      quoted_status_id: `nbw_${threadTid}_${quotedPid}`,
    }
  }

  return {
    id: `nbw_${threadTid}_${pid}`,
    created_at: createdAt,
    in_reply_to_id: quotedPid > 0 ? `nbw_${threadTid}_${quotedPid}` : `nbw_${threadTid}`,
    in_reply_to_account_id: null,
    sensitive: false,
    mental_crisis: false,
    spoiler_text: '',
    visibility: 'public',
    language: 'zh',
    uri: threadUrl,
    url: quotedPid > 0 ? `${threadUrl}&pid=${quotedPid}` : threadUrl,
    replies_count: 0,
    reblogs_count: 0,
    favourites_count: Number(reply.support ?? 0),
    bookmarks_count: 0,
    shares_count: 0,
    views_count: 0,
    heat: 0,
    favourited: false,
    reblogged: false,
    muted: false,
    bookmarked: false,
    content: nbwReplyContentToHTML(reply.content),
    reblog: null,
    application: { name: '宝宝新天地', website: 'https://www.newbabyworld.top' },
    account,
    media_attachments: attachments,
    mentions: [],
    tags: [],
    emojis: [],
    card: null,
    poll: null,
    quote,
  }
}

/** NBW 回复正文 → HTML：剥离附加与遗留 bbcode，只保留纯文本并自动链接化 */
function nbwReplyContentToHTML(text?: string): string {
  let t = String(text ?? '').replace(/\r\n?/g, '\n')
  // [attach] 标签内容由 attachment_list 单独渲染，正文里移除
  t = t.replace(/\[attach(?:img)?\][\s\S]*?\[\/attach(?:img)?\]/gi, '')
  // 其余 bbcode（[quote] 已被合作方剥离，这里兜底）统一剥掉标签
  t = t.replace(/\[[/a-zA-Z0-9=#"' .\-_]+\]/g, '')
  t = t.replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, '')
  return formatContent(t)
}

function unixToISO(value?: number | string): string {
  if (value == null || value === '') return new Date().toISOString()
  if (typeof value === 'string' && value.includes('T')) return value
  const n = typeof value === 'number' ? value : parseInt(value, 10)
  if (!Number.isFinite(n) || n <= 0) return new Date().toISOString()
  // 10-digit unix seconds
  return new Date(n < 1e12 ? n * 1000 : n).toISOString()
}

/** NBW thread dates may be Unix timestamps or Chinese relative times. */
export function nbwThreadDateToISO(value?: number | string, now = Date.now()): string {
  if (value == null || value === '') return new Date(now).toISOString()
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value).trim())) return unixToISO(value)

  const raw = stripHtml(String(value)).replace(/\s+/g, '')
  if (raw === '刚刚') return new Date(now).toISOString()

  const relative = raw.match(/^(\d+)(秒钟?|分钟?|小时|天)前$/)
  if (relative) {
    const amount = Number(relative[1])
    const unitMs = relative[2].startsWith('秒') ? 1000
      : relative[2].startsWith('分') ? 60_000
        : relative[2] === '小时' ? 3_600_000 : 86_400_000
    return new Date(now - amount * unitMs).toISOString()
  }

  // NBW uses China Standard Time for absolute forum timestamps.
  const absolute = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:日)?(?:([0-2]?\d):([0-5]\d)(?::([0-5]\d))?)?$/)
  if (absolute) {
    const [, year, month, day, hour = '0', minute = '0', second = '0'] = absolute
    const timestamp = Date.parse(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute}:${second}+08:00`)
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString()
  }

  return new Date(now).toISOString()
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const URL_TLDS = 'com|net|org|cn|top|xyz|io|dev|app|co|me|cc|info|edu|gov|club|online|site|tech|store|blog|work|live|video|social|design|shop|icu|ltd|fun|space|host|press|link|buzz|pro|vip|wang|ren'
  html = html.replace(/(?<!href=")(?<!:\/\/)(?<![a-zA-Z0-9])((?:[a-zA-Z0-9][a-zA-Z0-9-]*\.){0,2}[a-zA-Z0-9][a-zA-Z0-9-]+\.)(?:${URL_TLDS})(?:\/[^\s<>]*)?/g, (match, domain, tld) => {
    const full = domain + tld
    const rest = match.substring(full.length)
    return `<a href="https://${full}${rest}" rel="nofollow noopener noreferrer" target="_blank">${full}${rest}</a>`
  })

  // Convert #hashtags
  // eslint-disable-next-line no-useless-escape
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

/** Batch query verified status for a list of user IDs */
export async function getVerifiedUserIds(db: D1Database, userIds: number[]): Promise<Set<number>> {
  if (userIds.length === 0) return new Set()
  const rows = await query<{ user_id: number }>(
    db,
    `SELECT user_id FROM user_badges WHERE badge_key = 'verified' AND user_id IN (${userIds.map(() => '?').join(',')})`,
    userIds,
  )
  return new Set(rows.map(r => r.user_id))
}

/** 批量查询用户展示中的徽章（每用户至多一枚），供帖子流 account.badge 使用 */
export async function getDisplayedBadges(
  db: D1Database,
  userIds: number[],
): Promise<Map<number, { name: string; color: string }>> {
  const result = new Map<number, { name: string; color: string }>()
  const ids = [...new Set(userIds)].filter(Boolean)
  if (ids.length === 0) return result
  const rows = await query<{ user_id: number; name: string; color: string }>(
    db,
    `SELECT ub.user_id, b.name, b.color
     FROM user_badges ub JOIN badges b ON ub.badge_key = b.key
     WHERE ub.displayed = 1 AND ub.user_id IN (${ids.map(() => '?').join(',')})
     ORDER BY ub.unlocked_at DESC`,
    ids,
  )
  for (const r of rows) {
    if (!result.has(r.user_id)) result.set(r.user_id, { name: r.name, color: r.color })
  }
  return result
}

/** 给一批状态（含转帖）的 account 附加展示徽章 */
export async function attachDisplayedBadges<T extends { account: MastodonAccount; reblog?: MastodonStatus | null }>(
  db: D1Database,
  statuses: T[],
): Promise<void> {
  const ids: number[] = []
  for (const s of statuses) {
    for (const a of [s.account, s.reblog?.account]) {
      if (a?.id) {
        const n = Number(a.id)
        if (Number.isFinite(n)) ids.push(n)
      }
    }
  }
  if (ids.length === 0) return
  const map = await getDisplayedBadges(db, ids)
  for (const s of statuses) {
    for (const a of [s.account, s.reblog?.account]) {
      if (a?.id) {
        const badge = map.get(Number(a.id))
        if (badge) a.badge = badge
      }
    }
  }
}

interface AlbumPostRow {
  post_id: number
  owner_id: number
  visibility: string
  album_id: string
  album_name: string | null
  description: string | null
  photo_count: number
  preview_key: string | null
  width: number | null
  height: number | null
  deleted_at: number | null
  download_protected: number
}

type AlbumPostEnv = Pick<Env, 'abdl_space_db' | 'COS_SECRET_ID' | 'COS_SECRET_KEY' | 'COS_BUCKET' | 'COS_REGION'>

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function albumFallback(status: Record<string, unknown>): void {
  status.content = formatContent(ALBUM_POST_FALLBACK)
  status.media_attachments = []
  status.card = null
  status.poll = null
  status.tags = []
  status.spoiler_text = ''
  if ('text' in status) status.text = ALBUM_POST_FALLBACK
}

/** Remove dynamic album payloads before caching or returning a snapshot, regardless of response size. */
export function stripCachedAlbumPostUpdates(payload: unknown): void {
  const pending: unknown[] = [payload]
  const seen = new Set<object>()
  while (pending.length) {
    const value = pending.pop()
    if (!value || typeof value !== 'object' || seen.has(value)) continue
    seen.add(value)
    if (Array.isArray(value)) { for (const child of value) pending.push(child); continue }
    if (!isRecord(value)) continue
    const cached = 'album_update' in value
    delete value.album_update
    if (isRecord(value.account) && Array.isArray(value.media_attachments) && typeof value.content === 'string'
      && (cached || value.content === formatContent(ALBUM_POST_FALLBACK))) albumFallback(value)
    for (const child of Object.values(value)) pending.push(child)
  }
}

/** Refresh nested status album cards from live visibility, never trusting cached response metadata.
 * The bounded response middleware calls this for profile, timelines, detail, search and notifications.
 * Missing migration/read/signing failures omit cards and log unavailability without breaking old fixtures.
 */
export async function hydrateAlbumPostUpdates(env: AlbumPostEnv, payload: unknown, native: boolean): Promise<boolean> {
  const statuses = new Map<number, Record<string, unknown>[]>()
  const pending: unknown[] = [payload]
  const seen = new Set<object>()
  const changed = { value: false }
  while (pending.length) {
    const value = pending.pop()
    if (!value || typeof value !== 'object' || seen.has(value)) continue
    seen.add(value)
    if (Array.isArray(value)) { for (const child of value) pending.push(child); continue }
    if (!isRecord(value)) continue
    for (const child of Object.values(value)) pending.push(child)
    if (!isRecord(value.account) || typeof value.content !== 'string' || !Array.isArray(value.media_attachments)) continue
    if ('album_update' in value || value.content === formatContent(ALBUM_POST_FALLBACK)) {
      delete value.album_update
      albumFallback(value)
      changed.value = true
    }
    const match = typeof value.id === 'string' ? /^p_([1-9][0-9]*)$/.exec(value.id) : null
    const id = match ? Number(match[1]) : 0
    if (!Number.isSafeInteger(id) || id <= 0 || (!statuses.has(id) && statuses.size >= 500)) continue
    statuses.set(id, [...statuses.get(id) ?? [], value])
  }
  const ids = [...statuses.keys()]
  if (!ids.length) return changed.value
  const signedCovers = new Map<number, { key: string; url: string }>()
  try {
    for (let offset = 0; offset < ids.length; offset += 80) {
      const chunk = ids.slice(offset, offset + 80)
      const rows = await query<AlbumPostRow>(env.abdl_space_db, `SELECT b.post_id, a.owner_id, a.visibility, a.id AS album_id,
        CASE WHEN a.visibility='public' THEN a.name END AS album_name,
        CASE WHEN a.visibility='public' THEN b.description END AS description,
        (SELECT count(*) FROM album_photos active WHERE active.batch_id=b.id AND active.deleted_at IS NULL) AS photo_count,
        CASE WHEN a.visibility='public' THEN p.preview_key END AS preview_key,
        CASE WHEN a.visibility='public' THEN p.width END AS width,
        CASE WHEN a.visibility='public' THEN p.height END AS height,
        a.deleted_at AS deleted_at, coalesce(protection.download_protected,0) AS download_protected
        FROM album_batches b JOIN albums a ON a.id=b.album_id AND a.owner_id=b.owner_id
        LEFT JOIN album_protection protection ON protection.album_id=a.id
        LEFT JOIN album_photos p ON p.id=(SELECT cover.id FROM album_photos cover
          WHERE cover.batch_id=b.id AND cover.owner_id=a.owner_id AND cover.deleted_at IS NULL
            AND NOT EXISTS(SELECT 1 FROM album_photo_blocks blk WHERE blk.album_id=cover.album_id AND blk.photo_id=cover.id)
          ORDER BY cover.sort_order, cover.id LIMIT 1)
        WHERE b.status='published' AND b.post_id IN (${chunk.map(() => '?').join(',')})`, chunk)
      for (const row of rows) {
        const targets = statuses.get(row.post_id) ?? []
        for (const status of targets) { delete status.album_update; albumFallback(status) }
        changed.value = true
        if (!native || row.visibility !== 'public' || row.deleted_at !== null || !row.preview_key || !row.album_name || row.photo_count < 1) continue
        // An album key is never a public URL and must remain in the server-owned owner's namespace.
        if (!row.preview_key.startsWith(`albums/${row.owner_id}/`)) continue
        if (row.download_protected) {
          signedCovers.set(row.post_id, { key: row.preview_key, url: '' })
          continue
        }
        const authorization = await createCosGetAuthorization({
          secretId: env.COS_SECRET_ID, secretKey: env.COS_SECRET_KEY, bucket: env.COS_BUCKET, region: env.COS_REGION,
          objectKey: row.preview_key, contentType: 'application/octet-stream', expiresInSeconds: 60,
        })
        signedCovers.set(row.post_id, { key: row.preview_key, url: authorization.url })
      }
    }
    // Signing is asynchronous. Re-read current public state AFTER every signature, not cached titles/ACL.
    const signedIds = [...signedCovers.keys()]
    for (let offset = 0; offset < signedIds.length; offset += 80) {
      const chunk = signedIds.slice(offset, offset + 80)
      const current = await query<AlbumPostRow>(env.abdl_space_db, `SELECT b.post_id,a.owner_id,a.visibility,a.id AS album_id,
        a.name AS album_name,b.description,
        (SELECT count(*) FROM album_photos active WHERE active.batch_id=b.id AND active.deleted_at IS NULL) AS photo_count,
        p.preview_key,p.width,p.height,a.deleted_at,coalesce(protection.download_protected,0) AS download_protected
        FROM album_batches b JOIN albums a ON a.id=b.album_id AND a.owner_id=b.owner_id
        LEFT JOIN album_protection protection ON protection.album_id=a.id
        JOIN album_photos p ON p.id=(SELECT cover.id FROM album_photos cover WHERE cover.batch_id=b.id
          AND cover.owner_id=a.owner_id AND cover.deleted_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM album_photo_blocks blk WHERE blk.album_id=cover.album_id AND blk.photo_id=cover.id)
          ORDER BY cover.sort_order,cover.id LIMIT 1)
        WHERE b.status='published' AND a.visibility='public' AND a.deleted_at IS NULL
        AND b.post_id IN (${chunk.map(() => '?').join(',')})`, chunk)
      for (const row of current) {
        const cover = signedCovers.get(row.post_id)
        if (!cover || cover.key !== row.preview_key || !row.album_name || row.photo_count < 1 || !row.width || !row.height || (!row.download_protected && !cover.url)) continue
        const metadata: AlbumPostUpdate = { album_id: row.album_id, album_name: row.album_name, description: row.description ?? '',
          photo_count: row.photo_count, cover_url: row.download_protected ? '' : cover.url, width: row.width, height: row.height, download_protected: !!row.download_protected }
        for (const status of statuses.get(row.post_id) ?? []) {
          if (isRecord(status.account) && Number(status.account.id) === row.owner_id) status.album_update = metadata
        }
      }
    }
  } catch {
    // Previously attached cards must not survive partial failure or an unavailable migration.
    for (const targets of statuses.values()) for (const status of targets) delete status.album_update
    console.warn(JSON.stringify({ event: 'album_post_metadata_unavailable' }))
  }
  return changed.value
}

/** Bounded final-response hydration leaves pagination/CORS headers and unrelated JSON intact. */
export async function hydrateAlbumPostResponse(env: AlbumPostEnv, response: Response, native: boolean): Promise<Response> {
  if (!response.ok || !response.headers.get('Content-Type')?.includes('application/json') || !response.body) return response
  const maxBytes = 2 * 1024 * 1024
  if (Number(response.headers.get('Content-Length')) > maxBytes) return response
  const reader = response.clone().body!.getReader()
  const chunks: Uint8Array[] = []
  const size = { bytes: 0 }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size.bytes += value.byteLength
      if (size.bytes > maxBytes) { void reader.cancel().catch(() => {}); return response }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size.bytes)
    const position = { offset: 0 }
    for (const chunk of chunks) { bytes.set(chunk, position.offset); position.offset += chunk.byteLength }
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (!await hydrateAlbumPostUpdates(env, payload, native)) return response
    const headers = new Headers(response.headers)
    headers.delete('Content-Length')
    headers.delete('ETag')
    headers.set('Cache-Control', 'private, no-store')
    return new Response(JSON.stringify(payload), { status: response.status, statusText: response.statusText, headers })
  } catch {
    console.warn(JSON.stringify({ event: 'album_post_response_unavailable' }))
    return response
  } finally {
    reader.releaseLock()
  }
}
