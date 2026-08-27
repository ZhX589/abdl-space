import type { Env } from '../types/index.ts'
import type { Context } from 'hono'
import { nbwS2SRequest } from '../lib/nbw.ts'
import { toStatusFromNBW } from './converter.ts'

type NBWSyncThread = {
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
}

type NBWSyncData = {
  has_more?: boolean
  next_cursor?: string
  list?: NBWSyncThread[]
}

export type NBWTimelineParams = {
  limit: number
  fid: string
  orderby: 'dateline' | 'lastpost'
  cursor: string
  params: Record<string, string>
}

export function buildNBWTimelineParams(query: {
  limit?: string
  perpage?: string
  max_id?: string
  cursor?: string
  fid?: string
  orderby?: string
}): NBWTimelineParams {
  const limit = Math.min(40, Math.max(1, parseInt(query.limit || query.perpage || '20') || 20))
  const fid = query.fid && query.fid !== '0' ? query.fid : ''
  const orderby: 'dateline' | 'lastpost' = query.orderby === 'lastpost' ? 'lastpost' : 'dateline'
  const cursor = query.cursor || query.max_id || ''

  const params: Record<string, string> = {
    perpage: String(limit),
    orderby,
  }
  if (fid) params.fid = fid
  if (cursor) params.cursor = cursor

  return { limit, fid, orderby, cursor, params }
}

export function buildNBWTimelineNextLink(
  basePath: string,
  nextCursor: string | undefined,
  limit: number,
  fid: string,
  orderby: 'dateline' | 'lastpost',
): string | null {
  if (!nextCursor) return null
  const qs = new URLSearchParams()
  qs.set('limit', String(limit))
  qs.set('max_id', nextCursor)
  if (fid) qs.set('fid', fid)
  if (orderby !== 'dateline') qs.set('orderby', orderby)
  return `<${basePath}?${qs}>; rel="next"`
}

export function hasNextAllTimelinePage(
  abdlCount: number,
  limit: number,
  currentNBWCursor: string,
  nbwHasMore: boolean,
  nextNBWCursor: string,
): boolean {
  const nbwCanAdvance = nbwHasMore && !!nextNBWCursor && nextNBWCursor !== currentNBWCursor
  return abdlCount === limit || nbwCanAdvance
}

export async function handleNBWTimeline(
  c: Context<{ Bindings: Env }>,
  basePath: string,
): Promise<Response> {
  if (!c.env.NBW_API_KEY) {
    return c.json({ error: 'NBW API 未配置' }, 503)
  }

  const { limit, fid, orderby, cursor, params } = buildNBWTimelineParams({
    limit: c.req.query('limit'),
    perpage: c.req.query('perpage'),
    max_id: c.req.query('max_id'),
    cursor: c.req.query('cursor'),
    fid: c.req.query('fid'),
    orderby: c.req.query('orderby'),
  })

  try {
    const result = await nbwS2SRequest(c.env, 'get_sync_threads', params)
    if (result.code !== 200) {
      const status = result.code === 401 || result.code === 403 ? result.code as 401 | 403 : 502
      return c.json({ error: result.msg || 'NBW 请求失败', code: result.code }, status)
    }

    const data = (result.data || {}) as NBWSyncData
    const statuses = (data.list || []).map((t) => toStatusFromNBW(t))

    const nextLink = data.has_more
      ? buildNBWTimelineNextLink(basePath, data.next_cursor, limit, fid, orderby)
      : null
    if (nextLink) c.header('Link', nextLink)

    return c.json(statuses)
  } catch (e) {
    console.error('NBW timeline failed:', e)
    return c.json({ error: 'NBW 服务请求失败' }, 502)
  }
}
