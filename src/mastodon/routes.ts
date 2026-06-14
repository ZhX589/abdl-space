/**
 * Mastodon-compatible API endpoints
 * Mounted at /api/v1/*
 *
 * These endpoints do NOT touch the existing ABDL API logic.
 * They read/write the same D1 database but through their own queries.
 */

import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { query, queryOne, run } from '../lib/db.ts'
import { toAccount, toStatus, toStatusFromComment, toNotification } from './converter.ts'
import type { MastodonInstance } from './types.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

const mastodon = new Hono<AppType>()

// ============================================================
// Mastodon-compatible auth middleware (Bearer token from OAuth or JWT)
// Returns user payload if authenticated, null if not
// ============================================================
async function mastodonAuth(c: any): Promise<JWTPayload | null> {
  const auth = c.req.header('Authorization')
  if (!auth) return null

  // Try Bearer token
  const match = auth.match(/^Bearer\s+(.+)$/i)
  if (!match) return null

  const token = match[1]

  // First try OAuth access_token
  try {
    const { introspectToken } = await import('../lib/oauth.ts')
    const result = await introspectToken(c.env.abdl_space_db, token, c.env.abdl_space_db)
    if (result.active && result.sub) {
      const user = await queryOne<{ id: number; username: string; email: string; role: string }>(
        c.env.abdl_space_db, 'SELECT id, username, email, role FROM users WHERE id = ?', [result.sub]
      )
      if (user) return { sub: user.id, username: user.username, email: user.email, role: user.role, iat: 0, exp: 0 }
    }
  } catch {}

  // Fall back to JWT
  try {
    const { verifyJWT } = await import('../lib/auth.ts')
    const payload = await verifyJWT(token, c.env.JWT_SECRET)
    if (payload) return payload
  } catch {}

  return null
}

// ============================================================
// GET /api/v1/instance
// ============================================================
mastodon.get('/instance', async (c) => {
  const [userCount] = await Promise.all([
    queryOne<{ cnt: number }>(c.env.abdl_space_db, 'SELECT COUNT(*) as cnt FROM users'),
    queryOne<{ cnt: number }>(c.env.abdl_space_db, 'SELECT COUNT(*) as cnt FROM posts'),
  ])

  const instance: MastodonInstance = {
    domain: 'abdl-space.top',
    title: 'ABDL Space',
    version: '4.2.0 (compatible; ABDL Space 1.0)',
    source_url: 'https://github.com/ZYongX09/abdl-space-v2',
    description: 'ABDL Space — 纸尿裤评分社区',
    usage: { users: { active_month: userCount?.cnt ?? 0 } },
    thumbnail: { url: 'https://img.abdl-space.top/file/system/1781439303787_play_store_512.png', blurhash: null },
    languages: ['zh', 'en'],
    configuration: {
      urls: { streaming: null, status: null, about: 'https://abdl-space.top', privacy_policy: null, terms_of_service: null },
      accounts: { max_featured_tags: 10, max_pinned_statuses: 5 },
      statuses: { max_characters: 5000, max_media_attachments: 4, characters_reserved_per_url: 23 },
      media_attachments: {
        supported_mime_types: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
        image_size_limit: 5242880,
        image_matrix_limit: 33177600,
        video_size_limit: 0,
        video_frame_rate_limit: 0,
        video_matrix_limit: 0,
      },
      polls: { max_options: 4, max_characters_per_option: 50, min_expiration: 300, max_expiration: 2629746 },
    },
    registrations: { enabled: true, approval_required: false, message: null },
    rules: [],
  }

  return c.json(instance)
})

// ============================================================
// POST /api/v1/apps — Register OAuth application
// ============================================================
mastodon.post('/apps', async (c) => {
  let body: { client_name?: string; redirect_uris?: string | string[]; scopes?: string; website?: string }
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid body' }, 400) }

  const { client_name, redirect_uris, scopes, website } = body
  if (!client_name || !redirect_uris) {
    return c.json({ error: 'client_name and redirect_uris required' }, 422)
  }

  const uris = Array.isArray(redirect_uris) ? redirect_uris : [redirect_uris]
  const scope = scopes || 'read write follow push'

  // Generate client credentials
  const clientId = crypto.randomUUID().replace(/-/g, '')
  const clientSecret = crypto.randomUUID().replace(/-/g, '')
  const secretHash = await sha256(clientSecret)

  await run(
    c.env.abdl_space_db,
    `INSERT INTO oauth_clients
      (client_id, client_secret, name, redirect_uris, scopes, grant_types, token_endpoint_auth_method, owner_id, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'none', 1, 1, datetime('now'), datetime('now'))`,
    [clientId, secretHash, client_name, JSON.stringify(uris), scope, 'authorization_code,refresh_token']
  )

  return c.json({
    id: clientId,
    name: client_name,
    website: website || null,
    scopes: scope.split(' '),
    redirect_uri: uris.join('\n'),
    redirect_uris: uris,
    client_id: clientId,
    client_secret: clientSecret,
    client_secret_expires_at: 0,
    vapid_key: '',
  })
})

// ============================================================
// GET /api/v1/apps/verify_credentials
// ============================================================
mastodon.get('/apps/verify_credentials', async (c) => {
  const auth = c.req.header('Authorization')
  if (!auth) return c.json({ error: 'missing authorization' }, 401)

  return c.json({
    id: '1',
    name: 'ABDL Space',
    website: 'https://abdl-space.top',
    scopes: ['read', 'write', 'follow', 'push'],
    redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
    redirect_uris: ['urn:ietf:wg:oauth:2.0:oob'],
    client_secret_expires_at: 0,
  })
})

// ============================================================
// GET /api/v1/accounts/verify_credentials
// ============================================================
mastodon.get('/accounts/verify_credentials', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)

  const dbUser = await queryOne<Record<string, unknown>>(
    c.env.abdl_space_db,
    'SELECT id, username, avatar, role, bio, created_at FROM users WHERE id = ?',
    [user.sub]
  )
  if (!dbUser) return c.json({ error: 'User not found' }, 404)

  const [postCount, followerCount, followingCount] = await Promise.all([
    queryOne<{ cnt: number }>(c.env.abdl_space_db, 'SELECT COUNT(*) as cnt FROM posts WHERE user_id = ?', [user.sub]),
    queryOne<{ cnt: number }>(c.env.abdl_space_db, 'SELECT COUNT(*) as cnt FROM follows WHERE following_id = ?', [user.sub]),
    queryOne<{ cnt: number }>(c.env.abdl_space_db, 'SELECT COUNT(*) as cnt FROM follows WHERE follower_id = ?', [user.sub]),
  ])

  const lastPost = await queryOne<{ created_at: string }>(
    c.env.abdl_space_db, 'SELECT created_at FROM posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', [user.sub]
  )

  const account = toAccount({
    id: dbUser.id as number,
    username: dbUser.username as string,
    avatar: dbUser.avatar as string | null,
    role: dbUser.role as string,
    bio: dbUser.bio as string | null,
    created_at: dbUser.created_at as string,
  }, {
    statuses_count: postCount?.cnt ?? 0,
    followers_count: followerCount?.cnt ?? 0,
    following_count: followingCount?.cnt ?? 0,
    last_status_at: lastPost?.created_at ?? null,
  })

  // CredentialAccount has extra `source` field
  return c.json({
    ...account,
    source: {
      privacy: 'public',
      sensitive: false,
      language: 'zh',
      note: dbUser.bio || '',
      fields: [],
    },
  })
})

// ============================================================
// PATCH /api/v1/accounts/update_credentials
// ============================================================
mastodon.patch('/accounts/update_credentials', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)

  let body: Record<string, unknown>
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid body' }, 400) }

  const updates: string[] = []
  const params: unknown[] = []

  if (body.display_name !== undefined) {
    // We don't have display_name separate from username, skip or store in bio
  }
  if (body.note !== undefined) {
    updates.push('bio = ?')
    params.push(String(body.note).replace(/<[^>]*>/g, '').substring(0, 500))
  }
  if (body.avatar !== undefined) {
    // Handle multipart form data — for now accept URL
    updates.push('avatar = ?')
    params.push(body.avatar)
  }

  if (updates.length > 0) {
    params.push(user.sub)
    await run(c.env.abdl_space_db, `UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params)
  }

  // Return updated account
  const dbUser = await queryOne<Record<string, unknown>>(
    c.env.abdl_space_db,
    'SELECT id, username, avatar, role, bio, created_at FROM users WHERE id = ?',
    [user.sub]
  )
  if (!dbUser) return c.json({ error: 'User not found' }, 404)

  return c.json(toAccount({
    id: dbUser.id as number,
    username: dbUser.username as string,
    avatar: dbUser.avatar as string | null,
    role: dbUser.role as string,
    bio: dbUser.bio as string | null,
    created_at: dbUser.created_at as string,
  }))
})

// ============================================================
// GET /api/v1/accounts/:id
// ============================================================
mastodon.get('/accounts/:id', async (c) => {
  const id = parseInt(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)

  const dbUser = await queryOne<Record<string, unknown>>(
    c.env.abdl_space_db,
    'SELECT id, username, avatar, role, bio, created_at FROM users WHERE id = ?',
    [id]
  )
  if (!dbUser) return c.json({ error: 'Record not found' }, 404)

  const [postCount, followerCount, followingCount] = await Promise.all([
    queryOne<{ cnt: number }>(c.env.abdl_space_db, 'SELECT COUNT(*) as cnt FROM posts WHERE user_id = ?', [id]),
    queryOne<{ cnt: number }>(c.env.abdl_space_db, 'SELECT COUNT(*) as cnt FROM follows WHERE following_id = ?', [id]),
    queryOne<{ cnt: number }>(c.env.abdl_space_db, 'SELECT COUNT(*) as cnt FROM follows WHERE follower_id = ?', [id]),
  ])

  const lastPost = await queryOne<{ created_at: string }>(
    c.env.abdl_space_db, 'SELECT created_at FROM posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', [id]
  )

  return c.json(toAccount({
    id: dbUser.id as number,
    username: dbUser.username as string,
    avatar: dbUser.avatar as string | null,
    role: dbUser.role as string,
    bio: dbUser.bio as string | null,
    created_at: dbUser.created_at as string,
  }, {
    statuses_count: postCount?.cnt ?? 0,
    followers_count: followerCount?.cnt ?? 0,
    following_count: followingCount?.cnt ?? 0,
    last_status_at: lastPost?.created_at ?? null,
  }))
})

// ============================================================
// GET /api/v1/accounts/:id/statuses
// ============================================================
mastodon.get('/accounts/:id/statuses', async (c) => {
  const id = parseInt(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)

  const limit = Math.min(40, Math.max(1, parseInt(c.req.query('limit') || '20')))
  const maxId = c.req.query('max_id')
  const sinceId = c.req.query('since_id')

  const dbUser = await queryOne<{ id: number; username: string; avatar: string | null; role: string; bio: string | null; created_at: string }>(
    c.env.abdl_space_db, 'SELECT id, username, avatar, role, bio, created_at FROM users WHERE id = ?', [id]
  )
  if (!dbUser) return c.json({ error: 'Record not found' }, 404)

  let sql = `SELECT p.*, u.username, u.avatar, u.role,
    (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
    (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comment_count
    FROM posts p JOIN users u ON p.user_id = u.id WHERE p.user_id = ?`
  const params: unknown[] = [id]

  if (maxId) { sql += ' AND p.id < ?'; params.push(parseInt(maxId)) }
  if (sinceId) { sql += ' AND p.id > ?'; params.push(parseInt(sinceId)) }

  sql += ' ORDER BY p.created_at DESC LIMIT ?'
  params.push(limit)

  const posts = await query<Record<string, unknown>>(c.env.abdl_space_db, sql, params)

  // Check which posts the current user has liked
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

  const account = toAccount(dbUser)
  const statuses = posts.map(r => toStatus({
    id: r.id as number,
    user_id: r.user_id as number,
    content: r.content as string,
    diaper_id: r.diaper_id as number | null,
    pinned: !!r.pinned,
    has_nsfw: !!r.has_nsfw,
    is_announcement: !!r.is_announcement,
    like_count: r.like_count as number,
    comment_count: r.comment_count as number,
    created_at: r.created_at as string,
  }, account, { favourited: likedSet.has(r.id as number) }))

  return c.json(statuses)
})

// ============================================================
// GET /api/v1/accounts/:id/followers
// ============================================================
mastodon.get('/accounts/:id/followers', async (c) => {
  const id = parseInt(c.req.param('id'))
  const limit = Math.min(80, Math.max(1, parseInt(c.req.query('limit') || '40')))

  const rows = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT u.id, u.username, u.avatar, u.role, u.bio, u.created_at
     FROM follows f JOIN users u ON f.follower_id = u.id
     WHERE f.following_id = ? ORDER BY f.created_at DESC LIMIT ?`,
    [id, limit]
  )

  return c.json(rows.map(r => toAccount({
    id: r.id as number, username: r.username as string, avatar: r.avatar as string | null,
    role: r.role as string, bio: r.bio as string | null, created_at: r.created_at as string,
  })))
})

// ============================================================
// GET /api/v1/accounts/:id/following
// ============================================================
mastodon.get('/accounts/:id/following', async (c) => {
  const id = parseInt(c.req.param('id'))
  const limit = Math.min(80, Math.max(1, parseInt(c.req.query('limit') || '40')))

  const rows = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT u.id, u.username, u.avatar, u.role, u.bio, u.created_at
     FROM follows f JOIN users u ON f.following_id = u.id
     WHERE f.follower_id = ? ORDER BY f.created_at DESC LIMIT ?`,
    [id, limit]
  )

  return c.json(rows.map(r => toAccount({
    id: r.id as number, username: r.username as string, avatar: r.avatar as string | null,
    role: r.role as string, bio: r.bio as string | null, created_at: r.created_at as string,
  })))
})

// ============================================================
// POST /api/v1/accounts/:id/follow
// ============================================================
mastodon.post('/accounts/:id/follow', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)

  const targetId = parseInt(c.req.param('id'))
  if (targetId === user.sub) return c.json({ error: 'Cannot follow yourself' }, 400)

  const target = await queryOne<{ id: number }>(c.env.abdl_space_db, 'SELECT id FROM users WHERE id = ?', [targetId])
  if (!target) return c.json({ error: 'Record not found' }, 404)

  const existing = await queryOne<{ id: number }>(
    c.env.abdl_space_db, 'SELECT id FROM follows WHERE follower_id = ? AND following_id = ?', [user.sub, targetId]
  )
  if (!existing) {
    await run(c.env.abdl_space_db, 'INSERT INTO follows (follower_id, following_id) VALUES (?, ?)', [user.sub, targetId])
  }

  // Return relationship
  return c.json({
    id: String(targetId),
    following: true,
    showing_reblogs: true,
    notifying: false,
    followed_by: false,
    blocking: false,
    blocked_by: false,
    muting: false,
    muting_notifications: false,
    requested: false,
    domain_blocking: false,
    endorsed: false,
    note: '',
  })
})

// ============================================================
// POST /api/v1/accounts/:id/unfollow
// ============================================================
mastodon.post('/accounts/:id/unfollow', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)

  const targetId = parseInt(c.req.param('id'))
  await run(c.env.abdl_space_db, 'DELETE FROM follows WHERE follower_id = ? AND following_id = ?', [user.sub, targetId])

  return c.json({
    id: String(targetId),
    following: false,
    showing_reblogs: true,
    notifying: false,
    followed_by: false,
    blocking: false,
    blocked_by: false,
    muting: false,
    muting_notifications: false,
    requested: false,
    domain_blocking: false,
    endorsed: false,
    note: '',
  })
})

// ============================================================
// POST /api/v1/statuses — Post a new status
// ============================================================
mastodon.post('/statuses', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)

  let body: { status?: string; media_ids?: string[]; in_reply_to_id?: string; sensitive?: boolean; visibility?: string }
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid body' }, 400) }

  const content = body.status?.trim()
  if (!content) return c.json({ error: "Validation failed: Text can't be blank" }, 422)

  const result = await run(
    c.env.abdl_space_db,
    'INSERT INTO posts (user_id, content) VALUES (?, ?)',
    [user.sub, content]
  )
  const postId = result.meta.last_row_id as number

  // Handle media attachments (images from media_ids)
  if (body.media_ids && body.media_ids.length > 0) {
    for (const mediaId of body.media_ids) {
      // media_ids in our system are just URLs or IDs — try to store them
      try {
        await run(
          c.env.abdl_space_db,
          'INSERT INTO post_images (post_id, image_url, sort_order) VALUES (?, ?, ?)',
          [postId, mediaId, 0]
        )
      } catch {}
    }
  }

  // Fetch the created post
  const post = await queryOne<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT p.*, u.username, u.avatar, u.role
     FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?`,
    [postId]
  )
  if (!post) return c.json({ error: 'Failed to create status' }, 500)

  const dbUser = await queryOne<{ id: number; username: string; avatar: string | null; role: string; bio: string | null; created_at: string }>(
    c.env.abdl_space_db, 'SELECT id, username, avatar, role, bio, created_at FROM users WHERE id = ?', [user.sub]
  )

  return c.json(toStatus({
    id: post.id as number,
    user_id: post.user_id as number,
    content: post.content as string,
    created_at: post.created_at as string,
    like_count: 0,
    comment_count: 0,
  }, toAccount(dbUser!)))
})

// ============================================================
// GET /api/v1/statuses/:id
// ============================================================
mastodon.get('/statuses/:id', async (c) => {
  const id = parseInt(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)

  const post = await queryOne<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
     (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comment_count
     FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?`,
    [id]
  )
  if (!post) return c.json({ error: 'Record not found' }, 404)

  // Get images
  const images = await query<{ image_url: string; is_nsfw: number }>(
    c.env.abdl_space_db, 'SELECT image_url, is_nsfw FROM post_images WHERE post_id = ? ORDER BY sort_order', [id]
  )

  const account = toAccount({
    id: post.user_id as number, username: post.username as string, avatar: post.avatar as string | null,
    role: post.role as string, bio: post.bio as string | null, created_at: post.user_created_at as string,
  })

  return c.json(toStatus({
    id: post.id as number,
    user_id: post.user_id as number,
    content: post.content as string,
    diaper_id: post.diaper_id as number | null,
    pinned: !!post.pinned,
    has_nsfw: !!post.has_nsfw,
    like_count: post.like_count as number,
    comment_count: post.comment_count as number,
    created_at: post.created_at as string,
    images,
  }, account))
})

// ============================================================
// DELETE /api/v1/statuses/:id
// ============================================================
mastodon.delete('/statuses/:id', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)

  const id = parseInt(c.req.param('id'))
  const post = await queryOne<{ id: number; user_id: number }>(
    c.env.abdl_space_db, 'SELECT id, user_id FROM posts WHERE id = ?', [id]
  )
  if (!post) return c.json({ error: 'Record not found' }, 404)
  if (post.user_id !== user.sub && user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403)

  await run(c.env.abdl_space_db, 'DELETE FROM posts WHERE id = ?', [id])

  // Return minimal status for delete-and-redraft
  return c.json({
    id: String(id),
    text: '',
    media_attachments: [],
    poll: null,
  })
})

// ============================================================
// POST /api/v1/statuses/:id/favourite
// ============================================================
mastodon.post('/statuses/:id/favourite', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)

  const id = parseInt(c.req.param('id'))
  const post = await queryOne<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
     (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comment_count
     FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?`,
    [id]
  )
  if (!post) return c.json({ error: 'Record not found' }, 404)

  const existing = await queryOne<{ user_id: number }>(
    c.env.abdl_space_db, 'SELECT user_id FROM likes WHERE user_id = ? AND target_type = ? AND target_id = ?',
    [user.sub, 'post', id]
  )
  if (!existing) {
    await run(c.env.abdl_space_db, 'INSERT INTO likes (user_id, target_type, target_id) VALUES (?, ?, ?)', [user.sub, 'post', id])
  }

  const account = toAccount({
    id: post.user_id as number, username: post.username as string, avatar: post.avatar as string | null,
    role: post.role as string, bio: post.bio as string | null, created_at: post.user_created_at as string,
  })

  return c.json(toStatus({
    id: post.id as number, user_id: post.user_id as number, content: post.content as string,
    diaper_id: post.diaper_id as number | null, like_count: (post.like_count as number) + (existing ? 0 : 1),
    comment_count: post.comment_count as number, created_at: post.created_at as string,
  }, account, { favourited: true }))
})

// ============================================================
// POST /api/v1/statuses/:id/unfavourite
// ============================================================
mastodon.post('/statuses/:id/unfavourite', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)

  const id = parseInt(c.req.param('id'))
  await run(c.env.abdl_space_db, 'DELETE FROM likes WHERE user_id = ? AND target_type = ? AND target_id = ?', [user.sub, 'post', id])

  const post = await queryOne<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
     (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comment_count
     FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?`,
    [id]
  )
  if (!post) return c.json({ error: 'Record not found' }, 404)

  const account = toAccount({
    id: post.user_id as number, username: post.username as string, avatar: post.avatar as string | null,
    role: post.role as string, bio: post.bio as string | null, created_at: post.user_created_at as string,
  })

  return c.json(toStatus({
    id: post.id as number, user_id: post.user_id as number, content: post.content as string,
    diaper_id: post.diaper_id as number | null, like_count: post.like_count as number,
    comment_count: post.comment_count as number, created_at: post.created_at as string,
  }, account, { favourited: false }))
})

// ============================================================
// POST /api/v1/statuses/:id/reblog
// ============================================================
mastodon.post('/statuses/:id/reblog', async (c) => {
  // ABDL Space doesn't have reblog, treat as no-op
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)

  const id = parseInt(c.req.param('id'))
  const post = await queryOne<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
     (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comment_count
     FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?`,
    [id]
  )
  if (!post) return c.json({ error: 'Record not found' }, 404)

  const account = toAccount({
    id: post.user_id as number, username: post.username as string, avatar: post.avatar as string | null,
    role: post.role as string, bio: post.bio as string | null, created_at: post.user_created_at as string,
  })

  return c.json(toStatus({
    id: post.id as number, user_id: post.user_id as number, content: post.content as string,
    like_count: post.like_count as number, comment_count: post.comment_count as number,
    created_at: post.created_at as string,
  }, account, { reblogged: true }))
})

// ============================================================
// POST /api/v1/statuses/:id/unreblog
// ============================================================
mastodon.post('/statuses/:id/unreblog', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)

  const id = parseInt(c.req.param('id'))
  const post = await queryOne<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
     (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comment_count
     FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?`,
    [id]
  )
  if (!post) return c.json({ error: 'Record not found' }, 404)

  const account = toAccount({
    id: post.user_id as number, username: post.username as string, avatar: post.avatar as string | null,
    role: post.role as string, bio: post.bio as string | null, created_at: post.user_created_at as string,
  })

  return c.json(toStatus({
    id: post.id as number, user_id: post.user_id as number, content: post.content as string,
    like_count: post.like_count as number, comment_count: post.comment_count as number,
    created_at: post.created_at as string,
  }, account, { reblogged: false }))
})

// ============================================================
// GET /api/v1/timelines/home
// ============================================================
mastodon.get('/timelines/home', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)

  const limit = Math.min(40, Math.max(1, parseInt(c.req.query('limit') || '20')))
  const maxId = c.req.query('max_id')
  const sinceId = c.req.query('since_id')

  // Home timeline = posts from followed users + own posts
  let sql = `SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
    (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
    (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comment_count
    FROM posts p JOIN users u ON p.user_id = u.id
    WHERE (p.user_id = ? OR p.user_id IN (SELECT following_id FROM follows WHERE follower_id = ?))`
  const params: unknown[] = [user.sub, user.sub]

  if (maxId) { sql += ' AND p.id < ?'; params.push(parseInt(maxId)) }
  if (sinceId) { sql += ' AND p.id > ?'; params.push(parseInt(sinceId)) }

  sql += ' ORDER BY p.created_at DESC LIMIT ?'
  params.push(limit)

  const posts = await query<Record<string, unknown>>(c.env.abdl_space_db, sql, params)

  // Check which posts the current user has liked
  const postIds = posts.map(r => r.id as number)
  const likedSet = new Set<number>()
  if (postIds.length > 0) {
    const liked = await query<{ target_id: number }>(
      c.env.abdl_space_db,
      `SELECT target_id FROM likes WHERE user_id = ? AND target_type = 'post' AND target_id IN (${postIds.map(() => '?').join(',')})`,
      [user.sub, ...postIds]
    )
    for (const l of liked) likedSet.add(l.target_id)
  }

  return c.json(posts.map(r => {
    const account = toAccount({
      id: r.user_id as number, username: r.username as string, avatar: r.avatar as string | null,
      role: r.role as string, bio: r.bio as string | null, created_at: r.user_created_at as string,
    })
    return toStatus({
      id: r.id as number, user_id: r.user_id as number, content: r.content as string,
      diaper_id: r.diaper_id as number | null, like_count: r.like_count as number,
      comment_count: r.comment_count as number, created_at: r.created_at as string,
    }, account, { favourited: likedSet.has(r.id as number) })
  }))
})

// ============================================================
// GET /api/v1/timelines/public
// ============================================================
mastodon.get('/timelines/public', async (c) => {
  const limit = Math.min(40, Math.max(1, parseInt(c.req.query('limit') || '20')))
  const maxId = c.req.query('max_id')
  const sinceId = c.req.query('since_id')

  let sql = `SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
    (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
    (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comment_count
    FROM posts p JOIN users u ON p.user_id = u.id WHERE 1=1`
  const params: unknown[] = []

  if (maxId) { sql += ' AND p.id < ?'; params.push(parseInt(maxId)) }
  if (sinceId) { sql += ' AND p.id > ?'; params.push(parseInt(sinceId)) }

  sql += ' ORDER BY p.created_at DESC LIMIT ?'
  params.push(limit)

  const posts = await query<Record<string, unknown>>(c.env.abdl_space_db, sql, params)

  // Check which posts the current user has liked (if authenticated)
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

  return c.json(posts.map(r => {
    const account = toAccount({
      id: r.user_id as number, username: r.username as string, avatar: r.avatar as string | null,
      role: r.role as string, bio: r.bio as string | null, created_at: r.user_created_at as string,
    })
    return toStatus({
      id: r.id as number, user_id: r.user_id as number, content: r.content as string,
      diaper_id: r.diaper_id as number | null, like_count: r.like_count as number,
      comment_count: r.comment_count as number, created_at: r.created_at as string,
    }, account, { favourited: likedSet.has(r.id as number) })
  }))
})

// ============================================================
// GET /api/v1/timelines/tag/:hashtag
// ============================================================
mastodon.get('/timelines/tag/:hashtag', async (c) => {
  const hashtag = c.req.param('hashtag')
  const limit = Math.min(40, Math.max(1, parseInt(c.req.query('limit') || '20')))

  const posts = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
     (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comment_count
     FROM posts p JOIN users u ON p.user_id = u.id
     WHERE p.content LIKE ? ORDER BY p.created_at DESC LIMIT ?`,
    [`%#${hashtag}%`, limit]
  )

  return c.json(posts.map(r => {
    const account = toAccount({
      id: r.user_id as number, username: r.username as string, avatar: r.avatar as string | null,
      role: r.role as string, bio: r.bio as string | null, created_at: r.user_created_at as string,
    })
    return toStatus({
      id: r.id as number, user_id: r.user_id as number, content: r.content as string,
      like_count: r.like_count as number, comment_count: r.comment_count as number,
      created_at: r.created_at as string,
    }, account)
  }))
})

// ============================================================
// GET /api/v1/notifications
// ============================================================
mastodon.get('/notifications', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)

  const limit = Math.min(40, Math.max(1, parseInt(c.req.query('limit') || '20')))

  const rows = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    [user.sub, limit]
  )

  const notifs: any[] = []
  for (const r of rows) {
    // Build a minimal account for the notification source
    // We need to figure out who triggered the notification
    let sourceAccount: any = null
    let status: any = null

    if (r.type === 'follow') {
      // related_id = follower user id
      const src = await queryOne<{ id: number; username: string; avatar: string | null; role: string; created_at: string }>(
        c.env.abdl_space_db, 'SELECT id, username, avatar, role, created_at FROM users WHERE id = ?', [r.related_id]
      )
      if (src) sourceAccount = toAccount(src)
    } else if (r.type === 'like' || r.type === 'comment' || r.type === 'reply' || r.type === 'mention' || r.type === 'repost') {
      // related_id = post id (or comment id)
      const post = await queryOne<Record<string, unknown>>(
        c.env.abdl_space_db,
        `SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
         (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
         (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comment_count
         FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?`,
        [r.related_id]
      )
      if (post) {
        sourceAccount = toAccount({
          id: post.user_id as number, username: post.username as string, avatar: post.avatar as string | null,
          role: post.role as string, bio: post.bio as string | null, created_at: post.user_created_at as string,
        })
        status = toStatus({
          id: post.id as number, user_id: post.user_id as number, content: post.content as string,
          like_count: post.like_count as number, comment_count: post.comment_count as number,
          created_at: post.created_at as string,
        }, sourceAccount)
      }
    }

    if (!sourceAccount) {
      // Fallback: use a generic account
      sourceAccount = toAccount({ id: 0, username: 'system', avatar: null, role: 'user', created_at: new Date().toISOString() })
    }

    const notif = toNotification({
      id: r.id as number, type: r.type as string, message: r.message as string,
      related_id: r.related_id as number | null, read: r.read as number,
      created_at: r.created_at as string,
    }, sourceAccount, status)

    if (notif) notifs.push(notif)
  }

  return c.json(notifs)
})

// ============================================================
// POST /api/v1/media — Upload media
// ============================================================
mastodon.post('/media', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)

  const formData = await c.req.formData()
  const file = formData.get('file')
  if (!file || typeof file === 'string') {
    return c.json({ error: 'file is required' }, 422)
  }

  // Forward to img.abdl-space.top
  const IMGBED_URL = 'https://img.abdl-space.top'
  const uploadForm = new FormData()
  uploadForm.append('file', file)

  let res = await fetch(`${IMGBED_URL}/upload?returnFormat=full`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${c.env.IMGBED_UPLOAD_KEY}` },
    body: uploadForm,
  })

  if (!res.ok && c.env.IMGBED_UPLOAD_KEY) {
    const uploadForm2 = new FormData()
    uploadForm2.append('file', file)
    res = await fetch(`${IMGBED_URL}/upload?returnFormat=full&authCode=${c.env.IMGBED_UPLOAD_KEY}`, {
      method: 'POST',
      body: uploadForm2,
    })
  }

  if (!res.ok) {
    return c.json({ error: 'Upload failed' }, 500)
  }

  const data = await res.json() as { src: string }[]
  const url = data[0]?.src
  if (!url) return c.json({ error: 'Upload failed' }, 500)

  return c.json({
    id: url,
    type: 'image',
    url,
    preview_url: url,
    remote_url: null,
    text_url: null,
    meta: {},
    description: null,
    blurhash: null,
  })
})

// ============================================================
// GET /api/v1/search
// ============================================================
mastodon.get('/search', async (c) => {
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
  const statuses = posts.map(r => {
    const account = toAccount({
      id: r.user_id as number, username: r.username as string, avatar: r.avatar as string | null,
      role: r.role as string, bio: r.bio as string | null, created_at: r.user_created_at as string,
    })
    return toStatus({
      id: r.id as number, user_id: r.user_id as number, content: r.content as string,
      like_count: r.like_count as number, comment_count: r.comment_count as number,
      created_at: r.created_at as string,
    }, account)
  })

  // Extract hashtags from search results
  const hashtagSet = new Set<string>()
  for (const r of posts) {
    const content = r.content as string
    const regex = /#(\S+)/g
    let match
    while ((match = regex.exec(content)) !== null) {
      if (match[1].toLowerCase().includes(q.toLowerCase())) {
        hashtagSet.add(match[1])
      }
    }
  }
  const hashtags = [...hashtagSet].map(name => ({ name, url: `https://abdl-space.top/tags/${name}`, history: [] }))

  return c.json({ accounts, statuses, hashtags })
})

// ============================================================
// GET /api/v1/conversations
// ============================================================
mastodon.get('/conversations', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)

  const rows = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT other_id, content as last_msg, created_at as last_time, msg_id
     FROM (
       SELECT
         CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END as other_id,
         content, created_at, id as msg_id,
         ROW_NUMBER() OVER (
           PARTITION BY CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END
           ORDER BY created_at DESC
         ) as rn
       FROM messages
       WHERE sender_id = ? OR receiver_id = ?
     ) WHERE rn = 1 ORDER BY last_time DESC LIMIT 20`,
    [user.sub, user.sub, user.sub, user.sub]
  )

  const conversations = []
  for (const r of rows) {
    const otherUser = await queryOne<{ id: number; username: string; avatar: string | null; role: string; bio: string | null; created_at: string }>(
      c.env.abdl_space_db, 'SELECT id, username, avatar, role, bio, created_at FROM users WHERE id = ?', [r.other_id]
    )
    if (!otherUser) continue

    const lastStatus = await queryOne<Record<string, unknown>>(
      c.env.abdl_space_db,
      `SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
       (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
       (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comment_count
       FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?`,
      [r.msg_id]
    )

    conversations.push({
      id: String(r.msg_id),
      accounts: [toAccount(otherUser)],
      last_status: lastStatus ? toStatus({
        id: lastStatus.id as number, user_id: lastStatus.user_id as number,
        content: lastStatus.content as string,
        like_count: lastStatus.like_count as number,
        comment_count: lastStatus.comment_count as number,
        created_at: lastStatus.created_at as string,
      }, toAccount(otherUser)) : null,
      unread: true,
    })
  }

  return c.json(conversations)
})

// ============================================================
// GET /api/v1/favourites (not implemented, return empty)
// ============================================================
mastodon.get('/favourites', async (c) => {
  return c.json([])
})

// ============================================================
// GET /api/v1/bookmarks (not implemented, return empty)
// ============================================================
mastodon.get('/bookmarks', async (c) => {
  return c.json([])
})

// ============================================================
// POST /api/v1/statuses/:id/context
// ============================================================
mastodon.get('/statuses/:id/context', async (c) => {
  const id = parseInt(c.req.param('id'))

  // Get the post to find its post_id
  const post = await queryOne<{ id: number; user_id: number }>(
    c.env.abdl_space_db, 'SELECT id, user_id FROM posts WHERE id = ?', [id]
  )
  if (!post) return c.json({ error: 'Record not found' }, 404)

  // Get comments as descendants
  const comments = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT pc.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'comment' AND target_id = pc.id) as like_count
     FROM post_comments pc JOIN users u ON pc.user_id = u.id
     WHERE pc.post_id = ? ORDER BY pc.created_at ASC`,
    [id]
  )

  const ancestors: any[] = []
  const descendants = comments.map(r => {
    const account = toAccount({
      id: r.user_id as number, username: r.username as string, avatar: r.avatar as string | null,
      role: r.role as string, bio: r.bio as string | null, created_at: r.user_created_at as string,
    })
    return toStatusFromComment({
      id: r.id as number, post_id: r.post_id as number, user_id: r.user_id as number,
      parent_id: r.parent_id as number | null, content: r.content as string,
      like_count: r.like_count as number, created_at: r.created_at as string,
    }, account)
  })

  return c.json({ ancestors, descendants })
})

// ============================================================
// GET /api/v1/accounts/relationships
// ============================================================
mastodon.get('/accounts/relationships', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)

  const ids = c.req.query('id[]')
  if (!ids) return c.json([])

  const idList = Array.isArray(ids) ? ids.map(Number) : [Number(ids)]
  const relationships = []

  for (const targetId of idList) {
    if (isNaN(targetId)) continue
    const [following, follower] = await Promise.all([
      queryOne<{ id: number }>(c.env.abdl_space_db, 'SELECT id FROM follows WHERE follower_id = ? AND following_id = ?', [user.sub, targetId]),
      queryOne<{ id: number }>(c.env.abdl_space_db, 'SELECT id FROM follows WHERE follower_id = ? AND following_id = ?', [targetId, user.sub]),
    ])

    relationships.push({
      id: String(targetId),
      following: !!following,
      showing_reblogs: true,
      notifying: false,
      followed_by: !!follower,
      blocking: false,
      blocked_by: false,
      muting: false,
      muting_notifications: false,
      requested: false,
      domain_blocking: false,
      endorsed: false,
      note: '',
    })
  }

  return c.json(relationships)
})

// ============================================================
// GET /api/v2/search
// ============================================================
mastodon.get('/v2/search', async (c) => {
  // Redirect to v1 search (same behavior)
  return mastodon.fetch(new Request(c.req.url.replace('/v2/search', '/v1/search'), c.req.raw), c.env)
})

export default mastodon
