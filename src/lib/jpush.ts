import type { Env } from '../types/index.ts'
import { query } from './db.ts'

/**
 * 内部 JPush 发送函数 — 只由 Worker 内部调用，不暴露为 HTTP 接口
 * 供 posts/follows/likes 等已有调用方使用（已迁移为接收 Env）
 */
export async function sendJPushNotification(
  env: Env,
  userId: number,
  title: string,
  content: string,
  extras: Record<string, string> = {},
): Promise<void> {
  await sendJPushToUser(env, userId, title, content, extras)
}

/**
 * 接受 Env 的内部发送函数 — 供 outbox dispatcher 使用
 */
export async function sendJPushToUser(
  env: Env,
  userId: number,
  title: string,
  content: string,
  extras: Record<string, string> = {},
): Promise<{ sent: number }> {
  const db = env.abdl_space_db
  const rows = await query<{ reg_id: string }>(
    db, 'SELECT reg_id FROM jpush_registrations WHERE user_id = ?',
    [userId],
  )
  if (rows.length === 0) return { sent: 0 }

  const regIds = rows.map(r => r.reg_id)
  const appKey = env.JPUSH_APP_KEY
  const masterSecret = env.JPUSH_MASTER_SECRET
  if (!appKey || !masterSecret) {
    console.error('JPush secrets not configured')
    return { sent: 0 }
  }

  const ok = await sendJPushRaw(regIds, title, content, extras, appKey, masterSecret)
  return { sent: ok ? regIds.length : 0 }
}

/**
 * 底层 JPush API 调用 — secrets 通过参数或全局注入
 */
async function sendJPushRaw(
  regIds: string[],
  title: string,
  content: string,
  extras: Record<string, string>,
  appKey?: string,
  masterSecret?: string,
): Promise<boolean> {
  // 如果没有传入 secrets，尝试从全局获取（兼容旧调用路径）
  // 旧路径会通过 Worker 路由的 env 传入
  if (!appKey || !masterSecret) {
    console.error('JPush secrets not provided')
    return false
  }

  const payload = {
    platform: 'all',
    audience: { registration_id: regIds },
    notification: {
      alert: content,
      android: { alert: content, title, channel_id: 'jpush_high', extras },
      ios: { alert: { title, body: content }, sound: 'default', extras },
    },
  }

  const response = await fetch('https://api.jpush.cn/v3/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${btoa(`${appKey}:${masterSecret}`)}`,
    },
    body: JSON.stringify(payload),
  })

  const result: any = await response.json()
  if (result.code !== 0) {
    console.error('JPush send failed:', result.message)
  }
  return result.code === 0
}
