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
