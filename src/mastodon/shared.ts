/**
 * Shared Mastodon helpers used by routes.ts and v2.ts
 */

import type { Env, JWTPayload } from '../types/index.ts'
import { queryOne } from '../lib/db.ts'
import type { MastodonInstance } from './types.ts'

// ============================================================
// Auth — shared between routes.ts and v2.ts
// ============================================================
export async function mastodonAuth(c: { req: { header: (name: string) => string | undefined }; env: Env }): Promise<JWTPayload | null> {
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

// ============================================================
// Instance — shared between v1 and v2
// ============================================================
export async function buildInstance(db: D1Database): Promise<MastodonInstance> {
  const userCount = await queryOne<{ cnt: number }>(db, 'SELECT COUNT(*) as cnt FROM users')

  return {
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
}

// ============================================================
// Status ID resolution — maps Mastodon status ID → real entity
// Mastodon treats status IDs as opaque strings, so we use p_<id> / c_<id>
// Fallback: numeric >= 10000000 for backward compat
// ============================================================
export async function resolveStatus(db: D1Database, mastoId: string): Promise<{ kind: 'post' | 'comment'; realId: number } | null> {
  // String prefix format: p_123 or c_123
  if (mastoId.startsWith('p_')) {
    const id = parseInt(mastoId.slice(2))
    if (isNaN(id)) return null
    const p = await queryOne<{ id: number }>(db, 'SELECT id FROM posts WHERE id = ?', [id])
    return p ? { kind: 'post', realId: p.id } : null
  }
  if (mastoId.startsWith('c_')) {
    const id = parseInt(mastoId.slice(2))
    if (isNaN(id)) return null
    const c = await queryOne<{ id: number }>(db, 'SELECT id FROM post_comments WHERE id = ?', [id])
    return c ? { kind: 'comment', realId: c.id } : null
  }

  // Legacy numeric format
  const numId = parseInt(mastoId)
  if (isNaN(numId)) return null

  if (numId >= 10000000) {
    const commentId = numId - 10000000
    const c = await queryOne<{ id: number }>(db, 'SELECT id FROM post_comments WHERE id = ?', [commentId])
    return c ? { kind: 'comment', realId: c.id } : null
  }

  const p = await queryOne<{ id: number }>(db, 'SELECT id FROM posts WHERE id = ?', [numId])
  return p ? { kind: 'post', realId: p.id } : null
}

/** Convert ABDL entity ID to Mastodon status ID string */
export function toMastoId(kind: 'post' | 'comment', realId: number): string {
  return kind === 'comment' ? `c_${realId}` : `p_${realId}`
}

/** Extract numeric ID from Mastodon status ID (for SQL cursor pagination) */
export function parseMastoIdForCursor(mastoId: string | undefined): number | undefined {
  if (!mastoId) return undefined
  if (mastoId.startsWith('p_') || mastoId.startsWith('c_')) {
    const id = parseInt(mastoId.slice(2))
    return isNaN(id) ? undefined : id
  }
  const id = parseInt(mastoId)
  return isNaN(id) ? undefined : id
}
