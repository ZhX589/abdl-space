import { Hono } from 'hono'
import type { Env } from '../types/index.ts'
import { sendJPushBroadcast } from '../lib/jpush.ts'

type AppType = { Bindings: Env }

const broadcast = new Hono<AppType>()

// 应急通知通道 — 全流程零数据库读取，数据库限流/事故期间仍可用。
// 鉴权用独立的 BROADCAST_KEY（不查 oauth_tokens / users，避免依赖 DB）。
// 部署：npx wrangler secret put BROADCAST_KEY --name abdl-space-api
broadcast.post('/', async (c) => {
  const key = c.env.BROADCAST_KEY
  if (!key) {
    return c.json({ error: 'BROADCAST_KEY not configured' }, 503)
  }
  const provided = c.req.header('X-Broadcast-Key')
  if (!provided || provided !== key) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

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

export default broadcast