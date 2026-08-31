import type { Context } from 'hono'
import type { Env, MastodonStatus } from '../types/index.ts'
import { query } from '../lib/db.ts'
import { toISOString, toAccount } from './converter.ts'

const DEFAULT_AVATAR = 'https://img.abdl-space.top/file/system/1781439303787_play_store_512.png'
const FRIEND_STATUS_PREFIX = 'fr_'

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** 交友请求在合并时间线中使用的游标基数：取本页最后一个请求的 id */
export function parseFriendMaxId(raw: string | null | undefined): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  const n = parseInt(raw, 10)
  return Number.isNaN(n) ? undefined : n
}

/**
 * 拉取交友宇宙的“帖子”（交友请求），转成标准 Mastodon Status 形状
 * 额外携带 friend_request 载荷，App 端据此渲染交友卡片。
 * 分页与 ABDL 本站帖一致：按 id 滑窗（id 与 created_at 同序递增），
 * maxId 为 `fr_<id>` 中的数字 id；-1 表示该源已耗尽。
 */
export async function fetchFriendRequestPosts(
  c: Context<{ Bindings: Env }>,
  limit: number,
  maxId?: number,
): Promise<MastodonStatus[]> {
  const db = c.env.abdl_space_db

  let where = "fr.status = 'active'"
  const params: unknown[] = []
  if (maxId && maxId > 0) {
    where += ' AND fr.id < ?'
    params.push(maxId)
  }

  const rows = await query<any>(
    db,
    `SELECT fr.*, u.id as uid, u.username, u.avatar, u.display_name, u.role, u.bio, u.created_at as user_created_at
     FROM friend_requests fr
     JOIN users u ON fr.user_id = u.id
     WHERE ${where}
     ORDER BY fr.created_at DESC, fr.id DESC
     LIMIT ?`,
    [...params, limit],
  )
  if (rows.length === 0) return []

  const requestIds = (rows as any[]).map((r) => r.id as number)

  let fieldsMap = new Map<number, any[]>()
  if (requestIds.length > 0) {
    const ph = requestIds.map(() => '?').join(',')
    const fields = await query<any>(
      db,
      `SELECT * FROM friend_request_fields WHERE request_id IN (${ph}) ORDER BY sort_order`,
      requestIds,
    )
    for (const f of fields) {
      if (!fieldsMap.has(f.request_id)) fieldsMap.set(f.request_id, [])
      fieldsMap.get(f.request_id)!.push(f)
    }
  }

  let commentCountMap = new Map<number, number>()
  if (requestIds.length > 0) {
    const ph = requestIds.map(() => '?').join(',')
    const counts = await query<{ request_id: number; cnt: number }>(
      db,
      `SELECT request_id, COUNT(*) as cnt FROM friend_request_comments WHERE request_id IN (${ph}) GROUP BY request_id`,
      requestIds,
    )
    for (const c of counts) commentCountMap.set(c.request_id, c.cnt)
  }

  return (rows as any[]).map((r) => {
    const requestId = r.id as number
    const title = (r.title as string) || ''
    const description = (r.description as string) || ''
    const contentParts: string[] = []
    if (title.trim()) contentParts.push(`<p><strong>${escapeHtml(title.trim())}</strong></p>`)
    if (description.trim()) contentParts.push(`<p>${escapeHtml(description.trim())}</p>`)

    const account = toAccount({
      id: r.uid as number,
      username: r.username as string,
      display_name: r.display_name as string | null,
      avatar: r.avatar as string | null,
      role: r.role as string,
      bio: r.bio as string | null,
      created_at: r.user_created_at as string,
    })

    return {
      id: FRIEND_STATUS_PREFIX + requestId,
      created_at: toISOString(r.created_at as string),
      edited_at: toISOString(r.updated_at as string),
      in_reply_to_id: null,
      in_reply_to_account_id: null,
      sensitive: false,
      mental_crisis: false,
      spoiler_text: '',
      visibility: 'public',
      language: 'zh-CN',
      uri: `https://abdl-space.top/friend/request/${requestId}`,
      url: `https://abdl-space.top/friend/request/${requestId}`,
      replies_count: commentCountMap.get(requestId) ?? 0,
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
      pinned: false,
      content: contentParts.join(''),
      reblog: null,
      application: null,
      geo_location: null,
      account,
      media_attachments: [],
      mentions: [],
      tags: [],
      emojis: [],
      card: null,
      poll: null,
      text: null,
      // 交友专属载荷：App 端据此渲染定制卡片（非标准 Mastodon 字段）
      friend_request: {
        id: requestId,
        user_id: r.user_id,
        title: r.title,
        looking_for: r.looking_for,
        description: r.description,
        status: r.status,
        created_at: r.created_at,
        updated_at: r.updated_at,
        user: {
          id: r.uid,
          username: r.username,
          avatar: (r.avatar as string) || DEFAULT_AVATAR,
          display_name: (r.display_name as string) || (r.username as string),
        },
        fields: fieldsMap.get(requestId) || [],
        comment_count: commentCountMap.get(requestId) ?? 0,
      } as unknown,
    } as MastodonStatus
  })
}