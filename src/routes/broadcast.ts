import { Hono } from 'hono'
import type { Env } from '../types/index.ts'
import { sendJPushBroadcast } from '../lib/jpush.ts'
import { cacheGet, cacheSet, cacheDelete } from '../lib/ttl-cache.ts'

type AppType = { Bindings: Env }

const broadcast = new Hono<AppType>()

// 应急通知通道 — 全流程零数据库读取，数据库限流/事故期间仍可用。
// 鉴权用独立的 BROADCAST_KEY（不查 oauth_tokens / users，避免依赖 DB）。
// 部署：npx wrangler secret put BROADCAST_KEY --name abdl-space-api

/** 共享鉴权：返回 null 表示未配置密钥（503），false 表示密钥不匹配（401），true 表示通过 */
function checkBroadcastKey(c: { env: Env; req: { header: (name: string) => string | undefined } }): boolean | null {
  const key = c.env.BROADCAST_KEY
  if (!key) return null
  const provided = c.req.header('X-Broadcast-Key')
  if (!provided || provided !== key) return false
  return true
}

function authError(c: { json: (body: unknown, init?: number) => unknown }, result: boolean | null) {
  if (result === null) return c.json({ error: 'BROADCAST_KEY not configured' }, 503)
  return c.json({ error: 'Unauthorized' }, 401)
}

broadcast.post('/', async (c) => {
  const auth = checkBroadcastKey(c)
  if (auth !== true) return authError(c, auth)

  let body: { title?: string; content?: string }
  try {
    body = await c.req.json<{ title?: string; content?: string }>()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  const title = typeof body.title === 'string' ? body.title.slice(0, 60) : 'ABDL Space 通知'
  const content = typeof body.content === 'string' ? body.content.slice(0, 500) : ''
  if (!content) {
    return c.json({ error: 'content is required' }, 400)
  }

  const ok = await sendJPushBroadcast(c.env, title, content)
  if (!ok) {
    return c.json({ error: 'JPush broadcast failed' }, 502)
  }
  return c.json({ success: true, audience: 'all' })
})

// ============================================================
// 服务公告（service notice）— 持久化于 Cloudflare KV，零 D1。
// 限流/事故期间 App 冷启动拉取由此端点，不触碰数据库。
// ============================================================

const NOTICE_KV_KEY = 'notice:current'
const NOTICE_CACHE_TTL_MS = 30_000 // GET 侧内存缓存，进一步减少 KV 读
const NOTICE_TITLE_MAX = 60
const NOTICE_CONTENT_MAX = 500

interface ServiceNotice {
  id: string
  title: string
  content: string
  /** epoch 秒；null = 立即生效 */
  startAt: number | null
  /** epoch 秒；null = 不自动过期 */
  endAt: number | null
  createdAt: number
  updatedAt: number
}

function isValidEpoch(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0
}

/** 读取当前公告原始 JSON（先查内存缓存，再读 KV） */
async function readNoticeRaw(kv: KVNamespace): Promise<string | null> {
  const cached = cacheGet<string>(NOTICE_KV_KEY)
  if (cached !== undefined) return cached
  const raw = await kv.get(NOTICE_KV_KEY)
  if (raw) cacheSet(NOTICE_KV_KEY, raw, NOTICE_CACHE_TTL_MS)
  return raw
}

// GET /api/broadcast/notice — 返回当前生效中的公告（无公告/未到时间/已过期 → notice:null）
broadcast.get('/notice', async (c) => {
  const kv = c.env.NOTICE_KV
  if (!kv) {
    // KV 未绑定：不视为错误，App 端按「无公告」静默处理
    return c.json({ notice: null })
  }
  let raw: string | null
  try {
    raw = await readNoticeRaw(kv)
  } catch {
    return c.json({ notice: null })
  }
  if (!raw) return c.json({ notice: null })

  let notice: ServiceNotice
  try {
    notice = JSON.parse(raw) as ServiceNotice
  } catch {
    return c.json({ notice: null })
  }
  const now = Math.floor(Date.now() / 1000)
  if (notice.startAt && now < notice.startAt) return c.json({ notice: null })
  if (notice.endAt && now > notice.endAt) return c.json({ notice: null })
  return c.json({ notice })
})

// POST /api/broadcast/notice — 发布/更新公告（写入 KV；默认顺带 JPush 全量推送）
broadcast.post('/notice', async (c) => {
  const auth = checkBroadcastKey(c)
  if (auth !== true) return authError(c, auth)

  let body: { title?: string; content?: string; startAt?: number; endAt?: number; push?: boolean }
  try {
    body = await c.req.json<{ title?: string; content?: string; startAt?: number; endAt?: number; push?: boolean }>()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  const title = typeof body.title === 'string' ? body.title.slice(0, NOTICE_TITLE_MAX) : ''
  const content = typeof body.content === 'string' ? body.content.slice(0, NOTICE_CONTENT_MAX) : ''
  if (!content) {
    return c.json({ error: 'content is required' }, 400)
  }
  if (body.startAt !== undefined && !isValidEpoch(body.startAt)) {
    return c.json({ error: 'startAt must be a finite number (epoch seconds)' }, 400)
  }
  if (body.endAt !== undefined && !isValidEpoch(body.endAt)) {
    return c.json({ error: 'endAt must be a finite number (epoch seconds)' }, 400)
  }
  if (body.startAt !== undefined && body.endAt !== undefined && body.endAt <= body.startAt) {
    return c.json({ error: 'endAt must be after startAt' }, 400)
  }

  const kv = c.env.NOTICE_KV
  if (!kv) {
    return c.json({ error: 'NOTICE_KV not configured' }, 503)
  }

  const now = Math.floor(Date.now() / 1000)
  const notice: ServiceNotice = {
    id: crypto.randomUUID(),
    title,
    content,
    startAt: body.startAt ?? null,
    endAt: body.endAt ?? null,
    createdAt: now,
    updatedAt: now,
  }
  try {
    await kv.put(NOTICE_KV_KEY, JSON.stringify(notice))
  } catch {
    return c.json({ error: 'KV write failed' }, 502)
  }
  cacheDelete(NOTICE_KV_KEY)

  // 默认顺带全量推送（提醒打开 App）；push:false 可关闭（如提前预置未来的公告）
  let pushed = false
  if (body.push !== false) {
    pushed = await sendJPushBroadcast(c.env, title || 'ABDL Space 公告', content)
  }
  return c.json({ success: true, notice, pushed })
})

// POST /api/broadcast/notice/clear — 撤销公告
broadcast.post('/notice/clear', async (c) => {
  const auth = checkBroadcastKey(c)
  if (auth !== true) return authError(c, auth)

  const kv = c.env.NOTICE_KV
  if (!kv) {
    return c.json({ error: 'NOTICE_KV not configured' }, 503)
  }
  try {
    await kv.delete(NOTICE_KV_KEY)
  } catch {
    return c.json({ error: 'KV delete failed' }, 502)
  }
  cacheDelete(NOTICE_KV_KEY)
  return c.json({ success: true })
})

export default broadcast