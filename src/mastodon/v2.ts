/**
 * Mastodon v2 API + Stub endpoints
 * - GET /api/v2/search (real implementation)
 * - GET /api/v2/instance (redirect to v1)
 * - Various stub endpoints Moshidon calls on startup
 */

import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { query, queryOne } from '../lib/db.ts'
import { toAccount, toStatus } from './converter.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

async function mastodonAuth(c: { req: { header: (name: string) => string | undefined }; env: Env }): Promise<JWTPayload | null> {
  const auth = c.req.header('Authorization')
  if (!auth) return null
  const match = auth.match(/^Bearer\s+(.+)$/i)
  if (!match) return null
  const token = match[1]
  try {
    const { introspectToken } = await import('../lib/oauth.ts')
    const result = await introspectToken(c.env.abdl_space_db, token)
    if (result.active && result.sub) {
      const user = await queryOne<{ id: number; username: string; email: string; role: string }>(
        c.env.abdl_space_db, 'SELECT id, username, email, role FROM users WHERE id = ?', [result.sub]
      )
      if (user) return { sub: user.id, username: user.username, email: user.email, role: user.role, iat: 0, exp: 0 }
    }
  } catch {}
  try {
    const { verifyJWT } = await import('../lib/auth.ts')
    const payload = await verifyJWT(token, c.env.JWT_SECRET)
    if (payload) return payload
  } catch {}
  return null
}

const mastodonV2 = new Hono<AppType>()

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

  const hashtagSet = new Set<string>()
  for (const r of posts) {
    const content = r.content as string
    const regex = /#(\S+)/g
    let match
    while ((match = regex.exec(content)) !== null) {
      if (match[1].toLowerCase().includes(q.toLowerCase())) hashtagSet.add(match[1])
    }
  }
  const hashtags = [...hashtagSet].map(name => ({ name, url: `https://abdl-space.top/tags/${name}`, history: [] }))

  return c.json({ accounts, statuses, hashtags })
})

// ============================================================
// GET /api/v2/instance — redirect to v1 instance
// ============================================================
mastodonV2.get('/instance', async (c) => {
  const res = await mastodonV2.fetch(new Request(c.req.url.replace('/api/v2/instance', '/api/v1/instance'), c.req.raw), c.env)
  return res
})

export default mastodonV2
