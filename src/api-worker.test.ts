import assert from 'node:assert/strict'
import test from 'node:test'

import { handleScheduled } from './lib/scheduled.ts'

test('scheduled keeps outbox dispatch and private cleanup in separate waitUntil work', async () => {
	const sent: number[] = []
	const waited: Promise<unknown>[] = []
	const db = {
		prepare(sql: string) {
			return {
				bind() { return this },
				async all() {
					if (sql.includes('message_outbox')) return { success: true, results: [{ event_id: 7 }] }
					if (sql.includes('private_books')) return { success: true, results: [] }
					return { success: true, results: [] }
				},
			}
		},
	}
	const env = {
		abdl_space_db: db,
		MESSAGE_OUTBOX_QUEUE: { async send(message: { eventId: number }) { sent.push(message.eventId) } },
		NOVEL_COS_SECRET_ID: 'private-id',
		NOVEL_COS_SECRET_KEY: 'private-key',
		NOVEL_PRIVATE_COS_BUCKET: 'private-bucket-123',
		NOVEL_PRIVATE_COS_REGION: 'ap-shanghai',
	}
	const ctx = { waitUntil(promise: Promise<unknown>) { waited.push(promise) } }

	await handleScheduled({ scheduledTime: Date.now() } as ScheduledController, env as never, ctx as ExecutionContext)
	assert.deepEqual(sent, [7])
	assert.equal(waited.length, 1)
	await Promise.all(waited)
})
