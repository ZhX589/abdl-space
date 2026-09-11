import type { Env } from '../types/index.ts'
import { cleanupPrivateNovelObjects } from '../routes/novel-private.ts'
import { runSponsorStockCron } from './sponsor-stock.ts'

export async function handleScheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
	ctx.waitUntil(cleanupPrivateNovelObjects(env, Math.floor(controller.scheduledTime / 1000), 50))
	const rows = await env.abdl_space_db.prepare(
		`SELECT event_id FROM message_outbox
		 WHERE dispatched_at IS NULL AND next_attempt_at <= unixepoch()
		 LIMIT 50`,
	).all<{ event_id: number }>()

	for (const row of rows.results) {
		await env.MESSAGE_OUTBOX_QUEUE.send({ eventId: row.event_id })
	}

	// 库存任务自带租约/开关守卫：未配置密钥或未启用时安全跳过，绝不外呼。
	try {
		await runSponsorStockCron(env)
	} catch {
		// 库存任务失败不影响既有 cron 职责；异常细节不落日志（可能含上游信息）。
	}
}
