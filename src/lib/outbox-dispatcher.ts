import type { Env } from '../types/index.ts'
import { queryOne, run } from './db.ts'
import { sendJPushToUser } from './jpush.ts'

const INSTANCE_DOMAIN = 'abdl-space.top'

interface OutboxMessage {
  eventId: number
}

/**
 * Queue consumer — 处理 outbox 事件分发
 * 对 message.new：双方 WS 广播 + receiver JPush
 * 对 message.read：双方 WS 广播，不发 JPush
 */
export async function handleOutboxBatch(env: Env, batch: MessageBatch<OutboxMessage>) {
  for (const msg of batch.messages) {
    try {
      await dispatchEvent(env, msg.body.eventId)
      msg.ack()
    } catch (e) {
      console.error(`Outbox dispatch failed for event ${msg.body.eventId}:`, e)
      msg.retry()
    }
  }
}

async function dispatchEvent(env: Env, eventId: number) {
  const db = env.abdl_space_db

  const event = await queryOne<{
    id: number; user_id: number; event_type: string; message_id: number | null;
    peer_id: number; read_up_to_id: number | null; payload: string
  }>(db, 'SELECT * FROM message_events WHERE id = ?', [eventId])

  if (!event) return

  // 推送到该用户的 UserPresence DO
  const stub = env.USER_PRESENCE.getByName(`user:${event.user_id}`)
  try {
    await stub.fetch('https://do/push', {
      method: 'POST',
      body: JSON.stringify({
        event_id: event.id,
        type: event.event_type,
        message_id: event.message_id,
        peer_id: event.peer_id,
        read_up_to_id: event.read_up_to_id,
        ...JSON.parse(event.payload),
      }),
    })
  } catch (e) {
    console.error(`WS push failed for user ${event.user_id}:`, e)
  }

  // message.new 的 receiver 额外发 JPush
  if (event.event_type === 'message.new' && event.message_id) {
    const message = await queryOne<{ sender_id: number; receiver_id: number; content: string }>(
      db, 'SELECT sender_id, receiver_id, content FROM messages WHERE id = ?', [event.message_id],
    )
    if (message && message.receiver_id === event.user_id) {
      const senderName = await queryOne<{ username: string }>(
        db, 'SELECT username FROM users WHERE id = ?', [message.sender_id],
      )
      const accountId = `${INSTANCE_DOMAIN}_${message.sender_id}`
      try {
        await sendJPushToUser(env, event.user_id,
          senderName?.username || '用户',
          message.content.substring(0, 100),
          { type: 'message', account_id: accountId, peer_id: String(message.sender_id), message_id: String(event.message_id) },
        )
      } catch (e) {
        console.error(`JPush failed for user ${event.user_id}:`, e)
      }
    }
  }

  // 标记 dispatched
  await run(db,
    'UPDATE message_outbox SET dispatched_at = unixepoch(), attempts = attempts + 1 WHERE event_id = ?',
    [eventId],
  )
}
