/**
 * API Worker 独立入口
 * 用于部署到 api.abdl-space.top (Cloudflare Workers)
 *
 * 部署命令: npm run deploy:api
 */
import app from './index'
import type { Env, JWTPayload } from './types/index'
import { handleOutboxBatch } from './lib/outbox-dispatcher'
import { handleScheduled } from './lib/scheduled'

export { UserPresence } from './durable-objects/UserPresence'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

export default {
  async fetch(request: Request, env: AppType['Bindings'], ctx: ExecutionContext): Promise<Response> {
    // 网页管理面板会在 API 路径末尾多带一个 "/"，Hono 默认严格匹配会返回 404；
    // 分发前剥掉尾部斜杠（保留 "/"），不重定向、不改写方法（避免 POST 因 301 被降级为 GET）。
    const url = new URL(request.url)
    if (url.pathname.length > 1) {
      const trimmed = url.pathname.replace(/\/+$/, '')
      if (trimmed !== url.pathname) {
        url.pathname = trimmed
        return app.fetch(new Request(url.toString(), request), env, ctx)
      }
    }
    return app.fetch(request, env, ctx)
  },

  async queue(batch: MessageBatch<OutboxMessage>, env: Env): Promise<void> {
    await handleOutboxBatch(env, batch)
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleScheduled(controller, env, ctx)
  },
}

interface OutboxMessage {
  eventId: number
}
