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
import type { MastodonNotification, MastodonAccount, MastodonStatus } from './types.ts'
import { mastodonAuth, buildInstance, resolveStatus, parseMastoIdForCursor } from './shared.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Build Mastodon Link header for cursor-based pagination */
function buildLinkHeader(
  baseUrl: string,
  items: { id: string | number }[],
  limit: number,
  queryParams: Record<string, string> = {}
): string | null {
  if (items.length === 0) return null

  const links: string[] = []
  const makeUrl = (maxId?: string, minId?: string) => {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(queryParams)) {
      if (v) params.set(k, v)
    }
    if (maxId) params.set('max_id', maxId)
    if (minId) params.set('min_id', minId)
    const qs = params.toString()
    return qs ? `${baseUrl}?${qs}` : baseUrl
  }

  // next: use last item's id as max_id
  if (items.length >= limit) {
    const lastId = items[items.length - 1].id
    links.push(`<${makeUrl(String(lastId))}>; rel="next"`)
  }
  // prev: use first item's id as min_id
  const firstId = items[0].id
  links.push(`<${makeUrl(undefined, String(firstId))}>; rel="prev"`)

  return links.join(', ')
}

const mastodon = new Hono<AppType>()

const IMGBED_HOST = 'https://img.abdl-space.top'

// ============================================================
// GET /api/v1/instance
// ============================================================
mastodon.get('/instance', async (c) => {
  return c.json(await buildInstance(c.env.abdl_space_db))
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
  // Map Mastodon scopes to our OAuth scopes
  // Mastodon: read, write, follow, push
  // Ours: profile, email, read, write, admin
  const rawScope = scopes || 'read write'
  const mappedScopes = rawScope.split(' ')
    .map(s => s.trim().toLowerCase())
    .map(s => {
      if (s === 'follow' || s === 'push') return 'write'
      if (s === 'read' || s === 'write' || s === 'profile' || s === 'email' || s === 'admin') return s
      return null
    })
    .filter(Boolean)
  const uniqueScopes = [...new Set(mappedScopes)]
  const scope = uniqueScopes.join(' ')

  // Generate client credentials (must match oauth.ts format: oc_ + 32 hex)
  const clientId = 'oc_' + Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('')
  const clientSecret = Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2, '0')).join('')
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
    scopes: uniqueScopes,
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

  let body: Record<string, unknown> = {}
  const contentType = c.req.header('Content-Type') || ''

  // P1#10: Support both JSON and multipart/form-data
  if (contentType.includes('multipart/form-data') || contentType.includes('application/x-www-form-urlencoded')) {
    try {
      const formData = await c.req.formData()
      for (const [key, value] of formData.entries()) {
        // Handle nested keys like fields_attributes[0][name]
        if (key.startsWith('fields_attributes')) continue
        body[key] = value
      }
    } catch {}
  } else {
    try { body = await c.req.json() } catch { return c.json({ error: 'invalid body' }, 400) }
  }

  const updates: string[] = []
  const params: unknown[] = []

  if (body.display_name !== undefined) {
    // Store display_name as part of bio header or ignore gracefully
  }
  if (body.note !== undefined) {
    updates.push('bio = ?')
    params.push(String(body.note).replace(/<[^>]*>/g, '').substring(0, 500))
  }
  if (body.avatar !== undefined) {
    updates.push('avatar = ?')
    params.push(String(body.avatar))
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

  if (maxId) { sql += ' AND p.id < ?'; params.push(parseMastoIdForCursor(maxId) ?? 0) }
  if (sinceId) { sql += ' AND p.id > ?'; params.push(parseMastoIdForCursor(sinceId) ?? 0) }

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

  const link = buildLinkHeader(`/api/v1/accounts/${id}/statuses`, statuses, limit, { only_media: c.req.query('only_media') || '' })
  if (link) c.header('Link', link)
  return c.json(statuses)
})

// ============================================================
// GET /api/v1/accounts/:id/followers
// ============================================================
mastodon.get('/accounts/:id/followers', async (c) => {
  const id = parseInt(c.req.param('id'))
  const limit = Math.min(80, Math.max(1, parseInt(c.req.query('limit') || '40')))
  const maxId = c.req.query('max_id')
  const sinceId = c.req.query('since_id')

  let sql = `SELECT u.id, u.username, u.avatar, u.role, u.bio, u.created_at, f.id as follow_id
     FROM follows f JOIN users u ON f.follower_id = u.id
     WHERE f.following_id = ?`
  const params: unknown[] = [id]

  if (maxId) { sql += ' AND f.id < ?'; params.push(parseMastoIdForCursor(maxId) ?? 0) }
  if (sinceId) { sql += ' AND f.id > ?'; params.push(parseMastoIdForCursor(sinceId) ?? 0) }

  sql += ' ORDER BY f.created_at DESC LIMIT ?'
  params.push(limit)

  const rows = await query<Record<string, unknown>>(c.env.abdl_space_db, sql, params)

  const accounts = rows.map(r => toAccount({
    id: r.id as number, username: r.username as string, avatar: r.avatar as string | null,
    role: r.role as string, bio: r.bio as string | null, created_at: r.created_at as string,
  }))
  // Use follow_id for Link header cursor
  const linkItems = rows.map(r => ({ id: r.follow_id as number }))
  const link = buildLinkHeader(`/api/v1/accounts/${id}/followers`, linkItems, limit)
  if (link) c.header('Link', link)
  return c.json(accounts)
})

// ============================================================
// GET /api/v1/accounts/:id/following
// ============================================================
mastodon.get('/accounts/:id/following', async (c) => {
  const id = parseInt(c.req.param('id'))
  const limit = Math.min(80, Math.max(1, parseInt(c.req.query('limit') || '40')))
  const maxId = c.req.query('max_id')
  const sinceId = c.req.query('since_id')

  let sql = `SELECT u.id, u.username, u.avatar, u.role, u.bio, u.created_at, f.id as follow_id
     FROM follows f JOIN users u ON f.following_id = u.id
     WHERE f.follower_id = ?`
  const params: unknown[] = [id]

  if (maxId) { sql += ' AND f.id < ?'; params.push(parseMastoIdForCursor(maxId) ?? 0) }
  if (sinceId) { sql += ' AND f.id > ?'; params.push(parseMastoIdForCursor(sinceId) ?? 0) }

  sql += ' ORDER BY f.created_at DESC LIMIT ?'
  params.push(limit)

  const rows = await query<Record<string, unknown>>(c.env.abdl_space_db, sql, params)

  const accounts = rows.map(r => toAccount({
    id: r.id as number, username: r.username as string, avatar: r.avatar as string | null,
    role: r.role as string, bio: r.bio as string | null, created_at: r.created_at as string,
  }))
  const linkItems = rows.map(r => ({ id: r.follow_id as number }))
  const link = buildLinkHeader(`/api/v1/accounts/${id}/following`, linkItems, limit)
  if (link) c.header('Link', link)
  return c.json(accounts)
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
    let sortOrder = 0
    for (const mediaId of body.media_ids) {
      if (typeof mediaId !== 'string' || !mediaId) continue
      // Validate: must be a URL from our image host
      if (!mediaId.startsWith(IMGBED_HOST + '/')) continue
      try {
        await run(c.env.abdl_space_db, 'INSERT INTO post_images (post_id, image_url, sort_order) VALUES (?, ?, ?)', [postId, mediaId, sortOrder++])
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
  const rawId = c.req.param('id')
  const resolved = await resolveStatus(c.env.abdl_space_db, rawId)
  if (!resolved) return c.json({ error: 'Record not found' }, 404)

  if (resolved.kind === 'comment') {
    const comment = await queryOne<Record<string, unknown>>(
      c.env.abdl_space_db,
      `SELECT pc.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
       (SELECT COUNT(*) FROM likes WHERE target_type = 'comment' AND target_id = pc.id) as like_count
       FROM post_comments pc JOIN users u ON pc.user_id = u.id WHERE pc.id = ?`,
      [resolved.realId]
    )
    if (!comment) return c.json({ error: 'Record not found' }, 404)
    const account = toAccount({
      id: comment.user_id as number, username: comment.username as string, avatar: comment.avatar as string | null,
      role: comment.role as string, bio: comment.bio as string | null, created_at: comment.user_created_at as string,
    })
    return c.json(toStatusFromComment({
      id: comment.id as number, post_id: comment.post_id as number, user_id: comment.user_id as number,
      parent_id: comment.parent_id as number | null, content: comment.content as string,
      like_count: comment.like_count as number, created_at: comment.created_at as string,
    }, account))
  }

  const post = await queryOne<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
     (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comment_count
     FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?`,
    [resolved.realId]
  )
  if (!post) return c.json({ error: 'Record not found' }, 404)

  const images = await query<{ image_url: string; is_nsfw: number }>(
    c.env.abdl_space_db, 'SELECT image_url, is_nsfw FROM post_images WHERE post_id = ? ORDER BY sort_order', [resolved.realId]
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

  const rawId = c.req.param('id')
  const resolved = await resolveStatus(c.env.abdl_space_db, rawId)
  if (!resolved) return c.json({ error: 'Record not found' }, 404)

  if (resolved.kind === 'comment') {
    const comment = await queryOne<{ id: number; user_id: number }>(c.env.abdl_space_db, 'SELECT id, user_id FROM post_comments WHERE id = ?', [resolved.realId])
    if (!comment) return c.json({ error: 'Record not found' }, 404)
    if (comment.user_id !== user.sub && user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403)
    await run(c.env.abdl_space_db, 'DELETE FROM post_comments WHERE id = ?', [resolved.realId])
    return c.json({ id: rawId, text: '', media_attachments: [], poll: null })
  }

  const post = await queryOne<{ id: number; user_id: number }>(c.env.abdl_space_db, 'SELECT id, user_id FROM posts WHERE id = ?', [resolved.realId])
  if (!post) return c.json({ error: 'Record not found' }, 404)
  if (post.user_id !== user.sub && user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403)
  await run(c.env.abdl_space_db, 'DELETE FROM posts WHERE id = ?', [resolved.realId])
  return c.json({ id: rawId, text: '', media_attachments: [], poll: null })
})

// ============================================================
// POST /api/v1/statuses/:id/favourite
// ============================================================
mastodon.post('/statuses/:id/favourite', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)

  const rawId = c.req.param('id')
  const resolved = await resolveStatus(c.env.abdl_space_db, rawId)
  if (!resolved) return c.json({ error: 'Record not found' }, 404)

  const targetType = resolved.kind === 'comment' ? 'comment' : 'post'
  if (!await queryOne(c.env.abdl_space_db, 'SELECT user_id FROM likes WHERE user_id = ? AND target_type = ? AND target_id = ?', [user.sub, targetType, resolved.realId])) {
    await run(c.env.abdl_space_db, 'INSERT INTO likes (user_id, target_type, target_id) VALUES (?, ?, ?)', [user.sub, targetType, resolved.realId])
  }

  // Return the status
  if (resolved.kind === 'comment') {
    const comment = await queryOne<Record<string, unknown>>(c.env.abdl_space_db,
      `SELECT pc.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
       (SELECT COUNT(*) FROM likes WHERE target_type = 'comment' AND target_id = pc.id) as like_count
       FROM post_comments pc JOIN users u ON pc.user_id = u.id WHERE pc.id = ?`, [resolved.realId])
    if (!comment) return c.json({ error: 'Record not found' }, 404)
    const account = toAccount({ id: comment.user_id as number, username: comment.username as string, avatar: comment.avatar as string | null, role: comment.role as string, bio: comment.bio as string | null, created_at: comment.user_created_at as string })
    return c.json(toStatusFromComment({ id: comment.id as number, post_id: comment.post_id as number, user_id: comment.user_id as number, parent_id: comment.parent_id as number | null, content: comment.content as string, like_count: comment.like_count as number, created_at: comment.created_at as string }, account))
  }

  const post = await queryOne<Record<string, unknown>>(c.env.abdl_space_db,
    `SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
     (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comment_count
     FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?`, [resolved.realId])
  if (!post) return c.json({ error: 'Record not found' }, 404)
  const account = toAccount({ id: post.user_id as number, username: post.username as string, avatar: post.avatar as string | null, role: post.role as string, bio: post.bio as string | null, created_at: post.user_created_at as string })
  return c.json(toStatus({ id: post.id as number, user_id: post.user_id as number, content: post.content as string, like_count: post.like_count as number, comment_count: post.comment_count as number, created_at: post.created_at as string }, account, { favourited: true }))
})

// ============================================================
// POST /api/v1/statuses/:id/unfavourite
// ============================================================
mastodon.post('/statuses/:id/unfavourite', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)

  const rawId = c.req.param('id')
  const resolved = await resolveStatus(c.env.abdl_space_db, rawId)
  if (!resolved) return c.json({ error: 'Record not found' }, 404)

  const targetType = resolved.kind === 'comment' ? 'comment' : 'post'
  await run(c.env.abdl_space_db, 'DELETE FROM likes WHERE user_id = ? AND target_type = ? AND target_id = ?', [user.sub, targetType, resolved.realId])

  if (resolved.kind === 'comment') {
    const comment = await queryOne<Record<string, unknown>>(c.env.abdl_space_db,
      `SELECT pc.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
       (SELECT COUNT(*) FROM likes WHERE target_type = 'comment' AND target_id = pc.id) as like_count
       FROM post_comments pc JOIN users u ON pc.user_id = u.id WHERE pc.id = ?`, [resolved.realId])
    if (!comment) return c.json({ error: 'Record not found' }, 404)
    const account = toAccount({ id: comment.user_id as number, username: comment.username as string, avatar: comment.avatar as string | null, role: comment.role as string, bio: comment.bio as string | null, created_at: comment.user_created_at as string })
    return c.json(toStatusFromComment({ id: comment.id as number, post_id: comment.post_id as number, user_id: comment.user_id as number, parent_id: comment.parent_id as number | null, content: comment.content as string, like_count: comment.like_count as number, created_at: comment.created_at as string }, account))
  }

  const post = await queryOne<Record<string, unknown>>(c.env.abdl_space_db,
    `SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
     (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comment_count
     FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?`, [resolved.realId])
  if (!post) return c.json({ error: 'Record not found' }, 404)
  const account = toAccount({ id: post.user_id as number, username: post.username as string, avatar: post.avatar as string | null, role: post.role as string, bio: post.bio as string | null, created_at: post.user_created_at as string })
  return c.json(toStatus({ id: post.id as number, user_id: post.user_id as number, content: post.content as string, like_count: post.like_count as number, comment_count: post.comment_count as number, created_at: post.created_at as string }, account, { favourited: false }))
})

// ============================================================
// POST /api/v1/statuses/:id/reblog
// ============================================================
mastodon.post('/statuses/:id/reblog', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)

  const rawId = c.req.param('id')
  const resolved = await resolveStatus(c.env.abdl_space_db, rawId)
  if (!resolved) return c.json({ error: 'Record not found' }, 404)

  if (resolved.kind === 'comment') {
    const comment = await queryOne<Record<string, unknown>>(c.env.abdl_space_db,
      `SELECT pc.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
       (SELECT COUNT(*) FROM likes WHERE target_type = 'comment' AND target_id = pc.id) as like_count
       FROM post_comments pc JOIN users u ON pc.user_id = u.id WHERE pc.id = ?`, [resolved.realId])
    if (!comment) return c.json({ error: 'Record not found' }, 404)
    const account = toAccount({ id: comment.user_id as number, username: comment.username as string, avatar: comment.avatar as string | null, role: comment.role as string, bio: comment.bio as string | null, created_at: comment.user_created_at as string })
    return c.json(toStatusFromComment({ id: comment.id as number, post_id: comment.post_id as number, user_id: comment.user_id as number, parent_id: comment.parent_id as number | null, content: comment.content as string, like_count: comment.like_count as number, created_at: comment.created_at as string }, account))
  }

  const post = await queryOne<Record<string, unknown>>(c.env.abdl_space_db,
    `SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
     (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comment_count
     FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?`, [resolved.realId])
  if (!post) return c.json({ error: 'Record not found' }, 404)
  const account = toAccount({ id: post.user_id as number, username: post.username as string, avatar: post.avatar as string | null, role: post.role as string, bio: post.bio as string | null, created_at: post.user_created_at as string })
  return c.json(toStatus({ id: post.id as number, user_id: post.user_id as number, content: post.content as string, like_count: post.like_count as number, comment_count: post.comment_count as number, created_at: post.created_at as string }, account, { reblogged: true }))
})

// ============================================================
// POST /api/v1/statuses/:id/unreblog
// ============================================================
mastodon.post('/statuses/:id/unreblog', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)

  const rawId = c.req.param('id')
  const resolved = await resolveStatus(c.env.abdl_space_db, rawId)
  if (!resolved) return c.json({ error: 'Record not found' }, 404)

  if (resolved.kind === 'comment') {
    const comment = await queryOne<Record<string, unknown>>(c.env.abdl_space_db,
      `SELECT pc.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
       (SELECT COUNT(*) FROM likes WHERE target_type = 'comment' AND target_id = pc.id) as like_count
       FROM post_comments pc JOIN users u ON pc.user_id = u.id WHERE pc.id = ?`, [resolved.realId])
    if (!comment) return c.json({ error: 'Record not found' }, 404)
    const account = toAccount({ id: comment.user_id as number, username: comment.username as string, avatar: comment.avatar as string | null, role: comment.role as string, bio: comment.bio as string | null, created_at: comment.user_created_at as string })
    return c.json(toStatusFromComment({ id: comment.id as number, post_id: comment.post_id as number, user_id: comment.user_id as number, parent_id: comment.parent_id as number | null, content: comment.content as string, like_count: comment.like_count as number, created_at: comment.created_at as string }, account))
  }

  const post = await queryOne<Record<string, unknown>>(c.env.abdl_space_db,
    `SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
     (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comment_count
     FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?`, [resolved.realId])
  if (!post) return c.json({ error: 'Record not found' }, 404)
  const account = toAccount({ id: post.user_id as number, username: post.username as string, avatar: post.avatar as string | null, role: post.role as string, bio: post.bio as string | null, created_at: post.user_created_at as string })
  return c.json(toStatus({ id: post.id as number, user_id: post.user_id as number, content: post.content as string, like_count: post.like_count as number, comment_count: post.comment_count as number, created_at: post.created_at as string }, account, { reblogged: false }))
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

  if (maxId) { sql += ' AND p.id < ?'; params.push(parseMastoIdForCursor(maxId) ?? 0) }
  if (sinceId) { sql += ' AND p.id > ?'; params.push(parseMastoIdForCursor(sinceId) ?? 0) }

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

  const homeStatuses = posts.map(r => {
    const account = toAccount({
      id: r.user_id as number, username: r.username as string, avatar: r.avatar as string | null,
      role: r.role as string, bio: r.bio as string | null, created_at: r.user_created_at as string,
    })
    return toStatus({
      id: r.id as number, user_id: r.user_id as number, content: r.content as string,
      diaper_id: r.diaper_id as number | null, like_count: r.like_count as number,
      comment_count: r.comment_count as number, created_at: r.created_at as string,
    }, account, { favourited: likedSet.has(r.id as number) })
  })

  const link = buildLinkHeader('/api/v1/timelines/home', homeStatuses, limit)
  if (link) c.header('Link', link)
  return c.json(homeStatuses)
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

  if (maxId) { sql += ' AND p.id < ?'; params.push(parseMastoIdForCursor(maxId) ?? 0) }
  if (sinceId) { sql += ' AND p.id > ?'; params.push(parseMastoIdForCursor(sinceId) ?? 0) }

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

  const publicStatuses = posts.map(r => {
    const account = toAccount({
      id: r.user_id as number, username: r.username as string, avatar: r.avatar as string | null,
      role: r.role as string, bio: r.bio as string | null, created_at: r.user_created_at as string,
    })
    return toStatus({
      id: r.id as number, user_id: r.user_id as number, content: r.content as string,
      diaper_id: r.diaper_id as number | null, like_count: r.like_count as number,
      comment_count: r.comment_count as number, created_at: r.created_at as string,
    }, account, { favourited: likedSet.has(r.id as number) })
  })

  const link = buildLinkHeader('/api/v1/timelines/public', publicStatuses, limit, { local: c.req.query('local') || '' })
  if (link) c.header('Link', link)
  return c.json(publicStatuses)
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
     WHERE p.content LIKE ? OR p.content LIKE ? OR p.content LIKE ? OR p.content LIKE ? ORDER BY p.created_at DESC LIMIT ?`,
    [`%#${hashtag} %`, `%#${hashtag}\n%`, `#${hashtag} %`, `#${hashtag}\n%`, limit]
  )

  const tagStatuses = posts.map(r => {
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

  const link = buildLinkHeader(`/api/v1/timelines/tag/${hashtag}`, tagStatuses, limit)
  if (link) c.header('Link', link)
  return c.json(tagStatuses)
})

// ============================================================
// GET /api/v1/notifications
// ============================================================
mastodon.get('/notifications', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)

  const limit = Math.min(40, Math.max(1, parseInt(c.req.query('limit') || '20')))
  const maxId = c.req.query('max_id')
  const sinceId = c.req.query('since_id')

  let sql = 'SELECT * FROM notifications WHERE user_id = ?'
  const params: unknown[] = [user.sub]
  if (maxId) { sql += ' AND id < ?'; params.push(parseInt(maxId)) }
  if (sinceId) { sql += ' AND id > ?'; params.push(parseInt(sinceId)) }
  sql += ' ORDER BY created_at DESC LIMIT ?'
  params.push(limit)

  const rows = await query<Record<string, unknown>>(
    c.env.abdl_space_db, sql, params
  )

  const notifs: MastodonNotification[] = []
  for (const r of rows) {
    // Build a minimal account for the notification source
    // We need to figure out who triggered the notification
    let sourceAccount: MastodonAccount | null = null
    let status: MastodonStatus | null = null

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
    }, sourceAccount, status ?? undefined)

    if (notif) notifs.push(notif)
  }

  const link = buildLinkHeader('/api/v1/notifications', notifs, limit)
  if (link) c.header('Link', link)
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
  const IMGBED_URL = IMGBED_HOST
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
    const regex = /#([\w\u4e00-\u9fa5]+)/g
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
  // ABDL messages ≠ Mastodon conversations (based on direct statuses)
  return c.json([])
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
  const rawId = c.req.param('id')
  const resolved = await resolveStatus(c.env.abdl_space_db, rawId)
  if (!resolved) return c.json({ error: 'Record not found' }, 404)

  // For posts, get comments as descendants; for comments, get siblings
  const postId = resolved.kind === 'post' ? resolved.realId : (await queryOne<{ post_id: number }>(c.env.abdl_space_db, 'SELECT post_id FROM post_comments WHERE id = ?', [resolved.realId]))?.post_id
  if (!postId) return c.json({ ancestors: [], descendants: [] })

  const comments = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT pc.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'comment' AND target_id = pc.id) as like_count
     FROM post_comments pc JOIN users u ON pc.user_id = u.id
     WHERE pc.post_id = ? ORDER BY pc.created_at ASC`,
    [postId]
  )

  const ancestors: MastodonStatus[] = []
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
// STUB ENDPOINTS — Moshidon calls these on startup
// ============================================================

// GET /api/v1/filters
mastodon.get('/filters', async (c) => c.json([]))

// GET /api/v2/filters
mastodon.get('/v2/filters', async (c) => c.json([]))

// GET /api/v1/markers
mastodon.get('/markers', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)
  return c.json({
    home: { last_read_id: '0', version: 0, updated_at: new Date().toISOString(), unread_count: 0 },
    notifications: { last_read_id: '0', version: 0, updated_at: new Date().toISOString(), unread_count: 0 },
  })
})

// POST /api/v1/markers
mastodon.post('/markers', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)
  return c.json({
    home: { last_read_id: '0', version: 0, updated_at: new Date().toISOString(), unread_count: 0 },
    notifications: { last_read_id: '0', version: 0, updated_at: new Date().toISOString(), unread_count: 0 },
  })
})

// GET /api/v1/custom_emojis
mastodon.get('/custom_emojis', async (c) => c.json([]))

// GET /api/v1/announcements
mastodon.get('/announcements', async (c) => c.json([]))

// GET /api/v1/lists
mastodon.get('/lists', async (c) => c.json([]))

// GET /api/v1/preferences
mastodon.get('/preferences', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)
  return c.json({
    'posting:default:visibility': 'public',
    'posting:default:sensitive': false,
    'posting:default:language': 'zh',
    'reading:expand:media': 'default',
    'reading:expand:spoilers': false,
  })
})

// GET /api/v1/instance/peers
mastodon.get('/instance/peers', async (c) => c.json([]))

// GET /api/v1/notifications/:id
mastodon.get('/notifications/:id', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)
  const id = parseInt(c.req.param('id'))
  const r = await queryOne<Record<string, unknown>>(
    c.env.abdl_space_db, 'SELECT * FROM notifications WHERE id = ? AND user_id = ?', [id, user.sub]
  )
  if (!r) return c.json({ error: 'Record not found' }, 404)

  let sourceAccount = toAccount({ id: 0, username: 'system', avatar: null, role: 'user', created_at: new Date().toISOString() })
  let status: MastodonStatus | undefined

  if (r.type === 'follow') {
    const src = await queryOne<{ id: number; username: string; avatar: string | null; role: string; created_at: string }>(
      c.env.abdl_space_db, 'SELECT id, username, avatar, role, created_at FROM users WHERE id = ?', [r.related_id]
    )
    if (src) sourceAccount = toAccount(src)
  } else {
    const post = await queryOne<Record<string, unknown>>(
      c.env.abdl_space_db,
      `SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
       (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
       (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comment_count
       FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?`,
      [r.related_id]
    )
    if (post) {
      sourceAccount = toAccount({ id: post.user_id as number, username: post.username as string, avatar: post.avatar as string | null, role: post.role as string, bio: post.bio as string | null, created_at: post.user_created_at as string })
      status = toStatus({ id: post.id as number, user_id: post.user_id as number, content: post.content as string, like_count: post.like_count as number, comment_count: post.comment_count as number, created_at: post.created_at as string }, sourceAccount)
    }
  }

  const notif = toNotification({ id: r.id as number, type: r.type as string, message: r.message as string, related_id: r.related_id as number | null, read: r.read as number, created_at: r.created_at as string }, sourceAccount, status)
  return c.json(notif)
})

// POST /api/v1/notifications/clear
mastodon.post('/notifications/clear', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)
  await run(c.env.abdl_space_db, 'UPDATE notifications SET read = 1 WHERE user_id = ?', [user.sub])
  return c.json({})
})

// GET /api/v1/statuses/:id/favourited_by
mastodon.get('/statuses/:id/favourited_by', async (c) => {
  const rawId = c.req.param('id')
  const resolved = await resolveStatus(c.env.abdl_space_db, rawId)
  if (!resolved) return c.json([], 404)

  const targetType = resolved.kind === 'comment' ? 'comment' : 'post'
  const rows = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT u.id, u.username, u.avatar, u.role, u.bio, u.created_at
     FROM likes l JOIN users u ON l.user_id = u.id
     WHERE l.target_type = ? AND l.target_id = ? LIMIT 40`,
    [targetType, resolved.realId]
  )
  return c.json(rows.map(r => toAccount({
    id: r.id as number, username: r.username as string, avatar: r.avatar as string | null,
    role: r.role as string, bio: r.bio as string | null, created_at: r.created_at as string,
  })))
})

// GET /api/v1/statuses/:id/reblogged_by
mastodon.get('/statuses/:id/reblogged_by', async (c) => c.json([]))

// GET /api/v1/accounts/:id/featured_tags
mastodon.get('/accounts/:id/featured_tags', async (c) => c.json([]))

// GET /api/v1/follow_requests
mastodon.get('/follow_requests', async (c) => c.json([]))

// GET /api/v1/mutes
mastodon.get('/mutes', async (c) => c.json([]))

// GET /api/v1/blocks
mastodon.get('/blocks', async (c) => c.json([]))

// GET /api/v1/notifications/unread_count
mastodon.get('/notifications/unread_count', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)
  const row = await queryOne<{ cnt: number }>(
    c.env.abdl_space_db, 'SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ? AND read = 0', [user.sub]
  )
  return c.json({ count: row?.cnt ?? 0 })
})

export default mastodon
