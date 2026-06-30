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
import { toAccount, toStatus, toStatusFromComment, toNotification, toISOString } from './converter.ts'
import { generateCardsForPosts } from './linkpreview.ts'
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

async function loadPolls(db: D1Database, pollIds: number[]): Promise<Map<number, any>> {
  if (pollIds.length === 0) return new Map()
  const polls = await query<Record<string, unknown>>(
    db, `SELECT * FROM polls WHERE id IN (${pollIds.map(() => '?').join(',')})`, pollIds
  )
  const map = new Map<number, any>()
  for (const p of polls) {
    const options = JSON.parse(p.options as string || '[]')
    map.set(p.id as number, {
      id: `poll_${p.id}`,
      expires_at: p.expires_at as string,
      expired: !!p.expired || new Date(p.expires_at as string) < new Date(),
      multiple: !!p.multiple,
      votes_count: p.votes_count as number,
      voters_count: p.voters_count as number,
      options,
      emojis: [],
      voted: false,
      own_votes: [],
    })
  }
  return map
}

async function loadPostImages(db: D1Database, postIds: number[]): Promise<Map<number, { image_url: string; is_nsfw: number }[]>> {
  if (postIds.length === 0) return new Map()
  const allImages = await query<{ post_id: number; image_url: string; is_nsfw: number }>(
    db, `SELECT post_id, image_url, is_nsfw, alt_text FROM post_images WHERE post_id IN (${postIds.map(() => '?').join(',')}) ORDER BY sort_order`, postIds
  )
  const map = new Map<number, { image_url: string; is_nsfw: number }[]>()
  for (const img of allImages) {
    if (!map.has(img.post_id)) map.set(img.post_id, [])
    map.get(img.post_id)!.push(img)
  }
  return map
}

async function loadReblogTargets(db: D1Database, repostIds: number[]): Promise<Map<number, MastodonStatus>> {
  if (repostIds.length === 0) return new Map()
  const originals = await query<Record<string, unknown>>(
    db, `SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
    (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
    (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) + (SELECT COUNT(*) FROM posts WHERE in_reply_to_id = p.id) as comment_count,
    (SELECT COUNT(*) FROM posts WHERE repost_id = p.id) as reblogs_count,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'bookmark' AND target_id = p.id) as bookmarks_count
    FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id IN (${repostIds.map(() => '?').join(',')})`, repostIds)
  const imagesMap = await loadPostImages(db, repostIds)
  const map = new Map<number, MastodonStatus>()
  for (const o of originals) {
    const account = toAccount({ id: o.user_id as number, username: o.username as string, avatar: o.avatar as string | null, role: o.role as string, bio: o.bio as string | null, created_at: o.user_created_at as string })
    map.set(o.id as number, toStatus({
      id: o.id as number, user_id: o.user_id as number, content: o.content as string,
      like_count: o.like_count as number, comment_count: o.comment_count as number, reblogs_count: o.reblogs_count as number,
      has_nsfw: !!o.has_nsfw,
      created_at: o.created_at as string, images: imagesMap.get(o.id as number),
    }, account))
  }
  return map
}

async function loadCommentImages(db: D1Database, commentIds: number[]): Promise<Map<number, { image_url: string; is_nsfw: number }[]>> {
  if (commentIds.length === 0) return new Map()
  try {
    const allImages = await query<{ comment_id: number; image_url: string; is_nsfw: number }>(
      db, `SELECT comment_id, image_url, is_nsfw, alt_text FROM comment_images WHERE comment_id IN (${commentIds.map(() => '?').join(',')}) ORDER BY sort_order`, commentIds
    )
    const map = new Map<number, { image_url: string; is_nsfw: number }[]>()
    for (const img of allImages) {
      if (!map.has(img.comment_id)) map.set(img.comment_id, [])
      map.get(img.comment_id)!.push(img)
    }
    return map
  } catch { return new Map() }
}

// ============================================================
// GET /api/v1/instance
// ============================================================
mastodon.get('/instance', async (c) => {
  return c.json(await buildInstance(c.env.abdl_space_db))
})

// DEBUG: check raw content of a post
mastodon.get('/debug/post/:id', async (c) => {
  const id = parseInt(c.req.param('id'))
  const post = await queryOne<{ id: number; content: string }>(
    c.env.abdl_space_db, 'SELECT id, content FROM posts WHERE id = ?', [id]
  )
  if (!post) return c.json({ error: 'not found' }, 404)
  const hasATags = post.content.includes('<a ')
  const hasEscapedATags = post.content.includes('&lt;a')
  return c.json({ id: post.id, raw_content: post.content.substring(0, 500), hasATags, hasEscapedATags, contentLength: post.content.length })
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
     VALUES (?, ?, ?, ?, ?, ?, 'client_secret_post', 1, 1, datetime('now'), datetime('now'))`,
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
    'SELECT id, username, avatar, header, role, bio, profile_fields, created_at FROM users WHERE id = ?',
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
    profile_fields: dbUser.profile_fields as string | null,
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
  let fieldsData: { name: string; value: string }[] = []
  if (contentType.includes('multipart/form-data') || contentType.includes('application/x-www-form-urlencoded')) {
    try {
      const formData = await c.req.formData()
      for (const [key, value] of formData.entries()) {
        if (key.startsWith('fields_attributes')) continue
        body[key] = value
      }
      // Parse fields_attributes[N][name/value] from formData entries
      const fieldsMap = new Map<number, { name: string; value: string }>()
      for (const [key, value] of formData.entries()) {
        const match = key.match(/fields_attributes\[(\d+)\]\[(\w+)\]/)
        if (match) {
          const idx = parseInt(match[1])
          const prop = match[2]
          if (!fieldsMap.has(idx)) fieldsMap.set(idx, { name: '', value: '' })
          const entry = fieldsMap.get(idx)!
          if (prop === 'name') entry.name = String(value)
          else if (prop === 'value') entry.value = String(value)
        }
      }
      for (const [, entry] of fieldsMap) {
        if (entry.name || entry.value) fieldsData.push(entry)
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
    if (body.avatar instanceof File) {
      const uploadForm = new FormData()
      uploadForm.append('file', body.avatar)
      let res = await fetch(`${IMGBED_HOST}/upload?returnFormat=full`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${c.env.IMGBED_UPLOAD_KEY}` },
        body: uploadForm,
      })
      if (!res.ok && c.env.IMGBED_UPLOAD_KEY) {
        const uploadForm2 = new FormData()
        uploadForm2.append('file', body.avatar)
        res = await fetch(`${IMGBED_HOST}/upload?returnFormat=full&authCode=${c.env.IMGBED_UPLOAD_KEY}`, {
          method: 'POST',
          body: uploadForm2,
        })
      }
      if (res.ok) {
        const data = await res.json() as { src: string }[]
        const url = data[0]?.src
        if (url) { updates.push('avatar = ?'); params.push(url) }
      }
    } else {
      updates.push('avatar = ?')
      params.push(String(body.avatar))
    }
  }

  if (body.header !== undefined) {
    if (body.header instanceof File) {
      const uploadForm = new FormData()
      uploadForm.append('file', body.header)
      let res = await fetch(`${IMGBED_HOST}/upload?returnFormat=full`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${c.env.IMGBED_UPLOAD_KEY}` },
        body: uploadForm,
      })
      if (!res.ok && c.env.IMGBED_UPLOAD_KEY) {
        const uploadForm2 = new FormData()
        uploadForm2.append('file', body.header)
        res = await fetch(`${IMGBED_HOST}/upload?returnFormat=full&authCode=${c.env.IMGBED_UPLOAD_KEY}`, {
          method: 'POST',
          body: uploadForm2,
        })
      }
      if (res.ok) {
        const data = await res.json() as { src: string }[]
        const url = data[0]?.src
        if (url) { updates.push('header = ?'); params.push(url) }
      }
    } else {
      updates.push('header = ?')
      params.push(String(body.header))
    }
  }

  // Always update profile_fields (even if empty array)
  updates.push('profile_fields = ?')
  params.push(JSON.stringify(fieldsData))

  if (updates.length > 0) {
    params.push(user.sub)
    await run(c.env.abdl_space_db, `UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params)
  }

  // Return updated account
  const dbUser = await queryOne<Record<string, unknown>>(
    c.env.abdl_space_db,
    'SELECT id, username, avatar, header, role, bio, profile_fields, created_at FROM users WHERE id = ?',
    [user.sub]
  )
  if (!dbUser) return c.json({ error: 'User not found' }, 404)

  return c.json(toAccount({
    id: dbUser.id as number,
    username: dbUser.username as string,
    avatar: dbUser.avatar as string | null,
    header: dbUser.header as string | null,
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
    'SELECT id, username, avatar, header, role, bio, profile_fields, created_at FROM users WHERE id = ?',
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
    header: dbUser.header as string | null,
    role: dbUser.role as string,
    bio: dbUser.bio as string | null,
    profile_fields: dbUser.profile_fields as string | null,
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
  const excludeReplies = c.req.query('exclude_replies') === 'true'

  const dbUser = await queryOne<{ id: number; username: string; avatar: string | null; header: string | null; role: string; bio: string | null; created_at: string }>(
    c.env.abdl_space_db, 'SELECT id, username, avatar, header, role, bio, profile_fields, created_at FROM users WHERE id = ?', [id]
  )
  if (!dbUser) return c.json({ error: 'Record not found' }, 404)

  let sql = `SELECT p.*, u.username, u.avatar, u.role,
    (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
    (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) + (SELECT COUNT(*) FROM posts WHERE in_reply_to_id = p.id) as comment_count,
    (SELECT COUNT(*) FROM posts WHERE repost_id = p.id) as reblogs_count,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'bookmark' AND target_id = p.id) as bookmarks_count
    FROM posts p JOIN users u ON p.user_id = u.id WHERE p.user_id = ?`
  const params: unknown[] = [id]

  if (excludeReplies) { sql += ' AND p.in_reply_to_id IS NULL' }
  if (maxId) { sql += ' AND p.id < ?'; params.push(parseMastoIdForCursor(maxId) ?? 0) }
  if (sinceId) { sql += ' AND p.id > ?'; params.push(parseMastoIdForCursor(sinceId) ?? 0) }

  sql += ' ORDER BY p.created_at DESC LIMIT ?'
  params.push(limit)

  const posts = await query<Record<string, unknown>>(c.env.abdl_space_db, sql, params)

  // Check which posts the current user has liked
  const user = await mastodonAuth(c)
  const likedSet = new Set<number>()
  const bookmarkSet = new Set<number>()
  if (user) {
    const postIds = posts.map(r => r.id as number)
    if (postIds.length > 0) {
      const liked = await query<{ target_id: number }>(
        c.env.abdl_space_db,
        `SELECT target_id FROM likes WHERE user_id = ? AND target_type = 'post' AND target_id IN (${postIds.map(() => '?').join(',')})`,
        [user.sub, ...postIds]
      )
      for (const l of liked) likedSet.add(l.target_id)
      const bookmarked = await query<{ target_id: number }>(
        c.env.abdl_space_db,
        `SELECT target_id FROM likes WHERE user_id = ? AND target_type = 'bookmark' AND target_id IN (${postIds.map(() => '?').join(',')})`,
        [user.sub, ...postIds]
      )
      for (const b of bookmarked) bookmarkSet.add(b.target_id)
    }
  }

  const account = toAccount(dbUser)
  const statuses = await (async () => {
    const postIds = posts.map(r => r.id as number)
    const imagesMap = await loadPostImages(c.env.abdl_space_db, postIds)
    const pollIds = posts.filter(r => r.poll_id).map(r => r.poll_id as number)
    const pollMap = await loadPolls(c.env.abdl_space_db, pollIds)
    const repostIds = posts.filter(r => r.repost_id).map(r => r.repost_id as number)
    const reblogMap = await loadReblogTargets(c.env.abdl_space_db, repostIds)
    const cardMap = await generateCardsForPosts(posts.map(r => ({ id: r.id as number, content: r.content as string, diaper_id: r.diaper_id as number | null })))
    return posts.map(r => toStatus({
      id: r.id as number,
      user_id: r.user_id as number,
      content: r.content as string,
      diaper_id: r.diaper_id as number | null,
      pinned: !!r.pinned,
      has_nsfw: !!r.has_nsfw,
      is_announcement: !!r.is_announcement,
      like_count: r.like_count as number,
      comment_count: r.comment_count as number,
      reblogs_count: r.reblogs_count as number, bookmarks_count: r.bookmarks_count as number, shares_count: 0,
      created_at: r.created_at as string,
      images: imagesMap.get(r.id as number),
      spoiler_text: r.spoiler_text as string, visibility: r.visibility as string,
      language: r.language as string,
      in_reply_to_id: r.in_reply_to_id as number | null,
      in_reply_to_account_id: r.in_reply_to_account_id as number | null,
      poll: r.poll_id ? pollMap.get(r.poll_id as number) ?? null : null,
      linkCard: cardMap.get(r.id as number) ?? null,
    }, account, { favourited: likedSet.has(r.id as number), bookmarked: bookmarkSet.has(r.id as number), reblog: r.repost_id ? reblogMap.get(r.repost_id as number) : undefined }))
  })()

  const link = buildLinkHeader(`/api/v1/accounts/${id}/statuses`, statuses, limit, { only_media: c.req.query('only_media') || '' })
  if (link) c.header('Link', link)
  return c.json(statuses)
})

// ============================================================
// GET /api/v1/accounts/:id/followers
// ============================================================
mastodon.get('/accounts/:id/followers', async (c) => {
  const id = parseInt(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid id' }, 400)
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
  if (!id) return c.json({ error: 'Invalid id' }, 400)
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

  let body: {
    status?: string; media_ids?: string[]; in_reply_to_id?: string;
    sensitive?: boolean; visibility?: string; spoiler_text?: string; language?: string;
    poll?: { options?: string[]; expires_in?: number; multiple?: boolean; hide_totals?: boolean };
    scheduled_at?: string;
    media_attributes?: { id?: string; description?: string }[];
  }
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid body' }, 400) }

  const content = body.status?.trim() || ''
  const hasNsfw = body.sensitive ? 1 : 0
  const visibility = body.visibility || 'public'
  const spoilerText = body.spoiler_text || ''
  const language = body.language || 'zh'

  // Resolve in_reply_to_id (could be p_123 or c_123 format)
  let inReplyToId: number | null = null
  let inReplyToAccountId: number | null = null
  if (body.in_reply_to_id) {
    const resolved = await resolveStatus(c.env.abdl_space_db, body.in_reply_to_id)
    if (resolved) {
      inReplyToId = resolved.realId
      // Find the account of the replied-to post/comment
      if (resolved.kind === 'post') {
        const repliedPost = await queryOne<{ user_id: number }>(c.env.abdl_space_db, 'SELECT user_id FROM posts WHERE id = ?', [resolved.realId])
        inReplyToAccountId = repliedPost?.user_id ?? null
      } else {
        const repliedComment = await queryOne<{ user_id: number }>(c.env.abdl_space_db, 'SELECT user_id FROM post_comments WHERE id = ?', [resolved.realId])
        inReplyToAccountId = repliedComment?.user_id ?? null
      }
    }
  }

  const result = await run(
    c.env.abdl_space_db,
    `INSERT INTO posts (user_id, content, has_nsfw, spoiler_text, visibility, language, in_reply_to_id, in_reply_to_account_id, poll_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [user.sub, content, hasNsfw, spoilerText, visibility, language, inReplyToId, inReplyToAccountId, null]
  )
  const postId = result.meta.last_row_id as number

  // Create poll if provided (after post so status_id FK is satisfied)
  if (body.poll && body.poll.options && body.poll.options.length >= 2) {
    const expiresAt = new Date(Date.now() + (body.poll.expires_in || 300) * 1000).toISOString()
    const options = body.poll.options.map(title => ({ title, votes_count: 0 }))
    const pollResult = await run(
      c.env.abdl_space_db,
      'INSERT INTO polls (status_id, expires_at, multiple, hide_totals, options) VALUES (?, ?, ?, ?, ?)',
      [postId, expiresAt, body.poll.multiple ? 1 : 0, body.poll.hide_totals ? 1 : 0, JSON.stringify(options)]
    )
    const pollId = pollResult.meta.last_row_id as number
    // Link poll to post
    await run(c.env.abdl_space_db, 'UPDATE posts SET poll_id = ? WHERE id = ?', [pollId, postId])
  }

  // Handle media attachments (images from media_ids)
  if (body.media_ids && body.media_ids.length > 0) {
    let sortOrder = 0
    for (const mediaId of body.media_ids) {
      if (typeof mediaId !== 'string' || !mediaId) continue
      if (!mediaId.startsWith(IMGBED_HOST + '/')) {
        return c.json({ error: `图片 URL 必须来自 ${IMGBED_HOST}，请先通过 /api/v1/media 上传` }, 400)
      }
      // Find description from media_attributes if provided
      let altText: string | null = null
      if (body.media_attributes && body.media_attributes.length > 0) {
        const attr = body.media_attributes.find(a => a.id === mediaId)
        if (attr && attr.description) altText = attr.description
      }
      try {
        await run(c.env.abdl_space_db, 'INSERT INTO post_images (post_id, image_url, is_nsfw, sort_order, alt_text) VALUES (?, ?, ?, ?, ?)', [postId, mediaId, hasNsfw, sortOrder++, altText])
      } catch {}
    }
  }

  // If sensitive, also mark all existing images for this post as nsfw
  if (hasNsfw) {
    await run(c.env.abdl_space_db, 'UPDATE post_images SET is_nsfw = 1 WHERE post_id = ?', [postId])
  }

  // Fetch the created post with all fields
  const post = await queryOne<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
     (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) + (SELECT COUNT(*) FROM posts WHERE in_reply_to_id = p.id) as comment_count,
     (SELECT COUNT(*) FROM posts WHERE repost_id = p.id) as reblogs_count,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'bookmark' AND target_id = p.id) as bookmarks_count
     FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?`,
    [postId]
  )
  if (!post) return c.json({ error: 'Failed to create status' }, 500)

  // Load images
  const images = await query<{ image_url: string; is_nsfw: number }>(
    c.env.abdl_space_db, 'SELECT image_url, is_nsfw, alt_text FROM post_images WHERE post_id = ? ORDER BY sort_order', [postId]
  )

  // Load poll if exists
  let poll = null
  if (post.poll_id) {
    poll = await loadPoll(c.env.abdl_space_db, post.poll_id as number)
  }

  const account = toAccount({
    id: post.user_id as number, username: post.username as string, avatar: post.avatar as string | null,
    role: post.role as string, bio: post.bio as string | null, created_at: post.user_created_at as string,
  })

  return c.json(toStatus({
    id: post.id as number, user_id: post.user_id as number, content: post.content as string,
    like_count: post.like_count as number, comment_count: post.comment_count as number,
    reblogs_count: post.reblogs_count as number, bookmarks_count: post.bookmarks_count as number, shares_count: 0, has_nsfw: !!post.has_nsfw,
    created_at: post.created_at as string, images,
    spoiler_text: post.spoiler_text as string, visibility: post.visibility as string,
    language: post.language as string,
    in_reply_to_id: post.in_reply_to_id as number | null,
    in_reply_to_account_id: post.in_reply_to_account_id as number | null,
    poll: poll as any,
  }, account))
})

// ============================================================
// GET /api/v1/statuses/:id
// ============================================================
mastodon.get('/statuses/:id', async (c) => {
  const rawId = c.req.param('id')
  const resolved = await resolveStatus(c.env.abdl_space_db, rawId)
  if (!resolved) return c.json({ error: 'Record not found' }, 404)
  const user = await mastodonAuth(c)

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
     (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) + (SELECT COUNT(*) FROM posts WHERE in_reply_to_id = p.id) as comment_count,
     (SELECT COUNT(*) FROM posts WHERE repost_id = p.id) as reblogs_count,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'bookmark' AND target_id = p.id) as bookmarks_count
     FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?`,
    [resolved.realId]
  )
  if (!post) return c.json({ error: 'Record not found' }, 404)

  const images = await query<{ image_url: string; is_nsfw: number }>(
    c.env.abdl_space_db, 'SELECT image_url, is_nsfw, alt_text FROM post_images WHERE post_id = ? ORDER BY sort_order', [resolved.realId]
  )

  const account = toAccount({
    id: post.user_id as number, username: post.username as string, avatar: post.avatar as string | null,
    role: post.role as string, bio: post.bio as string | null, created_at: post.user_created_at as string,
  })

  let reblog: MastodonStatus | undefined
  if (post.repost_id) {
    const reblogMap = await loadReblogTargets(c.env.abdl_space_db, [post.repost_id as number])
    reblog = reblogMap.get(post.repost_id as number)
  }

  // Load poll if exists
  const poll = post.poll_id ? await loadPoll(c.env.abdl_space_db, post.poll_id as number, user?.sub) : null

  // Generate link preview card for this post
  const { generateCardForContent } = await import('./linkpreview.ts')
  const linkCard = await generateCardForContent(post.content as string)

  return c.json(toStatus({
    id: post.id as number,
    user_id: post.user_id as number,
    content: post.content as string,
    diaper_id: post.diaper_id as number | null,
    pinned: !!post.pinned,
    has_nsfw: !!post.has_nsfw,
    like_count: post.like_count as number,
    comment_count: post.comment_count as number,
    reblogs_count: post.reblogs_count as number, bookmarks_count: post.bookmarks_count as number, shares_count: 0,
    created_at: post.created_at as string,
    images,
    spoiler_text: post.spoiler_text as string,
    visibility: post.visibility as string,
    language: post.language as string,
    edited_at: post.edited_at as string | null,
    in_reply_to_id: post.in_reply_to_id as number | null,
    in_reply_to_account_id: post.in_reply_to_account_id as number | null,
    poll: poll as any,
    linkCard,
  }, account, { reblog }))
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
    return c.json({ id: rawId, text: '', account: toAccount({ id: user.sub, username: 'user', avatar: null, role: 'user', bio: null, created_at: new Date().toISOString() }), media_attachments: [], poll: null })
  }

  const post = await queryOne<{ id: number; user_id: number }>(c.env.abdl_space_db, 'SELECT id, user_id FROM posts WHERE id = ?', [resolved.realId])
  if (!post) return c.json({ error: 'Record not found' }, 404)
  if (post.user_id !== user.sub && user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403)
  await run(c.env.abdl_space_db, 'DELETE FROM posts WHERE id = ?', [resolved.realId])
  return c.json({ id: rawId, text: '', account: toAccount({ id: user.sub, username: 'user', avatar: null, role: 'user', bio: null, created_at: new Date().toISOString() }), media_attachments: [], poll: null })
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
     (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) + (SELECT COUNT(*) FROM posts WHERE in_reply_to_id = p.id) as comment_count
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
     (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) + (SELECT COUNT(*) FROM posts WHERE in_reply_to_id = p.id) as comment_count
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
    return c.json({ error: 'Cannot reblog a comment' }, 400)
  }

  const realId = resolved.realId

  // Check if already reblogged
  const existing = await queryOne<{ id: number }>(
    c.env.abdl_space_db, 'SELECT id FROM posts WHERE user_id = ? AND repost_id = ? AND content = ?', [user.sub, realId, '']
  )
  if (existing) {
    // Already reblogged, just return status with reblogged: true
    const post = await queryOne<Record<string, unknown>>(c.env.abdl_space_db,
      `SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
       (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
       (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) + (SELECT COUNT(*) FROM posts WHERE in_reply_to_id = p.id) as comment_count,
       (SELECT COUNT(*) FROM posts WHERE repost_id = p.id) as reblogs_count,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'bookmark' AND target_id = p.id) as bookmarks_count
       FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?`, [realId])
    if (!post) return c.json({ error: 'Record not found' }, 404)
    const account = toAccount({ id: post.user_id as number, username: post.username as string, avatar: post.avatar as string | null, role: post.role as string, bio: post.bio as string | null, created_at: post.user_created_at as string })
    const images = await query<{ image_url: string; is_nsfw: number }>(c.env.abdl_space_db, 'SELECT image_url, is_nsfw, alt_text FROM post_images WHERE post_id = ? ORDER BY sort_order', [realId])
    return c.json(toStatus({ id: post.id as number, user_id: post.user_id as number, content: post.content as string, like_count: post.like_count as number, comment_count: post.comment_count as number, reblogs_count: post.reblogs_count as number, bookmarks_count: post.bookmarks_count as number, shares_count: 0, created_at: post.created_at as string, images }, account, { reblogged: true }))
  }

  // Create repost (reblog = new post with repost_id pointing to original)
  await run(c.env.abdl_space_db,
    'INSERT INTO posts (user_id, content, repost_id) VALUES (?, ?, ?)',
    [user.sub, '', realId]
  )

  // Notify original post author
  const origPost = await queryOne<{ user_id: number }>(c.env.abdl_space_db, 'SELECT user_id FROM posts WHERE id = ?', [realId])
  if (origPost && origPost.user_id !== user.sub) {
    await run(c.env.abdl_space_db,
      'INSERT INTO notifications (user_id, type, message, related_id, actor_id) VALUES (?, ?, ?, ?, ?)',
      [origPost.user_id, 'repost', `${user.sub} 转发了你的帖子`, realId, user.sub]
    )
  }

  // Return original post with reblogged: true
  const post = await queryOne<Record<string, unknown>>(c.env.abdl_space_db,
    `SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
     (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) + (SELECT COUNT(*) FROM posts WHERE in_reply_to_id = p.id) as comment_count,
     (SELECT COUNT(*) FROM posts WHERE repost_id = p.id) as reblogs_count,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'bookmark' AND target_id = p.id) as bookmarks_count
     FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?`, [realId])
  if (!post) return c.json({ error: 'Record not found' }, 404)
  const account = toAccount({ id: post.user_id as number, username: post.username as string, avatar: post.avatar as string | null, role: post.role as string, bio: post.bio as string | null, created_at: post.user_created_at as string })
  const images = await query<{ image_url: string; is_nsfw: number }>(c.env.abdl_space_db, 'SELECT image_url, is_nsfw, alt_text FROM post_images WHERE post_id = ? ORDER BY sort_order', [realId])
  return c.json(toStatus({ id: post.id as number, user_id: post.user_id as number, content: post.content as string, like_count: post.like_count as number, comment_count: post.comment_count as number, reblogs_count: post.reblogs_count as number, bookmarks_count: post.bookmarks_count as number, shares_count: 0, created_at: post.created_at as string, images }, account, { reblogged: true }))
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
    return c.json({ error: 'Cannot unreblog a comment' }, 400)
  }

  const realId = resolved.realId

  // Delete the user's repost of this post
  const repost = await queryOne<{ id: number }>(
    c.env.abdl_space_db, 'SELECT id FROM posts WHERE user_id = ? AND repost_id = ? AND content = ?', [user.sub, realId, '']
  )
  if (repost) {
    await run(c.env.abdl_space_db, 'DELETE FROM posts WHERE id = ?', [repost.id])
  }

  // Return original post with reblogged: false
  const post = await queryOne<Record<string, unknown>>(c.env.abdl_space_db,
    `SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
     (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) + (SELECT COUNT(*) FROM posts WHERE in_reply_to_id = p.id) as comment_count,
     (SELECT COUNT(*) FROM posts WHERE repost_id = p.id) as reblogs_count,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'bookmark' AND target_id = p.id) as bookmarks_count
     FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?`, [realId])
  if (!post) return c.json({ error: 'Record not found' }, 404)
  const account = toAccount({ id: post.user_id as number, username: post.username as string, avatar: post.avatar as string | null, role: post.role as string, bio: post.bio as string | null, created_at: post.user_created_at as string })
  const images = await query<{ image_url: string; is_nsfw: number }>(c.env.abdl_space_db, 'SELECT image_url, is_nsfw, alt_text FROM post_images WHERE post_id = ? ORDER BY sort_order', [realId])
  return c.json(toStatus({ id: post.id as number, user_id: post.user_id as number, content: post.content as string, like_count: post.like_count as number, comment_count: post.comment_count as number, reblogs_count: post.reblogs_count as number, bookmarks_count: post.bookmarks_count as number, shares_count: 0, created_at: post.created_at as string, images }, account, { reblogged: false }))
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

  // Home timeline = posts from followed users + own posts (filter out replies)
  let sql = `SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
    (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
    (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) + (SELECT COUNT(*) FROM posts WHERE in_reply_to_id = p.id) as comment_count,
    (SELECT COUNT(*) FROM posts WHERE repost_id = p.id) as reblogs_count,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'bookmark' AND target_id = p.id) as bookmarks_count
    FROM posts p JOIN users u ON p.user_id = u.id
    WHERE (p.user_id = ? OR p.user_id IN (SELECT following_id FROM follows WHERE follower_id = ?))
    AND p.in_reply_to_id IS NULL AND p.repost_id IS NULL`
  const params: unknown[] = [user.sub, user.sub]

  if (maxId) { sql += ' AND p.id < ?'; params.push(parseMastoIdForCursor(maxId) ?? 0) }
  if (sinceId) { sql += ' AND p.id > ?'; params.push(parseMastoIdForCursor(sinceId) ?? 0) }

  sql += ' ORDER BY p.created_at DESC LIMIT ?'
  params.push(limit)

  const posts = await query<Record<string, unknown>>(c.env.abdl_space_db, sql, params)

  // Check which posts the current user has liked
  const postIds = posts.map(r => r.id as number)
  const likedSet = new Set<number>()
  const bookmarkSet = new Set<number>()
  if (postIds.length > 0) {
    const liked = await query<{ target_id: number }>(
      c.env.abdl_space_db,
      `SELECT target_id FROM likes WHERE user_id = ? AND target_type = 'post' AND target_id IN (${postIds.map(() => '?').join(',')})`,
      [user.sub, ...postIds]
    )
    for (const l of liked) likedSet.add(l.target_id)
    const bookmarked = await query<{ target_id: number }>(
      c.env.abdl_space_db,
      `SELECT target_id FROM likes WHERE user_id = ? AND target_type = 'bookmark' AND target_id IN (${postIds.map(() => '?').join(',')})`,
      [user.sub, ...postIds]
    )
    for (const b of bookmarked) bookmarkSet.add(b.target_id)
  }

  const homeStatuses = await (async () => {
    const imagesMap = await loadPostImages(c.env.abdl_space_db, postIds)
    const pollIds = posts.filter(r => r.poll_id).map(r => r.poll_id as number)
    const pollMap = await loadPolls(c.env.abdl_space_db, pollIds)
    const repostIds = posts.filter(r => r.repost_id).map(r => r.repost_id as number)
    const reblogMap = await loadReblogTargets(c.env.abdl_space_db, repostIds)
    const cardMap = await generateCardsForPosts(posts.map(r => ({ id: r.id as number, content: r.content as string, diaper_id: r.diaper_id as number | null })))
    return posts.map(r => {
      const account = toAccount({
        id: r.user_id as number, username: r.username as string, avatar: r.avatar as string | null,
        role: r.role as string, bio: r.bio as string | null, created_at: r.user_created_at as string,
      })
      return toStatus({
        id: r.id as number, user_id: r.user_id as number, content: r.content as string,
        diaper_id: r.diaper_id as number | null, like_count: r.like_count as number,
        comment_count: r.comment_count as number, reblogs_count: r.reblogs_count as number, bookmarks_count: r.bookmarks_count as number, shares_count: 0,
        has_nsfw: !!r.has_nsfw,
        created_at: r.created_at as string,
        images: imagesMap.get(r.id as number),
        spoiler_text: r.spoiler_text as string, visibility: r.visibility as string,
        language: r.language as string,
        in_reply_to_id: r.in_reply_to_id as number | null,
        in_reply_to_account_id: r.in_reply_to_account_id as number | null,
        poll: r.poll_id ? pollMap.get(r.poll_id as number) ?? null : null,
        linkCard: cardMap.get(r.id as number) ?? null,
      }, account, { favourited: likedSet.has(r.id as number), bookmarked: bookmarkSet.has(r.id as number), reblog: r.repost_id ? reblogMap.get(r.repost_id as number) : undefined })
    })
  })()

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

  let sql = `    SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
    (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
    (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) + (SELECT COUNT(*) FROM posts WHERE in_reply_to_id = p.id) as comment_count,
    (SELECT COUNT(*) FROM posts WHERE repost_id = p.id) as reblogs_count,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'bookmark' AND target_id = p.id) as bookmarks_count
    FROM posts p JOIN users u ON p.user_id = u.id WHERE 1=1 AND p.in_reply_to_id IS NULL AND p.repost_id IS NULL`
  const params: unknown[] = []

  if (maxId) { sql += ' AND p.id < ?'; params.push(parseMastoIdForCursor(maxId) ?? 0) }
  if (sinceId) { sql += ' AND p.id > ?'; params.push(parseMastoIdForCursor(sinceId) ?? 0) }

  sql += ' ORDER BY p.created_at DESC LIMIT ?'
  params.push(limit)

  const posts = await query<Record<string, unknown>>(c.env.abdl_space_db, sql, params)

  // Check which posts the current user has liked (if authenticated)
  const user = await mastodonAuth(c)
  const likedSet = new Set<number>()
  const bookmarkSet = new Set<number>()
  if (user) {
    const postIds = posts.map(r => r.id as number)
    if (postIds.length > 0) {
      const liked = await query<{ target_id: number }>(
        c.env.abdl_space_db,
        `SELECT target_id FROM likes WHERE user_id = ? AND target_type = 'post' AND target_id IN (${postIds.map(() => '?').join(',')})`,
        [user.sub, ...postIds]
      )
      for (const l of liked) likedSet.add(l.target_id)
      const bookmarked = await query<{ target_id: number }>(
        c.env.abdl_space_db,
        `SELECT target_id FROM likes WHERE user_id = ? AND target_type = 'bookmark' AND target_id IN (${postIds.map(() => '?').join(',')})`,
        [user.sub, ...postIds]
      )
      for (const b of bookmarked) bookmarkSet.add(b.target_id)
    }
  }

  const publicStatuses = await (async () => {
    const postIds = posts.map(r => r.id as number)
    const imagesMap = await loadPostImages(c.env.abdl_space_db, postIds)
    const pollIds = posts.filter(r => r.poll_id).map(r => r.poll_id as number)
    const pollMap = await loadPolls(c.env.abdl_space_db, pollIds)
    const repostIds = posts.filter(r => r.repost_id).map(r => r.repost_id as number)
    const reblogMap = await loadReblogTargets(c.env.abdl_space_db, repostIds)
    const cardMap = await generateCardsForPosts(posts.map(r => ({ id: r.id as number, content: r.content as string, diaper_id: r.diaper_id as number | null })))
    return posts.map(r => {
      const account = toAccount({
        id: r.user_id as number, username: r.username as string, avatar: r.avatar as string | null,
        role: r.role as string, bio: r.bio as string | null, created_at: r.user_created_at as string,
      })
      return toStatus({
        id: r.id as number, user_id: r.user_id as number, content: r.content as string,
        diaper_id: r.diaper_id as number | null, like_count: r.like_count as number,
        comment_count: r.comment_count as number, reblogs_count: r.reblogs_count as number, bookmarks_count: r.bookmarks_count as number, shares_count: 0,
        has_nsfw: !!r.has_nsfw,
        created_at: r.created_at as string,
        images: imagesMap.get(r.id as number),
        spoiler_text: r.spoiler_text as string, visibility: r.visibility as string,
        language: r.language as string,
        in_reply_to_id: r.in_reply_to_id as number | null,
        in_reply_to_account_id: r.in_reply_to_account_id as number | null,
        poll: r.poll_id ? pollMap.get(r.poll_id as number) ?? null : null,
        linkCard: cardMap.get(r.id as number) ?? null,
      }, account, { favourited: likedSet.has(r.id as number), bookmarked: bookmarkSet.has(r.id as number), reblog: r.repost_id ? reblogMap.get(r.repost_id as number) : undefined })
    })
  })()

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
     (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) + (SELECT COUNT(*) FROM posts WHERE in_reply_to_id = p.id) as comment_count,
     (SELECT COUNT(*) FROM posts WHERE repost_id = p.id) as reblogs_count,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'bookmark' AND target_id = p.id) as bookmarks_count
     FROM posts p JOIN users u ON p.user_id = u.id
      WHERE (p.content LIKE ? OR p.content LIKE ? OR p.content LIKE ? OR p.content LIKE ?) AND p.in_reply_to_id IS NULL AND p.repost_id IS NULL ORDER BY p.created_at DESC LIMIT ?`,
    [`%#${hashtag} %`, `%#${hashtag}\n%`, `#${hashtag} %`, `#${hashtag}\n%`, limit]
  )

  const tagStatuses = await (async () => {
    const postIds = posts.map(r => r.id as number)
    const imagesMap = await loadPostImages(c.env.abdl_space_db, postIds)
    const pollIds = posts.filter(r => r.poll_id).map(r => r.poll_id as number)
    const pollMap = await loadPolls(c.env.abdl_space_db, pollIds)
    const repostIds = posts.filter(r => r.repost_id).map(r => r.repost_id as number)
    const reblogMap = await loadReblogTargets(c.env.abdl_space_db, repostIds)
    const cardMap = await generateCardsForPosts(posts.map(r => ({ id: r.id as number, content: r.content as string, diaper_id: r.diaper_id as number | null })))
    return posts.map(r => {
      const account = toAccount({
        id: r.user_id as number, username: r.username as string, avatar: r.avatar as string | null,
        role: r.role as string, bio: r.bio as string | null, created_at: r.user_created_at as string,
      })
      return toStatus({
        id: r.id as number, user_id: r.user_id as number, content: r.content as string,
        like_count: r.like_count as number, comment_count: r.comment_count as number,
        reblogs_count: r.reblogs_count as number, bookmarks_count: r.bookmarks_count as number, shares_count: 0,
        has_nsfw: !!r.has_nsfw,
        created_at: r.created_at as string,
        images: imagesMap.get(r.id as number),
        spoiler_text: r.spoiler_text as string, visibility: r.visibility as string,
        language: r.language as string,
        in_reply_to_id: r.in_reply_to_id as number | null,
        in_reply_to_account_id: r.in_reply_to_account_id as number | null,
        poll: r.poll_id ? pollMap.get(r.poll_id as number) ?? null : null,
        linkCard: cardMap.get(r.id as number) ?? null,
      }, account, { reblog: r.repost_id ? reblogMap.get(r.repost_id as number) : undefined })
    })
  })()

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

  // Batch load user accounts and posts to avoid N+1 queries
  const actorIds = [...new Set(rows.map(r => r.actor_id as number).filter(Boolean))]
  const postIds = [...new Set(rows.filter(r => r.type !== 'follow' && r.related_id).map(r => r.related_id as number).filter(Boolean))]

  const userMap = new Map<number, { id: number; username: string; avatar: string | null; role: string; created_at: string }>()
  if (actorIds.length > 0) {
    const users = await query<{ id: number; username: string; avatar: string | null; role: string; created_at: string }>(
      c.env.abdl_space_db, `SELECT id, username, avatar, header, role, created_at FROM users WHERE id IN (${actorIds.map(() => '?').join(',')})`, actorIds
    )
    for (const u of users) userMap.set(u.id, u)
  }

  const postMap = new Map<number, Record<string, unknown>>()
  if (postIds.length > 0) {
    const posts = await query<Record<string, unknown>>(
      c.env.abdl_space_db,
      `SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
       (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
       (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) + (SELECT COUNT(*) FROM posts WHERE in_reply_to_id = p.id) as comment_count
       FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id IN (${postIds.map(() => '?').join(',')})`, postIds
    )
    for (const p of posts) postMap.set(p.id as number, p)
  }

  const notifs: MastodonNotification[] = []
  for (const r of rows) {
    let sourceAccount: MastodonAccount | null = null
    let status: MastodonStatus | null = null

    if (r.type === 'follow') {
      const src = userMap.get(r.related_id as number)
      if (src) sourceAccount = toAccount(src)
    } else if (r.type === 'like' || r.type === 'comment' || r.type === 'reply' || r.type === 'mention' || r.type === 'repost') {
      // Use actor_id to get the person who performed the action
      const actorId = r.actor_id as number
      if (actorId) {
        const actor = userMap.get(actorId)
        if (actor) sourceAccount = toAccount(actor)
      }
      // Fallback: derive from post author if actor_id missing (legacy data)
      if (!sourceAccount) {
        const post = postMap.get(r.related_id as number)
        if (post) {
          sourceAccount = toAccount({
            id: post.user_id as number, username: post.username as string, avatar: post.avatar as string | null,
            role: post.role as string, bio: post.bio as string | null, created_at: post.user_created_at as string,
          })
        }
      }
      // Build status from post
      const post = postMap.get(r.related_id as number)
      if (post) {
        const postAuthor = userMap.get(post.user_id as number) || { id: post.user_id as number, username: post.username as string, avatar: post.avatar as string | null, role: post.role as string, bio: post.bio as string | null, created_at: post.user_created_at as string }
        status = toStatus({
          id: post.id as number, user_id: post.user_id as number, content: post.content as string,
          like_count: post.like_count as number, comment_count: post.comment_count as number,
          created_at: post.created_at as string,
        }, toAccount(postAuthor))
      }
    }

    if (!sourceAccount) {
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
  const description = formData.get('description') || null

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
    description: description || null,
    blurhash: null,
  })
})

// ============================================================
// PUT /api/v1/media/:id — Update media description
// ============================================================
mastodon.put('/media/:id', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)

  const mediaId = c.req.param('id')
  let body: { description?: string }
  try { body = await c.req.json() } catch { body = {} }

  // Update alt_text in post_images where image_url matches the media id
  if (mediaId && body.description !== undefined) {
    await run(
      c.env.abdl_space_db,
      'UPDATE post_images SET alt_text = ? WHERE image_url = ?',
      [body.description || null, mediaId]
    ).catch(() => {})
  }

  return c.json({
    id: mediaId,
    type: 'image',
    url: mediaId,
    preview_url: mediaId,
    remote_url: null,
    text_url: null,
    meta: {},
    description: body.description || null,
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
      c.env.abdl_space_db, 'SELECT id, username, avatar, header, role, bio, profile_fields, created_at FROM users WHERE username LIKE ? LIMIT 10', [likePattern]
    ),
    query<Record<string, unknown>>(
      c.env.abdl_space_db,
       `SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
       (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
       (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) + (SELECT COUNT(*) FROM posts WHERE in_reply_to_id = p.id) as comment_count,
       (SELECT COUNT(*) FROM posts WHERE repost_id = p.id) as reblogs_count,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'bookmark' AND target_id = p.id) as bookmarks_count
       FROM posts p JOIN users u ON p.user_id = u.id
       WHERE p.content LIKE ? ORDER BY p.created_at DESC LIMIT 10`,
      [likePattern]
    ),
  ])

  const accounts = users.map(u => toAccount(u))
  const statuses = await (async () => {
    const postIds = posts.map(r => r.id as number)
    const imagesMap = await loadPostImages(c.env.abdl_space_db, postIds)
    const pollIds = posts.filter(r => r.poll_id).map(r => r.poll_id as number)
    const pollMap = await loadPolls(c.env.abdl_space_db, pollIds)
    const repostIds = posts.filter(r => r.repost_id).map(r => r.repost_id as number)
    const reblogMap = await loadReblogTargets(c.env.abdl_space_db, repostIds)
    return posts.map(r => {
      const account = toAccount({
        id: r.user_id as number, username: r.username as string, avatar: r.avatar as string | null,
        role: r.role as string, bio: r.bio as string | null, created_at: r.user_created_at as string,
      })
      return toStatus({
        id: r.id as number, user_id: r.user_id as number, content: r.content as string,
        like_count: r.like_count as number, comment_count: r.comment_count as number,
        reblogs_count: r.reblogs_count as number, bookmarks_count: r.bookmarks_count as number, shares_count: 0,
        has_nsfw: !!r.has_nsfw,
        created_at: r.created_at as string,
        images: imagesMap.get(r.id as number),
        spoiler_text: r.spoiler_text as string, visibility: r.visibility as string,
        language: r.language as string,
        in_reply_to_id: r.in_reply_to_id as number | null,
        in_reply_to_account_id: r.in_reply_to_account_id as number | null,
        poll: r.poll_id ? pollMap.get(r.poll_id as number) ?? null : null,
      }, account, { reblog: r.repost_id ? reblogMap.get(r.repost_id as number) : undefined })
    })
  })()

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
// GET /api/v1/favourites
// ============================================================
mastodon.get('/favourites', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)

  const limit = Math.min(40, Math.max(1, parseInt(c.req.query('limit') || '20')))
  const maxId = c.req.query('max_id')

  let sql = `SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
    (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
    (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) + (SELECT COUNT(*) FROM posts WHERE in_reply_to_id = p.id) as comment_count,
    (SELECT COUNT(*) FROM posts WHERE repost_id = p.id) as reblogs_count,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'bookmark' AND target_id = p.id) as bookmarks_count
    FROM posts p JOIN users u ON p.user_id = u.id
    WHERE p.id IN (SELECT target_id FROM likes WHERE user_id = ? AND target_type = 'post')`
  const params: unknown[] = [user.sub]

  if (maxId) { sql += ' AND p.id < ?'; params.push(parseMastoIdForCursor(maxId) ?? 0) }
  sql += ' ORDER BY p.created_at DESC LIMIT ?'
  params.push(limit)

  const posts = await query<Record<string, unknown>>(c.env.abdl_space_db, sql, params)
  const postIds = posts.map(r => r.id as number)

  const likedSet = new Set<number>()
  const bookmarkSet = new Set<number>()
  if (postIds.length > 0) {
    const liked = await query<{ target_id: number }>(
      c.env.abdl_space_db,
      `SELECT target_id FROM likes WHERE user_id = ? AND target_type = 'post' AND target_id IN (${postIds.map(() => '?').join(',')})`,
      [user.sub, ...postIds]
    )
    for (const l of liked) likedSet.add(l.target_id)
    const bookmarked = await query<{ target_id: number }>(
      c.env.abdl_space_db,
      `SELECT target_id FROM likes WHERE user_id = ? AND target_type = 'bookmark' AND target_id IN (${postIds.map(() => '?').join(',')})`,
      [user.sub, ...postIds]
    )
    for (const b of bookmarked) bookmarkSet.add(b.target_id)
  }

  const imagesMap = await loadPostImages(c.env.abdl_space_db, postIds)
  const pollIds = posts.filter(r => r.poll_id).map(r => r.poll_id as number)
  const pollMap = await loadPolls(c.env.abdl_space_db, pollIds)

  const statuses = posts.map(r => {
    const account = toAccount({
      id: r.user_id as number, username: r.username as string, avatar: r.avatar as string | null,
      role: r.role as string, bio: r.bio as string | null, created_at: r.user_created_at as string,
    })
    return toStatus({
      id: r.id as number, user_id: r.user_id as number, content: r.content as string,
      like_count: r.like_count as number, comment_count: r.comment_count as number,
      reblogs_count: r.reblogs_count as number, bookmarks_count: r.bookmarks_count as number, shares_count: 0, has_nsfw: !!r.has_nsfw,
      created_at: r.created_at as string,
      images: imagesMap.get(r.id as number),
      spoiler_text: r.spoiler_text as string, visibility: r.visibility as string,
      language: r.language as string,
      in_reply_to_id: r.in_reply_to_id as number | null,
      in_reply_to_account_id: r.in_reply_to_account_id as number | null,
      poll: r.poll_id ? pollMap.get(r.poll_id as number) ?? null : null,
    }, account, { favourited: likedSet.has(r.id as number), bookmarked: bookmarkSet.has(r.id as number) })
  })

  return c.json(statuses)
})

// ============================================================
// GET /api/v1/bookmarks
// ============================================================
mastodon.get('/bookmarks', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)

  const limit = Math.min(40, Math.max(1, parseInt(c.req.query('limit') || '20')))
  const maxId = c.req.query('max_id')

  // Bookmarks are stored as likes with target_type 'bookmark'
  let sql = `SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
    (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
    (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) + (SELECT COUNT(*) FROM posts WHERE in_reply_to_id = p.id) as comment_count,
    (SELECT COUNT(*) FROM posts WHERE repost_id = p.id) as reblogs_count,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'bookmark' AND target_id = p.id) as bookmarks_count
    FROM posts p JOIN users u ON p.user_id = u.id
    WHERE p.id IN (SELECT target_id FROM likes WHERE user_id = ? AND target_type = 'bookmark')`
  const params: unknown[] = [user.sub]

  if (maxId) { sql += ' AND p.id < ?'; params.push(parseMastoIdForCursor(maxId) ?? 0) }
  sql += ' ORDER BY p.created_at DESC LIMIT ?'
  params.push(limit)

  const posts = await query<Record<string, unknown>>(c.env.abdl_space_db, sql, params)
  const postIds = posts.map(r => r.id as number)

  const likedSet = new Set<number>()
  const bookmarkSet = new Set<number>()
  if (postIds.length > 0) {
    const liked = await query<{ target_id: number }>(
      c.env.abdl_space_db,
      `SELECT target_id FROM likes WHERE user_id = ? AND target_type = 'post' AND target_id IN (${postIds.map(() => '?').join(',')})`,
      [user.sub, ...postIds]
    )
    for (const l of liked) likedSet.add(l.target_id)
    for (const id of postIds) bookmarkSet.add(id) // all are bookmarked
  }

  const imagesMap = await loadPostImages(c.env.abdl_space_db, postIds)
  const pollIds = posts.filter(r => r.poll_id).map(r => r.poll_id as number)
  const pollMap = await loadPolls(c.env.abdl_space_db, pollIds)

  const statuses = posts.map(r => {
    const account = toAccount({
      id: r.user_id as number, username: r.username as string, avatar: r.avatar as string | null,
      role: r.role as string, bio: r.bio as string | null, created_at: r.user_created_at as string,
    })
    return toStatus({
      id: r.id as number, user_id: r.user_id as number, content: r.content as string,
      like_count: r.like_count as number, comment_count: r.comment_count as number,
      reblogs_count: r.reblogs_count as number, bookmarks_count: r.bookmarks_count as number, shares_count: 0, has_nsfw: !!r.has_nsfw,
      created_at: r.created_at as string,
      images: imagesMap.get(r.id as number),
      spoiler_text: r.spoiler_text as string, visibility: r.visibility as string,
      language: r.language as string,
      in_reply_to_id: r.in_reply_to_id as number | null,
      in_reply_to_account_id: r.in_reply_to_account_id as number | null,
      poll: r.poll_id ? pollMap.get(r.poll_id as number) ?? null : null,
    }, account, { favourited: likedSet.has(r.id as number), bookmarked: true })
  })

  return c.json(statuses)
})

// ============================================================
// POST /api/v1/statuses/:id/bookmark
// ============================================================
mastodon.post('/statuses/:id/bookmark', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)
  const rawId = c.req.param('id')
  const resolved = await resolveStatus(c.env.abdl_space_db, rawId)
  if (!resolved) return c.json({ error: 'Record not found' }, 404)

  // Store bookmark as a special like with target_type 'bookmark'
  // Use INSERT OR IGNORE to handle unique constraint gracefully
  await run(c.env.abdl_space_db,
    'INSERT OR IGNORE INTO likes (user_id, target_type, target_id) VALUES (?, ?, ?)',
    [user.sub, 'bookmark', resolved.realId]
  )

  const post = await queryOne<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
     (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) + (SELECT COUNT(*) FROM posts WHERE in_reply_to_id = p.id) as comment_count,
     (SELECT COUNT(*) FROM posts WHERE repost_id = p.id) as reblogs_count,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'bookmark' AND target_id = p.id) as bookmarks_count
     FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?`,
    [resolved.realId]
  )
  if (!post) return c.json({ error: 'Record not found' }, 404)

  const account = toAccount({ id: post.user_id as number, username: post.username as string, avatar: post.avatar as string | null, header: post.header as string | null, role: post.role as string, bio: post.bio as string | null, created_at: post.user_created_at as string })
  const images = await loadPostImages(c.env.abdl_space_db, [resolved.realId])
  return c.json(toStatus({
    id: post.id as number, user_id: post.user_id as number, content: post.content as string,
    has_nsfw: !!post.has_nsfw, like_count: post.like_count as number, comment_count: post.comment_count as number,
    reblogs_count: post.reblogs_count as number, bookmarks_count: post.bookmarks_count as number, shares_count: 0, created_at: post.created_at as string,
    images: images.get(resolved.realId), bookmarked: true,
  }, account, { bookmarked: true }))
})

// ============================================================
// POST /api/v1/statuses/:id/unbookmark
// ============================================================
mastodon.post('/statuses/:id/unbookmark', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)
  const rawId = c.req.param('id')
  const resolved = await resolveStatus(c.env.abdl_space_db, rawId)
  if (!resolved) return c.json({ error: 'Record not found' }, 404)

  await run(c.env.abdl_space_db,
    'DELETE FROM likes WHERE user_id = ? AND target_type = ? AND target_id = ?',
    [user.sub, 'bookmark', resolved.realId]
  ).catch(() => {}) // Ignore errors if no bookmark exists

  const post = await queryOne<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
     (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) + (SELECT COUNT(*) FROM posts WHERE in_reply_to_id = p.id) as comment_count,
     (SELECT COUNT(*) FROM posts WHERE repost_id = p.id) as reblogs_count,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'bookmark' AND target_id = p.id) as bookmarks_count
     FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?`,
    [resolved.realId]
  )
  if (!post) return c.json({ error: 'Record not found' }, 404)

  const account = toAccount({ id: post.user_id as number, username: post.username as string, avatar: post.avatar as string | null, header: post.header as string | null, role: post.role as string, bio: post.bio as string | null, created_at: post.user_created_at as string })
  const images = await loadPostImages(c.env.abdl_space_db, [resolved.realId])
  return c.json(toStatus({
    id: post.id as number, user_id: post.user_id as number, content: post.content as string,
    has_nsfw: !!post.has_nsfw, like_count: post.like_count as number, comment_count: post.comment_count as number,
    reblogs_count: post.reblogs_count as number, bookmarks_count: post.bookmarks_count as number, shares_count: 0, created_at: post.created_at as string,
    images: images.get(resolved.realId), bookmarked: false,
  }, account, { bookmarked: false }))
})

// ============================================================
// POST /api/v1/statuses/:id/context
// ============================================================
mastodon.get('/statuses/:id/context', async (c) => {
  const rawId = c.req.param('id')
  const resolved = await resolveStatus(c.env.abdl_space_db, rawId)
  if (!resolved) return c.json({ error: 'Record not found' }, 404)

  // Get the post ID (for posts directly, for comments find parent post)
  const postId = resolved.kind === 'post' ? resolved.realId : (await queryOne<{ post_id: number }>(c.env.abdl_space_db, 'SELECT post_id FROM post_comments WHERE id = ?', [resolved.realId]))?.post_id
  if (!postId) return c.json({ ancestors: [], descendants: [] })

  // Get comments from post_comments table
  const comments = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT pc.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'comment' AND target_id = pc.id) as like_count
     FROM post_comments pc JOIN users u ON pc.user_id = u.id
     WHERE pc.post_id = ? ORDER BY pc.created_at ASC`,
    [postId]
  )

  const commentIds = comments.map(r => r.id as number)
  let commentImagesMap = new Map<number, { image_url: string; is_nsfw: number }[]>()
  try {
    commentImagesMap = await loadCommentImages(c.env.abdl_space_db, commentIds)
  } catch {}

  const commentDescendants = comments.map(r => {
    const account = toAccount({
      id: r.user_id as number, username: r.username as string, avatar: r.avatar as string | null,
      role: r.role as string, bio: r.bio as string | null, created_at: r.user_created_at as string,
    })
    return toStatusFromComment({
      id: r.id as number, post_id: r.post_id as number, user_id: r.user_id as number,
      parent_id: r.parent_id as number | null, content: r.content as string,
      like_count: r.like_count as number, created_at: r.created_at as string,
      images: commentImagesMap.get(r.id as number),
    }, account)
  })

  // Also get posts that reply to this post (in_reply_to_id = postId)
  const replyPosts = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
     (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) + (SELECT COUNT(*) FROM posts WHERE in_reply_to_id = p.id) as comment_count,
     (SELECT COUNT(*) FROM posts WHERE repost_id = p.id) as reblogs_count,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'bookmark' AND target_id = p.id) as bookmarks_count
     FROM posts p JOIN users u ON p.user_id = u.id
     WHERE p.in_reply_to_id = ? ORDER BY p.created_at ASC`,
    [postId]
  )

  const replyPostIds = replyPosts.map(r => r.id as number)
  const replyImagesMap = replyPostIds.length > 0 ? await loadPostImages(c.env.abdl_space_db, replyPostIds) : new Map()
  const replyCardMap = replyPostIds.length > 0 ? await generateCardsForPosts(replyPosts.map(r => ({ id: r.id as number, content: r.content as string, diaper_id: r.diaper_id as number | null }))) : new Map()

  const postDescendants = replyPosts.map(r => {
    const account = toAccount({
      id: r.user_id as number, username: r.username as string, avatar: r.avatar as string | null,
      role: r.role as string, bio: r.bio as string | null, created_at: r.user_created_at as string,
    })
    return toStatus({
      id: r.id as number, user_id: r.user_id as number, content: r.content as string,
      diaper_id: r.diaper_id as number | null, like_count: r.like_count as number,
      comment_count: r.comment_count as number, reblogs_count: r.reblogs_count as number, bookmarks_count: r.bookmarks_count as number, shares_count: 0,
      has_nsfw: !!r.has_nsfw, created_at: r.created_at as string,
      images: replyImagesMap.get(r.id as number),
      spoiler_text: r.spoiler_text as string, visibility: r.visibility as string,
      language: r.language as string,
      in_reply_to_id: r.in_reply_to_id as number | null,
      in_reply_to_account_id: r.in_reply_to_account_id as number | null,
      poll: null, linkCard: replyCardMap.get(r.id as number) ?? null,
    }, account)
  })

  const ancestors: MastodonStatus[] = []
  const descendants = [...commentDescendants, ...postDescendants].sort((a, b) =>
    new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  )

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

  // Ensure markers table exists
  await run(c.env.abdl_space_db, `CREATE TABLE IF NOT EXISTS markers (
    user_id TEXT NOT NULL,
    timeline TEXT NOT NULL,
    last_read_id TEXT NOT NULL DEFAULT '0',
    version INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, timeline)
  )`)

  const homeMarker = await queryOne<{ last_read_id: string }>(
    c.env.abdl_space_db, 'SELECT last_read_id FROM markers WHERE user_id = ? AND timeline = ?', [user.sub, 'home']
  )
  const notifMarker = await queryOne<{ last_read_id: string }>(
    c.env.abdl_space_db, 'SELECT last_read_id FROM markers WHERE user_id = ? AND timeline = ?', [user.sub, 'notifications']
  )

  return c.json({
    home: { last_read_id: homeMarker?.last_read_id ?? '0', version: 0, updated_at: new Date().toISOString(), unread_count: 0 },
    notifications: { last_read_id: notifMarker?.last_read_id ?? '0', version: 0, updated_at: new Date().toISOString(), unread_count: 0 },
  })
})

// POST /api/v1/markers
mastodon.post('/markers', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)

  // Ensure markers table exists
  await run(c.env.abdl_space_db, `CREATE TABLE IF NOT EXISTS markers (
    user_id TEXT NOT NULL,
    timeline TEXT NOT NULL,
    last_read_id TEXT NOT NULL DEFAULT '0',
    version INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, timeline)
  )`)

  let body: Record<string, unknown> = {}
  try { body = await c.req.json() } catch {}

  const now = new Date().toISOString()

  if (body.notifications && typeof body.notifications === 'object') {
    const n = body.notifications as Record<string, unknown>
    if (n.last_read_id) {
      await run(c.env.abdl_space_db,
        `INSERT INTO markers (user_id, timeline, last_read_id, version, updated_at) VALUES (?, 'notifications', ?, 0, ?)
         ON CONFLICT(user_id, timeline) DO UPDATE SET last_read_id = excluded.last_read_id, updated_at = excluded.updated_at`,
        [user.sub, String(n.last_read_id), now]
      )
    }
  }

  if (body.home && typeof body.home === 'object') {
    const h = body.home as Record<string, unknown>
    if (h.last_read_id) {
      await run(c.env.abdl_space_db,
        `INSERT INTO markers (user_id, timeline, last_read_id, version, updated_at) VALUES (?, 'home', ?, 0, ?)
         ON CONFLICT(user_id, timeline) DO UPDATE SET last_read_id = excluded.last_read_id, updated_at = excluded.updated_at`,
        [user.sub, String(h.last_read_id), now]
      )
    }
  }

  const homeMarker = await queryOne<{ last_read_id: string }>(
    c.env.abdl_space_db, 'SELECT last_read_id FROM markers WHERE user_id = ? AND timeline = ?', [user.sub, 'home']
  )
  const notifMarker = await queryOne<{ last_read_id: string }>(
    c.env.abdl_space_db, 'SELECT last_read_id FROM markers WHERE user_id = ? AND timeline = ?', [user.sub, 'notifications']
  )

  return c.json({
    home: { last_read_id: homeMarker?.last_read_id ?? '0', version: 0, updated_at: now, unread_count: 0 },
    notifications: { last_read_id: notifMarker?.last_read_id ?? '0', version: 0, updated_at: now, unread_count: 0 },
  })
})

// GET /api/v1/custom_emojis
mastodon.get('/custom_emojis', async (c) => c.json([]))

// GET /api/v1/announcements
mastodon.get('/announcements', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)
  const db = c.env.abdl_space_db

  // 从 posts 表读取公告（is_announcement=1），与原自定义 API 数据统一
  const rows = await query<Record<string, unknown>>(
    db,
    `SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at
     FROM posts p JOIN users u ON p.user_id = u.id
     WHERE p.is_announcement = 1
     ORDER BY p.created_at DESC`
  )

  // Get read status for this user
  const readIds = new Set<number>()
  if (rows.length > 0) {
    const readRows = await query<{ announcement_id: number }>(
      db,
      `SELECT announcement_id FROM announcement_read_status WHERE user_id = ? AND announcement_id IN (${rows.map(() => '?').join(',')})`,
      [user.sub, ...rows.map(r => r.id as number)]
    )
    for (const r of readRows) readIds.add(r.announcement_id)
  }

  const results = rows.map(row => ({
    id: String(row.id),
    content: `<p>${row.content}</p>`,
    starts_at: toISOString(row.created_at as string),
    ends_at: null,
    all_day: false,
    published: true,
    published_at: toISOString(row.created_at as string),
    updated_at: toISOString(row.created_at as string),
    read: readIds.has(row.id as number),
    emojis: [],
    reactions: [],
    mentions: [],
    tags: [],
  }))

  return c.json(results)
})

// POST /api/v1/announcements — 创建公告（admin only）
// 与原自定义 API 统一：创建帖子并标记 is_announcement=1
mastodon.post('/announcements', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)
  if (user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403)

  let body: { content?: string }
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid body' }, 400) }
  if (!body.content) return c.json({ error: 'content is required' }, 400)

  // 创建帖子并标记为公告（与原自定义 API 统一）
  const result = await run(
    c.env.abdl_space_db,
    'INSERT INTO posts (user_id, content, is_announcement) VALUES (?, ?, 1)',
    [user.sub, body.content]
  )

  return c.json({ id: String(result.meta.last_row_id) }, 201)
})

// DELETE /api/v1/announcements/:id — 删除公告（admin only）
// 与原自定义 API 统一：删除帖子
mastodon.delete('/announcements/:id', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)
  if (user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403)

  const rawId = c.req.param('id')
  const resolved = await resolveStatus(c.env.abdl_space_db, rawId)
  if (!resolved || resolved.kind !== 'post') return c.json({ error: 'Record not found' }, 404)

  await run(c.env.abdl_space_db, 'DELETE FROM posts WHERE id = ?', [resolved.realId])
  return c.json({})
})

// PATCH /api/v1/announcements/:id — 更新公告（admin only）
mastodon.patch('/announcements/:id', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)
  if (user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403)

  const rawId = c.req.param('id')
  const resolved = await resolveStatus(c.env.abdl_space_db, rawId)
  if (!resolved || resolved.kind !== 'post') return c.json({ error: 'Record not found' }, 404)

  let body: { content?: string; published?: boolean }
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid body' }, 400) }

  if (body.content !== undefined) {
    await run(c.env.abdl_space_db, 'UPDATE posts SET content = ? WHERE id = ?', [body.content, resolved.realId])
  }
  if (body.published !== undefined) {
    await run(c.env.abdl_space_db, 'UPDATE posts SET is_announcement = ? WHERE id = ?', [body.published ? 1 : 0, resolved.realId])
  }

  return c.json({ id: rawId })
})

// POST /api/v1/announcements/:id/dismiss — 标记公告为已读
mastodon.post('/announcements/:id/dismiss', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)

  const rawId = c.req.param('id')
  const resolved = await resolveStatus(c.env.abdl_space_db, rawId)
  if (!resolved || resolved.kind !== 'post') return c.json({ error: 'Record not found' }, 404)

  try {
    await run(
      c.env.abdl_space_db,
      'INSERT OR IGNORE INTO announcement_read_status (user_id, announcement_id) VALUES (?, ?)',
      [user.sub, resolved.realId]
    )
  } catch {}

  return c.json({})
})

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
      c.env.abdl_space_db, 'SELECT id, username, avatar, header, role, created_at FROM users WHERE id = ?', [r.related_id]
    )
    if (src) sourceAccount = toAccount(src)
  } else {
    const post = await queryOne<Record<string, unknown>>(
      c.env.abdl_space_db,
      `SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
       (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
       (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) + (SELECT COUNT(*) FROM posts WHERE in_reply_to_id = p.id) as comment_count
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

// ============================================================
// Missing endpoints — return empty to prevent JsonSyntaxException
// ============================================================

// GET /api/v1/trends
mastodon.get('/trends', async (c) => c.json([]))

// GET /api/v1/trends/statuses
mastodon.get('/trends/statuses', async (c) => {
  const limit = Math.min(40, Math.max(1, parseInt(c.req.query('limit') || '20')))
  const offset = parseInt(c.req.query('offset') || '0') || 0

  let sql = `SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
     (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) + (SELECT COUNT(*) FROM posts WHERE in_reply_to_id = p.id) as comment_count,
     (SELECT COUNT(*) FROM posts WHERE repost_id = p.id) as reblogs_count,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'bookmark' AND target_id = p.id) as bookmarks_count
     FROM posts p JOIN users u ON p.user_id = u.id
     WHERE p.repost_id IS NULL AND p.in_reply_to_id IS NULL
     ORDER BY p.created_at DESC LIMIT ? OFFSET ?`
  const params: unknown[] = [limit, offset]

  const posts = await query<Record<string, unknown>>(c.env.abdl_space_db, sql, params)

  const user = await mastodonAuth(c)
  const postIds = posts.map(r => r.id as number)
  const likedSet = new Set<number>()
  const bookmarkSet = new Set<number>()
  if (user && postIds.length > 0) {
    const liked = await query<{ target_id: number }>(
      c.env.abdl_space_db,
      `SELECT target_id FROM likes WHERE user_id = ? AND target_type = 'post' AND target_id IN (${postIds.map(() => '?').join(',')})`,
      [user.sub, ...postIds]
    )
    for (const l of liked) likedSet.add(l.target_id)
    const bookmarked = await query<{ target_id: number }>(
      c.env.abdl_space_db,
      `SELECT target_id FROM likes WHERE user_id = ? AND target_type = 'bookmark' AND target_id IN (${postIds.map(() => '?').join(',')})`,
      [user.sub, ...postIds]
    )
    for (const b of bookmarked) bookmarkSet.add(b.target_id)
  }

  const imagesMap = await loadPostImages(c.env.abdl_space_db, postIds)
  const pollIds = posts.filter(r => r.poll_id).map(r => r.poll_id as number)
  const pollMap = await loadPolls(c.env.abdl_space_db, pollIds)

  const statuses = posts.map(r => {
    const account = toAccount({
      id: r.user_id as number, username: r.username as string, avatar: r.avatar as string | null,
      role: r.role as string, bio: r.bio as string | null, created_at: r.user_created_at as string,
    })
    return toStatus({
      id: r.id as number, user_id: r.user_id as number, content: r.content as string,
      like_count: r.like_count as number, comment_count: r.comment_count as number,
      reblogs_count: r.reblogs_count as number, bookmarks_count: r.bookmarks_count as number, shares_count: 0,
      has_nsfw: !!r.has_nsfw,
      created_at: r.created_at as string,
      images: imagesMap.get(r.id as number),
      spoiler_text: r.spoiler_text as string, visibility: r.visibility as string,
      language: r.language as string,
      in_reply_to_id: r.in_reply_to_id as number | null,
      in_reply_to_account_id: r.in_reply_to_account_id as number | null,
      poll: r.poll_id ? pollMap.get(r.poll_id as number) ?? null : null,
    }, account, { favourited: likedSet.has(r.id as number), bookmarked: bookmarkSet.has(r.id as number) })
  })

  const link = buildLinkHeader('/api/v1/trends/statuses', statuses, limit)
  if (link) c.header('Link', link)
  return c.json(statuses)
})

// GET /api/v1/trends/links
mastodon.get('/trends/links', async (c) => c.json([]))

// GET /api/v1/trends/tags
mastodon.get('/trends/tags', async (c) => c.json([]))

// GET /api/v1/instance/extended_description
mastodon.get('/instance/extended_description', async (c) => {
  return c.json({
    content: '<p>欢迎来到 <strong>ABDL Space</strong> —— 纸尿裤评价与社区平台。</p>\n' +
      '<p>在这里您可以：</p>\n' +
      '<ul>\n' +
      '<li>浏览和评分各类纸尿裤产品</li>\n' +
      '<li>分享您的使用感受和评价</li>\n' +
      '<li>参与社区广场讨论</li>\n' +
      '<li>获取AI智能推荐</li>\n' +
      '</ul>\n' +
      '<p>请遵守社区规则，文明交流。</p>\n' +
      '<p>更多信息请访问 <a href="https://abdl-space.top/about">官方网站</a>。</p>',
    updated_at: new Date().toISOString(),
  })
})

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

// GET /api/v1/followed_tags
mastodon.get('/followed_tags', async (c) => c.json([]))

// GET /api/v1/featured_tags
mastodon.get('/featured_tags', async (c) => c.json([]))

// GET /api/v1/scheduled_statuses
mastodon.get('/scheduled_statuses', async (c) => c.json([]))

// GET /api/v1/endorsements
mastodon.get('/endorsements', async (c) => c.json([]))

// GET /api/v1/domain_blocks
mastodon.get('/domain_blocks', async (c) => c.json([]))

// ============================================================
// Helper: Load poll from database
// ============================================================
async function loadPoll(db: D1Database, pollId: number, userId?: number): Promise<{
  id: string; expires_at: string; expired: boolean; multiple: boolean;
  votes_count: number; voters_count: number; options: { title: string; votes_count: number }[];
  emojis: unknown[]; voted?: boolean; own_votes?: number[];
} | null> {
  const poll = await queryOne<Record<string, unknown>>(
    db, 'SELECT * FROM polls WHERE id = ?', [pollId]
  )
  if (!poll) return null

  const options = JSON.parse(poll.options as string || '[]')
  const expired = poll.expired || new Date(poll.expires_at as string) < new Date()

  let voted = false
  let ownVotes: number[] = []
  if (userId) {
    const vote = await queryOne<{ choices: string }>(
      db, 'SELECT choices FROM poll_votes WHERE poll_id = ? AND user_id = ?', [pollId, userId]
    )
    if (vote) {
      voted = true
      ownVotes = JSON.parse(vote.choices || '[]')
    }
  }

  return {
    id: `poll_${pollId}`,
    expires_at: poll.expires_at as string,
    expired: !!expired,
    multiple: !!poll.multiple,
    votes_count: poll.votes_count as number,
    voters_count: poll.voters_count as number,
    options,
    emojis: [],
    voted,
    own_votes: ownVotes,
  }
}

// ============================================================
// PUT /api/v1/statuses/:id — Edit a status
// ============================================================
mastodon.put('/statuses/:id', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)

  const rawId = c.req.param('id')
  const resolved = await resolveStatus(c.env.abdl_space_db, rawId)
  if (!resolved || resolved.kind !== 'post') return c.json({ error: 'Record not found' }, 404)

  // Check ownership
  const post = await queryOne<{ user_id: number }>(c.env.abdl_space_db, 'SELECT user_id FROM posts WHERE id = ?', [resolved.realId])
  if (!post) return c.json({ error: 'Record not found' }, 404)
  if (post.user_id !== user.sub && user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403)

  let body: {
    status?: string; media_ids?: string[]; sensitive?: boolean; visibility?: string;
    spoiler_text?: string; language?: string;
    poll?: { options?: string[]; expires_in?: number; multiple?: boolean; hide_totals?: boolean };
  }
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid body' }, 400) }

  const updates: string[] = []
  const params: unknown[] = []

  if (body.status !== undefined) { updates.push('content = ?'); params.push(body.status.trim()) }
  if (body.sensitive !== undefined) { updates.push('has_nsfw = ?'); params.push(body.sensitive ? 1 : 0) }
  if (body.visibility !== undefined) { updates.push('visibility = ?'); params.push(body.visibility) }
  if (body.spoiler_text !== undefined) { updates.push('spoiler_text = ?'); params.push(body.spoiler_text) }
  if (body.language !== undefined) { updates.push('language = ?'); params.push(body.language) }

  updates.push('edited_at = ?')
  params.push(new Date().toISOString())

  if (updates.length > 0) {
    params.push(resolved.realId)
    await run(c.env.abdl_space_db, `UPDATE posts SET ${updates.join(', ')} WHERE id = ?`, params)
  }

  // If sensitive changed, propagate to images
  if (body.sensitive !== undefined) {
    await run(c.env.abdl_space_db, 'UPDATE post_images SET is_nsfw = ? WHERE post_id = ?', [body.sensitive ? 1 : 0, resolved.realId])
  }

  // Handle media updates (replace all images)
  if (body.media_ids !== undefined) {
    await run(c.env.abdl_space_db, 'DELETE FROM post_images WHERE post_id = ?', [resolved.realId])
    let sortOrder = 0
    for (const mediaId of body.media_ids) {
      if (typeof mediaId !== 'string' || !mediaId) continue
      if (!mediaId.startsWith(IMGBED_HOST + '/')) continue
      await run(c.env.abdl_space_db, 'INSERT INTO post_images (post_id, image_url, sort_order) VALUES (?, ?, ?)', [resolved.realId, mediaId, sortOrder++])
    }
  }

  // Handle poll update
  if (body.poll) {
    const existingPoll = await queryOne<{ id: number }>(c.env.abdl_space_db, 'SELECT id FROM polls WHERE status_id = ?', [resolved.realId])
    if (existingPoll) {
      // Delete old poll and votes
      await run(c.env.abdl_space_db, 'DELETE FROM poll_votes WHERE poll_id = ?', [existingPoll.id])
      await run(c.env.abdl_space_db, 'DELETE FROM polls WHERE id = ?', [existingPoll.id])
    }
    if (body.poll.options && body.poll.options.length >= 2) {
      const expiresAt = new Date(Date.now() + (body.poll.expires_in || 300) * 1000).toISOString()
      const options = body.poll.options.map(title => ({ title, votes_count: 0 }))
      const pollResult = await run(
        c.env.abdl_space_db,
        'INSERT INTO polls (status_id, expires_at, multiple, hide_totals, options) VALUES (?, ?, ?, ?, ?)',
        [resolved.realId, expiresAt, body.poll.multiple ? 1 : 0, body.poll.hide_totals ? 1 : 0, JSON.stringify(options)]
      )
      await run(c.env.abdl_space_db, 'UPDATE posts SET poll_id = ? WHERE id = ?', [pollResult.meta.last_row_id, resolved.realId])
    } else {
      await run(c.env.abdl_space_db, 'UPDATE posts SET poll_id = NULL WHERE id = ?', [resolved.realId])
    }
  }

  // Return updated status
  const updatedPost = await queryOne<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT p.*, u.username, u.avatar, u.role, u.bio, u.created_at as user_created_at,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'post' AND target_id = p.id) as like_count,
     (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) + (SELECT COUNT(*) FROM posts WHERE in_reply_to_id = p.id) as comment_count,
     (SELECT COUNT(*) FROM posts WHERE repost_id = p.id) as reblogs_count,
     (SELECT COUNT(*) FROM likes WHERE target_type = 'bookmark' AND target_id = p.id) as bookmarks_count
     FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?`, [resolved.realId]
  )
  if (!updatedPost) return c.json({ error: 'Failed to update status' }, 500)

  const images = await query<{ image_url: string; is_nsfw: number }>(
    c.env.abdl_space_db, 'SELECT image_url, is_nsfw, alt_text FROM post_images WHERE post_id = ? ORDER BY sort_order', [resolved.realId]
  )
  const poll = updatedPost.poll_id ? await loadPoll(c.env.abdl_space_db, updatedPost.poll_id as number) : null

  return c.json(toStatus({
    id: updatedPost.id as number, user_id: updatedPost.user_id as number, content: updatedPost.content as string,
    like_count: updatedPost.like_count as number, comment_count: updatedPost.comment_count as number,
    reblogs_count: updatedPost.reblogs_count as number, has_nsfw: !!updatedPost.has_nsfw,
    created_at: updatedPost.created_at as string, images,
    spoiler_text: updatedPost.spoiler_text as string, visibility: updatedPost.visibility as string,
    language: updatedPost.language as string,
    edited_at: updatedPost.edited_at as string | null,
    in_reply_to_id: updatedPost.in_reply_to_id as number | null,
    in_reply_to_account_id: updatedPost.in_reply_to_account_id as number | null,
    poll: poll as any,
  }, toAccount({
    id: updatedPost.user_id as number, username: updatedPost.username as string, avatar: updatedPost.avatar as string | null,
    role: updatedPost.role as string, bio: updatedPost.bio as string | null, created_at: updatedPost.user_created_at as string,
  })))
})

// ============================================================
// GET /api/v1/polls/:id — Get a poll
// ============================================================
mastodon.get('/polls/:id', async (c) => {
  const pollIdStr = c.req.param('id')
  const pollId = parseInt(pollIdStr.replace('poll_', ''))
  if (isNaN(pollId)) return c.json({ error: 'Invalid poll ID' }, 400)

  const user = await mastodonAuth(c)
  const poll = await loadPoll(c.env.abdl_space_db, pollId, user?.sub)
  if (!poll) return c.json({ error: 'Record not found' }, 404)

  return c.json(poll)
})

// ============================================================
// POST /api/v1/polls/:id/votes — Vote on a poll
// ============================================================
mastodon.post('/polls/:id/votes', async (c) => {
  const user = await mastodonAuth(c)
  if (!user) return c.json({ error: 'The access token is invalid' }, 401)

  const pollIdStr = c.req.param('id')
  const pollId = parseInt(pollIdStr.replace('poll_', ''))
  if (isNaN(pollId)) return c.json({ error: 'Invalid poll ID' }, 400)

  let body: { choices?: number[] }
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid body' }, 400) }
  if (!body.choices || body.choices.length === 0) return c.json({ error: 'choices required' }, 400)

  const poll = await queryOne<Record<string, unknown>>(c.env.abdl_space_db, 'SELECT * FROM polls WHERE id = ?', [pollId])
  if (!poll) return c.json({ error: 'Record not found' }, 404)
  if (poll.expired || new Date(poll.expires_at as string) < new Date()) return c.json({ error: 'Poll has expired' }, 400)

  const options = JSON.parse(poll.options as string || '[]')
  const maxIndex = options.length - 1
  for (const choice of body.choices) {
    if (choice < 0 || choice > maxIndex) return c.json({ error: `Invalid choice index: ${choice}` }, 400)
  }

  if (!poll.multiple && body.choices.length > 1) return c.json({ error: 'Poll does not allow multiple choices' }, 400)

  // Check if already voted
  const existingVote = await queryOne<{ id: number; choices: string }>(
    c.env.abdl_space_db, 'SELECT id, choices FROM poll_votes WHERE poll_id = ? AND user_id = ?', [pollId, user.sub]
  )

  if (existingVote) {
    // Update vote
    const oldChoices: number[] = JSON.parse(existingVote.choices)
    // Decrement old votes
    for (const idx of oldChoices) {
      options[idx].votes_count = Math.max(0, options[idx].votes_count - 1)
    }
    // Increment new votes
    for (const idx of body.choices) {
      options[idx].votes_count++
    }
    await run(c.env.abdl_space_db, 'UPDATE poll_votes SET choices = ? WHERE id = ?', [JSON.stringify(body.choices), existingVote.id])
  } else {
    // New vote
    for (const idx of body.choices) {
      options[idx].votes_count++
    }
    await run(c.env.abdl_space_db, 'INSERT INTO poll_votes (poll_id, user_id, choices) VALUES (?, ?, ?)', [pollId, user.sub, JSON.stringify(body.choices)])
  }

  // Update poll totals
  const totalVotes = options.reduce((sum, o) => sum + o.votes_count, 0)
  const voterCount = await queryOne<{ cnt: number }>(c.env.abdl_space_db, 'SELECT COUNT(*) as cnt FROM poll_votes WHERE poll_id = ?', [pollId])
  await run(c.env.abdl_space_db, 'UPDATE polls SET options = ?, votes_count = ?, voters_count = ? WHERE id = ?',
    [JSON.stringify(options), totalVotes, voterCount?.cnt ?? 0, pollId])

  // Check if poll should be marked expired
  if (new Date(poll.expires_at as string) < new Date()) {
    await run(c.env.abdl_space_db, 'UPDATE polls SET expired = 1 WHERE id = ?', [pollId])
  }

  return c.json(await loadPoll(c.env.abdl_space_db, pollId, user.sub))
})

export default mastodon
