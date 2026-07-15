import { Hono } from 'hono'
import type { Env, JWTPayload, LikeRequest } from '../types/index.ts'
import { queryOne, query, run } from '../lib/db.ts'
import { authMiddleware } from '../middleware/auth.ts'
import { getBeijingDate } from '../shared/time.ts'
import { sendJPushNotification } from '../lib/jpush.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const likes = new Hono<AppType>()

/**
 * POST /api/likes — 点赞/取消点赞（toggle）
 */
likes.post('/', authMiddleware, async (c) => {
  const user = c.get('user')
  const body = await c.req.json<LikeRequest>()
  const { target_type, target_id } = body

  if (!target_type || !target_id) {
    return c.json({ error: 'target_type and target_id are required' }, 400)
  }
  if (target_type !== 'post' && target_type !== 'comment') {
    return c.json({ error: 'target_type must be post or comment' }, 400)
  }

  const tableMap: Record<string, string> = { post: 'posts', comment: 'post_comments' }
  const table = tableMap[target_type]
  if (!table) return c.json({ error: 'Invalid target_type' }, 400)

  const targetId = parseInt(String(target_id))
  if (!targetId || targetId < 1) return c.json({ error: 'Invalid target_id' }, 400)

  const target = await queryOne<{ id: number }>(
    c.env.abdl_space_db,
    `SELECT id FROM ${table} WHERE id = ?`,
    [targetId]
  )
  if (!target) return c.json({ error: 'Target not found' }, 404)

  const existing = await queryOne<{ user_id: number }>(
    c.env.abdl_space_db,
    'SELECT user_id FROM likes WHERE user_id = ? AND target_type = ? AND target_id = ?',
    [user.sub, target_type, target_id]
  )

  if (existing) {
    // 取消点赞：删除记录，扣回创作者的经验/积分
    await run(
      c.env.abdl_space_db,
      'DELETE FROM likes WHERE user_id = ? AND target_type = ? AND target_id = ?',
      [user.sub, target_type, target_id]
    )

    // 记录取消点赞时间（用于 5 分钟冷却）
    await run(
      c.env.abdl_space_db,
      "INSERT OR REPLACE INTO rate_limits (key, count, window_start, expires_at) VALUES (?, 1, datetime('now'), datetime('now', '+5 minutes'))",
      [`unlike:${user.sub}:${target_type}:${target_id}`]
    )

    // 扣回创作者从该点赞获得的经验/积分
    let contentAuthorId: number | null = null
    if (target_type === 'post') {
      const post = await queryOne<{ user_id: number }>(c.env.abdl_space_db, 'SELECT user_id FROM posts WHERE id = ?', [target_id])
      if (post) contentAuthorId = post.user_id
    } else {
      const comment = await queryOne<{ user_id: number }>(c.env.abdl_space_db, 'SELECT user_id FROM post_comments WHERE id = ?', [target_id])
      if (comment) contentAuthorId = comment.user_id
    }

    if (contentAuthorId && contentAuthorId !== user.sub) {
      // 查询该点赞给创作者带来的经验/积分
      const expLog = await queryOne<{ amount: number }>(
        c.env.abdl_space_db,
        "SELECT amount FROM exp_logs WHERE user_id = ? AND type = 'like_received' AND source_type = ? AND source_id = ? ORDER BY id DESC LIMIT 1",
        [contentAuthorId, target_type, target_id]
      )
      const pointLog = await queryOne<{ amount: number }>(
        c.env.abdl_space_db,
        "SELECT amount FROM point_logs WHERE user_id = ? AND type = 'like_received' AND source_type = ? AND source_id = ? ORDER BY id DESC LIMIT 1",
        [contentAuthorId, target_type, target_id]
      )

      const expDeduct = Math.abs(expLog?.amount || 0)
      const pointDeduct = Math.abs(pointLog?.amount || 0)

      if (expDeduct > 0 || pointDeduct > 0) {
        await c.env.abdl_space_db.batch([
          c.env.abdl_space_db.prepare(
            'UPDATE experience SET current_exp = MAX(0, current_exp - ?), total_exp = MAX(0, total_exp - ?) WHERE user_id = ?'
          ).bind(expDeduct, expDeduct, contentAuthorId),
          c.env.abdl_space_db.prepare(
            "INSERT INTO exp_logs (user_id, amount, type, source_type, source_id, description) VALUES (?, ?, 'unlike', ?, ?, ?)"
          ).bind(contentAuthorId, -expDeduct, target_type, target_id, '点赞取消扣回'),
          c.env.abdl_space_db.prepare(
            'UPDATE points SET balance = MAX(0, balance - ?), total_spent = total_spent + ? WHERE user_id = ?'
          ).bind(pointDeduct, pointDeduct, contentAuthorId),
          c.env.abdl_space_db.prepare(
            "INSERT INTO point_logs (user_id, amount, type, source_type, source_id, description) VALUES (?, ?, 'unlike', ?, ?, ?)"
          ).bind(contentAuthorId, -pointDeduct, target_type, target_id, '点赞取消扣回'),
        ])
      }
    }

    return c.json({ liked: false })
  }

  // 检查 5 分钟冷却（取消点赞后 5 分钟内不可重新点赞同一内容）
  const recentUnlike = await queryOne<{ key: string }>(
    c.env.abdl_space_db,
    "SELECT key FROM rate_limits WHERE key = ? AND expires_at > datetime('now')",
    [`unlike:${user.sub}:${target_type}:${target_id}`]
  )
  if (recentUnlike) {
    return c.json({ error: '取消点赞后 5 分钟内不可重新点赞' }, 429)
  }

  await run(
    c.env.abdl_space_db,
    'INSERT INTO likes (user_id, target_type, target_id) VALUES (?, ?, ?)',
    [user.sub, target_type, target_id]
  )

  // 获取目标内容作者
  let contentAuthorId: number | null = null
  let notificationRelatedId: number | null = null

  if (target_type === 'post') {
    const post = await queryOne<{ user_id: number }>(
      c.env.abdl_space_db,
      'SELECT user_id FROM posts WHERE id = ?',
      [target_id]
    )
    if (post) {
      contentAuthorId = post.user_id
      notificationRelatedId = target_id
    }
  } else {
    const comment = await queryOne<{ user_id: number; post_id: number }>(
      c.env.abdl_space_db,
      'SELECT user_id, post_id FROM post_comments WHERE id = ?',
      [target_id]
    )
    if (comment) {
      contentAuthorId = comment.user_id
      notificationRelatedId = comment.post_id
    }
  }

  // 给内容作者发通知和奖励（不给自己发）
  if (contentAuthorId && contentAuthorId !== user.sub) {
    // 发通知
    await run(
      c.env.abdl_space_db,
      'INSERT INTO notifications (user_id, type, message, related_id, actor_id) VALUES (?, ?, ?, ?, ?)',
      [contentAuthorId, 'like', `${user.username} 赞了你的${target_type === 'post' ? '帖子' : '评论'}`, notificationRelatedId, user.sub]
    )

    // 发送极光推送通知
    sendJPushNotification(
      c.env,
      contentAuthorId,
      '收到点赞',
      `${user.username} 赞了你的${target_type === 'post' ? '帖子' : '评论'}`,
      { url: `/forum/${notificationRelatedId}` }
    )

    // 点赞奖励：经验 +3，积分 +3（每日上限 30 经验 = 10 个赞）
    const LIKE_EXP = 3
    const LIKE_POINTS = 3
    const today = getBeijingDate()

    // 检查今日收到的点赞经验是否已达上限
    const todayLikeExp = await queryOne<{ total: number }>(
      c.env.abdl_space_db,
      "SELECT COALESCE(SUM(amount), 0) as total FROM exp_logs WHERE user_id = ? AND type = 'like_received' AND date(created_at) = date('now', 'localtime')",
      [contentAuthorId]
    )

    if ((todayLikeExp?.total || 0) < 30) {
      // 原子写入经验流水（防竞态）
      const expResult = await c.env.abdl_space_db.prepare(
        "INSERT INTO exp_logs (user_id, amount, type, source_type, source_id, description) SELECT ?, '3', 'like_received', ?, ?, ? WHERE COALESCE((SELECT SUM(amount) FROM exp_logs WHERE user_id = ? AND type = 'like_received' AND date(created_at) = date('now', 'localtime')), 0) + 3 <= 30"
      ).bind(contentAuthorId, target_type, target_id, '收到点赞', contentAuthorId).run()

      if (expResult.meta.changes > 0) {
        // 更新经验余额
        await run(
          c.env.abdl_space_db,
          'UPDATE experience SET current_exp = current_exp + ?, total_exp = total_exp + ? WHERE user_id = ?',
          [LIKE_EXP, LIKE_EXP, contentAuthorId]
        )

        // 积分奖励（同样上限）
        const todayLikePoints = await queryOne<{ total: number }>(
          c.env.abdl_space_db,
          "SELECT COALESCE(SUM(amount), 0) as total FROM point_logs WHERE user_id = ? AND type = 'like_received' AND date(created_at) = date('now', 'localtime')",
          [contentAuthorId]
        )

        if ((todayLikePoints?.total || 0) < 30) {
          const pointResult = await c.env.abdl_space_db.prepare(
            "INSERT INTO point_logs (user_id, amount, type, source_type, source_id, description) SELECT ?, '3', 'like_received', ?, ?, ? WHERE COALESCE((SELECT SUM(amount) FROM point_logs WHERE user_id = ? AND type = 'like_received' AND date(created_at) = date('now', 'localtime')), 0) + 3 <= 30"
          ).bind(contentAuthorId, target_type, target_id, '收到点赞', contentAuthorId).run()

          if (pointResult.meta.changes > 0) {
            await run(
              c.env.abdl_space_db,
              'UPDATE points SET balance = balance + ?, total_earned = total_earned + ? WHERE user_id = ?',
              [LIKE_POINTS, LIKE_POINTS, contentAuthorId]
            )
          }
        }
      }
    }
  }

  return c.json({ liked: true })
})

export default likes
