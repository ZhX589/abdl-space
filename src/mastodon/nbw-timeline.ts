import type { Env } from '../types/index.ts'
import type { Context } from 'hono'
import { NBWUnavailableError, nbwS2SRequest } from '../lib/nbw.ts'
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
  list: NBWSyncThread[]
}

/** Reject malformed upstream timeline data before conversion can break a whole native Status array. */
export function parseNBWSyncData(value: unknown): NBWSyncData {
  const invalid = () => new NBWUnavailableError('invalid_response')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const data = value as Record<string, unknown>
  if (!Array.isArray(data.list) || (data.has_more !== undefined && typeof data.has_more !== 'boolean')
    || (data.next_cursor !== undefined && typeof data.next_cursor !== 'string')) throw invalid()
  for (const item of data.list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid()
    const thread = item as Record<string, unknown>
    if (!['number', 'string'].includes(typeof thread.tid) || !Number.isSafeInteger(Number(thread.tid)) || Number(thread.tid) <= 0) throw invalid()
    for (const key of ['forum_name', 'subject', 'abstract', 'author', 'avatar']) {
      if (thread[key] != null && typeof thread[key] !== 'string') throw invalid()
    }
    if (thread.image_list != null) {
      if (!Array.isArray(thread.image_list)) throw invalid()
      for (const image of thread.image_list) {
        if (typeof image === 'string') continue
        if (!image || typeof image !== 'object' || Array.isArray(image) || typeof image.url !== 'string') throw invalid()
      }
    }
  }
  return data as NBWSyncData
}

/** Log only the failing source and bounded failure metadata, never upstream content or credentials. */
export function logNBWTimelineUnavailable(error: unknown, timeline: 'all' | 'nbw'): void {
  console.warn(JSON.stringify({ event: 'nbw_timeline_unavailable', source: 'nbw', timeline,
    reason: error instanceof NBWUnavailableError ? error.reason : 'invalid_response',
    upstream_status: error instanceof NBWUnavailableError ? error.upstreamStatus : null }))
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

  const { limit, fid, orderby, params } = buildNBWTimelineParams({
    limit: c.req.query('limit'),
    perpage: c.req.query('perpage'),
    max_id: c.req.query('max_id'),
    cursor: c.req.query('cursor'),
    fid: c.req.query('fid'),
    orderby: c.req.query('orderby'),
  })

  try {
    const result = await nbwS2SRequest(c.env, 'get_sync_threads', params, { timeoutMs: 5000, maxBytes: 2 * 1024 * 1024 })
    if (result.code !== 200) {
      const status = result.code === 401 || result.code === 403 ? result.code as 401 | 403 : 502
      return c.json({ error: result.msg || 'NBW 请求失败', code: result.code }, status)
    }

    const data = parseNBWSyncData(result.data)
    const statuses = data.list.map((t) => toStatusFromNBW(t))

    const nextLink = data.has_more
      ? buildNBWTimelineNextLink(basePath, data.next_cursor, limit, fid, orderby)
      : null
    if (nextLink) c.header('Link', nextLink)

    return c.json(statuses)
  } catch (error) {
    logNBWTimelineUnavailable(error, 'nbw')
    return c.json({ error: 'NBW 服务暂时不可用', code: 'nbw_unavailable' }, 502)
  }
}
