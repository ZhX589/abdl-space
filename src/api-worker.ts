/**
 * API Worker 独立入口
 * 用于部署到 api.abdl-space.top (Cloudflare Workers)
 *
 * 部署命令: npm run deploy:api
 */
import app from './index'
import type { Env, JWTPayload } from './types/index'
import { handleOutboxBatch } from './lib/outbox-dispatcher'

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
    // 每分钟扫描未完成 outbox 并重新入队
    const db = env.abdl_space_db
    const rows = await db.prepare(
      `SELECT event_id FROM message_outbox
       WHERE dispatched_at IS NULL AND next_attempt_at <= unixepoch()
       LIMIT 50`,
    ).all<{ event_id: number }>()

    for (const row of rows.results) {
      await env.MESSAGE_OUTBOX_QUEUE.send({ eventId: row.event_id })
    }
  },
}

interface OutboxMessage {
  eventId: number
}
