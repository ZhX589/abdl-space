import type { Env } from '../types/index.ts'
import { cleanupPrivateNovelObjects } from '../routes/novel-private.ts'

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
}
