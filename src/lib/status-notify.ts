import type { Env } from '../types/index.ts'
import { query, run } from './db.ts'
import { sendJPushNotification, sendJPushToUsers } from './jpush.ts'

const MENTION_RE = /@([A-Za-z0-9_\u4e00-\u9fa5·]{1,32})/g
// JPush audience 单次上限 1000；通知表写入同批
const MAX_FOLLOWER_NOTIFY = 1000

async function insertNotification(
  env: Env,
  userId: number,
  type: string,
  message: string,
  relatedId: number,
  actorId: number,
): Promise<void> {
  await run(
    env.abdl_space_db,
    'INSERT INTO notifications (user_id, type, message, related_id, read, actor_id) VALUES (?, ?, ?, ?, 0, ?)',
    [userId, type, message, relatedId, actorId],
  )
}

/**
 * 帖子发布后的全量通知分发（由调用方通过 waitUntil 异步执行）：
 * 1. 回复通知 — in_reply_to 的作者（写 notifications 表 + JPush）
 * 2. 提及通知 — 正文中 @username 匹配到的用户，最多 10 人（写 notifications 表 + JPush）
 * 3. 粉丝新帖通知 — 关注作者的用户（仅 JPush，不进通知中心；direct 私信不发）
 */
export async function dispatchStatusNotifications(
  env: Env,
  postId: number,
  authorId: number,
  authorUsername: string,
  content: string,
  inReplyToAccountId: number | null,
  visibility: string,
): Promise<void> {
  try {
    const notified = new Set<number>([authorId])

    // 1. 回复通知
    if (inReplyToAccountId && !notified.has(inReplyToAccountId)) {
      notified.add(inReplyToAccountId)
      const message = `${authorUsername} 回复了你`
      await insertNotification(env, inReplyToAccountId, 'reply', message, postId, authorId)
      await sendJPushNotification(env, inReplyToAccountId, '新回复', message, { url: `/forum/${postId}`, post_id: String(postId) })
    }

    // 2. 提及通知
    const mentioned = new Set<string>()
    for (const m of content.matchAll(MENTION_RE)) {
      mentioned.add(m[1].toLowerCase())
      if (mentioned.size >= 10) break
    }
    if (mentioned.size > 0) {
      const placeholders = [...mentioned].map(() => 'lower(?)').join(',')
      const users = await query<{ id: number }>(
        env.abdl_space_db,
        `SELECT id FROM users WHERE lower(username) IN (${placeholders})`,
        [...mentioned],
      )
      for (const u of users) {
        if (notified.has(u.id)) continue
        notified.add(u.id)
        const message = `${authorUsername} 在帖子中提到了你`
        await insertNotification(env, u.id, 'mention', message, postId, authorId)
        await sendJPushNotification(env, u.id, '帖子提及', message, { url: `/forum/${postId}`, post_id: String(postId) })
      }
    }

    // 3. 粉丝新帖通知（仅 JPush 横幅；direct 可见性不发）
    if (visibility !== 'direct') {
      const followers = await query<{ follower_id: number }>(
        env.abdl_space_db,
        `SELECT follower_id FROM follows WHERE following_id = ? LIMIT ${MAX_FOLLOWER_NOTIFY}`,
        [authorId],
      )
      const targets = followers.map(f => f.follower_id).filter(id => !notified.has(id))
      if (targets.length > 0) {
        await sendJPushToUsers(
          env, targets, '关注动态',
          `${authorUsername} 发布了新帖子`,
          { url: `/forum/${postId}`, post_id: String(postId) },
        )
      }
    }
  } catch (e) {
    console.error('Status notification dispatch failed:', { postId, error: String(e) })
  }
}
