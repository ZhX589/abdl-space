import { query } from './db.ts'

/**
 * 发送极光推送通知
 * @param db D1 数据库
 * @param userId 目标用户 ID
 * @param title 通知标题
 * @param content 通知内容
 * @param extras 附加数据
 */
export async function sendJPushNotification(
  db: D1Database,
  userId: number,
  title: string,
  content: string,
  extras: Record<string, string> = {}
): Promise<void> {
  try {
    // 查询用户的极光推送注册
    const rows = await query<{ reg_id: string }>(
      db,
      'SELECT reg_id FROM jpush_registrations WHERE user_id = ?',
      [userId]
    )

    if (rows.length === 0) return

    const regIds = rows.map(r => r.reg_id)
    const appKey = '6aa46fed3b8f49a6d26ad1a1'
    const masterSecret = '5a3ee59eb63462139a67d231'

    await fetch('https://api.jpush.cn/v3/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${btoa(`${appKey}:${masterSecret}`)}`
      },
      body: JSON.stringify({
        platform: 'all',
        audience: { registration_id: regIds },
        notification: {
          alert: content,
          title,
          android: { extras },
          ios: { extras }
        }
      })
    })
  } catch (e) {
    console.error('[JPush] 发送失败:', e)
  }
}
