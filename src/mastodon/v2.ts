/**
 * Mastodon v2 API endpoints
 * Mounted at /api/v2/*
 */

import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { query } from '../lib/db.ts'
import { toAccount, toStatus } from './converter.ts'
import { mastodonAuth, buildInstance } from './shared.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const mastodonV2 = new Hono<AppType>()

// ============================================================
// GET /api/v2/instance
// ============================================================
mastodonV2.get('/instance', async (c) => {
  return c.json(await buildInstance(c.env.abdl_space_db))
})

// ============================================================
// GET /api/v2/search — Mastodon v2 search (Moshidon uses this)
// ============================================================
mastodonV2.get('/search', async (c) => {
  const q = c.req.query('q') || ''
  if (!q || q.length < 2) return c.json({ accounts: [], statuses: [], hashtags: [] })

  const likePattern = `%${q}%`

  const [users, posts] = await Promise.all([
    query<{ id: number; username: string; avatar: string | null; role: string; bio: string | null; created_at: string }>(
      c.env.abdl_space_db, 'SELECT id, username, avatar, role, bio, created_at FROM users WHERE username LIKE ? LIMIT 10', [likePattern]
    ),
    query<Record<string, unknown>>(
      c.env.abdl_space_db,
      `SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
       (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
       (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comment_count
       FROM posts p JOIN users u ON p.user_id = u.id
       WHERE p.content LIKE ? ORDER BY p.created_at DESC LIMIT 10`,
      [likePattern]
    ),
  ])

  const accounts = users.map(u => toAccount(u))
  const user = await mastodonAuth(c)
  const likedSet = new Set<number>()
  if (user) {
    const postIds = posts.map(r => r.id as number)
    if (postIds.length > 0) {
      const liked = await query<{ target_id: number }>(
        c.env.abdl_space_db,
        `SELECT target_id FROM likes WHERE user_id = ? AND target_type = 'post' AND target_id IN (${postIds.map(() => '?').join(',')})`,
        [user.sub, ...postIds]
      )
      for (const l of liked) likedSet.add(l.target_id)
    }
  }

  const statuses = posts.map(r => {
    const account = toAccount({
      id: r.user_id as number, username: r.username as string, avatar: r.avatar as string | null,
      role: r.role as string, bio: r.bio as string | null, created_at: r.user_created_at as string,
    })
    return toStatus({
      id: r.id as number, user_id: r.user_id as number, content: r.content as string,
      like_count: r.like_count as number, comment_count: r.comment_count as number,
      created_at: r.created_at as string,
    }, account, { favourited: likedSet.has(r.id as number) })
  })

  // Extract hashtags (consistent regex with converter.ts)
  const hashtagSet = new Set<string>()
  for (const r of posts) {
    const content = r.content as string
    const regex = /#([\w\u4e00-\u9fa5]+)/g
    let match
    while ((match = regex.exec(content)) !== null) {
      if (match[1].toLowerCase().includes(q.toLowerCase())) hashtagSet.add(match[1])
    }
  }
  const hashtags = [...hashtagSet].map(name => ({ name, url: `https://abdl-space.top/tags/${name}`, history: [] }))

  return c.json({ accounts, statuses, hashtags })
})

export default mastodonV2
