import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { query, queryOne, run } from '../lib/db.ts'
import { authMiddleware } from '../middleware/auth.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const invite = new Hono<AppType>()

// 邀请码格式：ABDL-XXXX-XXXX
const MAX_CODES_PER_USER = 10
const CODE_EXPIRY_DAYS = 90

/**
 * 生成随机邀请码
 */
function generateInviteCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const segments = [4, 4]
  let code = 'ABDL-'
  for (let i = 0; i < segments.length; i++) {
    for (let j = 0; j < segments[i]; j++) {
      code += chars[Math.floor(Math.random() * chars.length)]
    }
    if (i < segments.length - 1) code += '-'
  }
  return code
}

/**
 * POST /api/invite/generate — 生成邀请码
 */
invite.post('/generate', authMiddleware, async (c) => {
  const user = c.get('user')
  const userId = user.sub

  // 检查用户已有邀请码数量
  const existingCount = await queryOne<{ cnt: number }>(
    c.env.abdl_space_db,
    'SELECT COUNT(*) as cnt FROM invite_codes WHERE creator_id = ? AND expires_at > datetime("now")',
    [userId]
  )

  if (existingCount && existingCount.cnt >= MAX_CODES_PER_USER) {
    return c.json({
      error: `最多同时拥有 ${MAX_CODES_PER_USER} 个有效邀请码`,
      current_count: existingCount.cnt,
    }, 400)
  }

  // 生成唯一邀请码（最多重试 10 次）
  let code = ''
  for (let i = 0; i < 10; i++) {
    code = generateInviteCode()
    const existing = await queryOne<{ id: number }>(
      c.env.abdl_space_db,
      'SELECT id FROM invite_codes WHERE code = ?',
      [code]
    )
    if (!existing) break
    if (i === 9) return c.json({ error: '邀请码生成失败，请重试' }, 500)
  }

  const expiresAt = new Date(Date.now() + CODE_EXPIRY_DAYS * 86400000).toISOString()

  await run(
    c.env.abdl_space_db,
    'INSERT INTO invite_codes (code, creator_id, expires_at) VALUES (?, ?, ?)',
    [code, userId, expiresAt]
  )

  return c.json({
    success: true,
    data: {
      code,
      expires_at: expiresAt,
    },
  })
})

/**
 * GET /api/invite/my-codes — 我的邀请码
 */
invite.get('/my-codes', authMiddleware, async (c) => {
  const user = c.get('user')
  const userId = user.sub

  const rows = await query<{
    id: number; code: string; used_by: number | null; used_at: string | null;
    expires_at: string; created_at: string;
    used_by_username?: string;
  }>(
    c.env.abdl_space_db,
    `SELECT ic.id, ic.code, ic.used_by, ic.used_at, ic.expires_at, ic.created_at,
            u.username as used_by_username
     FROM invite_codes ic
     LEFT JOIN users u ON ic.used_by = u.id
     WHERE ic.creator_id = ?
     ORDER BY ic.created_at DESC`,
    [userId]
  )

  return c.json({
    codes: rows.map(r => ({
      id: r.id,
      code: r.code,
      used: !!r.used_by,
      used_by: r.used_by_username || null,
      used_at: r.used_at,
      expires_at: r.expires_at,
      created_at: r.created_at,
      expired: new Date(r.expires_at) < new Date(),
    })),
  })
})

export default invite
