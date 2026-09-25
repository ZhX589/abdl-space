import { Hono } from 'hono'
import { queryOne } from '../lib/db.ts'
import { adminMiddleware } from '../middleware/auth.ts'
import type { Env, JWTPayload } from '../types/index.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }
type Status = 400 | 401 | 403 | 404 | 409 | 415 | 429 | 500

class AdminIdentityError extends Error {
  constructor(readonly code: string, message: string, readonly status: Status) { super(message) }
}

const adminIdentities = new Hono<AppType>()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function safeAvatar(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) return ''
  try { const url = new URL(value); return url.protocol === 'https:' ? url.toString() : '' } catch { return '' }
}

function secure(c: { header: (name: string, value: string) => void }) {
  c.header('Cache-Control', 'private, no-store')
  c.header('Referrer-Policy', 'no-referrer')
}

async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
    .map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function errorResponse(c: { json: (body: unknown, status: number) => Response }, error: unknown): Response {
  const safe = error instanceof AdminIdentityError ? error : new AdminIdentityError('IDENTITY_OPERATION_FAILED', '身份操作失败', 500)
  return c.json({ error: safe.code, message: safe.message }, safe.status)
}

async function requireOAuthScopes(c: { req: { header: (name: string) => string | undefined }; env: Env }, required: string[]) {
  const authorization = c.req.header('Authorization')
  if (!authorization?.startsWith('Bearer ')) return
  const token = authorization.slice(7)
  const row = await queryOne<{ scopes: string }>(c.env.abdl_space_db, 'SELECT scopes FROM oauth_tokens WHERE access_token=? AND revoked=0', [token])
  if (!row) return
  const scopes = new Set(row.scopes.split(/[ ,]+/).filter(Boolean))
  if (!required.every(scope => scopes.has(scope))) throw new AdminIdentityError('INSUFFICIENT_SCOPE', 'OAuth 权限不足', 403)
}

adminIdentities.use('*', async (c, next) => {
  secure(c)
  await adminMiddleware(c, async () => {})
  if (!c.get('user')) return c.json({ error: 'Authentication required' }, 401)
  await next()
})

adminIdentities.get('/users/:id', async c => {
  try {
    await requireOAuthScopes(c, ['read', 'admin'])
    const targetId = Number(c.req.param('id'))
    if (!Number.isSafeInteger(targetId) || targetId <= 0) throw new AdminIdentityError('INVALID_USER_ID', '用户编号无效', 400)
    const user = await queryOne<{
      id: number; username: string; email: string | null; email_verified: number | null; password_hash: string | null; nbw_uid: string | null; role: string
    }>(c.env.abdl_space_db, 'SELECT id,username,email,email_verified,password_hash,nbw_uid,role FROM users WHERE id=?', [targetId])
    if (!user) throw new AdminIdentityError('USER_NOT_FOUND', '用户不存在', 404)
    const qq = await queryOne<{ nickname: string; avatar: string; created_at: number; updated_at: number }>(c.env.abdl_space_db, 'SELECT nickname,avatar,created_at,updated_at FROM qq_identities WHERE user_id=?', [targetId])
    const passkeys = await queryOne<{ count: number; last_used_at: number | null }>(c.env.abdl_space_db, 'SELECT COUNT(*) AS count,MAX(last_used_at) AS last_used_at FROM passkeys WHERE user_id=?', [targetId])
    const count = Number(passkeys?.count ?? 0)
    const alternatives = Boolean(user.password_hash) || Boolean(user.email && user.email_verified) || Boolean(user.nbw_uid) || count > 0
    const audit = await c.env.abdl_space_db.prepare('SELECT id,actor_id,action,reason,metadata_json,created_at FROM admin_identity_audit WHERE target_user_id=? ORDER BY created_at DESC,id DESC LIMIT 20').bind(targetId).all()
    return c.json({
      user: { id: user.id, username: user.username, role: user.role },
      methods: {
        password: Boolean(user.password_hash), verified_email: Boolean(user.email && user.email_verified), nbw: Boolean(user.nbw_uid),
        passkeys: { count, last_used_at: passkeys?.last_used_at ?? null },
        qq: qq ? { bound: true, nickname: qq.nickname, avatar: safeAvatar(qq.avatar), created_at: qq.created_at, updated_at: qq.updated_at, can_unbind: alternatives, block_reason: alternatives ? null : 'last_login_method' }
          : { bound: false, nickname: null, avatar: null, created_at: null, updated_at: null, can_unbind: false, block_reason: 'not_bound' },
      },
      audit: audit.results.map(row => ({ ...row, metadata: JSON.parse(String(row.metadata_json)), metadata_json: undefined })),
    })
  } catch (error) { return errorResponse(c, error) }
})

adminIdentities.post('/users/:id/qq/unbind', async c => {
  try {
    await requireOAuthScopes(c, ['write', 'admin'])
    if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json')) throw new AdminIdentityError('JSON_REQUIRED', '请求必须使用 JSON', 415)
    const origin = c.req.header('origin')
    const site = c.req.header('sec-fetch-site')
    if (origin && !['https://abdl-space.top', 'https://www.abdl-space.top', 'https://m.abdl-space.top'].includes(origin)) throw new AdminIdentityError('ORIGIN_REJECTED', '请求来源无效', 403)
    if (site && !['same-origin', 'same-site'].includes(site)) throw new AdminIdentityError('ORIGIN_REJECTED', '请求来源无效', 403)
    const targetId = Number(c.req.param('id'))
    const actor = c.get('user')
    if (!Number.isSafeInteger(targetId) || targetId <= 0) throw new AdminIdentityError('INVALID_USER_ID', '用户编号无效', 400)
    if (targetId === actor.sub) throw new AdminIdentityError('SELF_OPERATION_FORBIDDEN', '不能操作自己的身份绑定', 403)
    const input = await c.req.json<Record<string, unknown>>()
    const operationId = typeof input.operation_id === 'string' ? input.operation_id : ''
    const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
    const confirmUsername = typeof input.confirm_username === 'string' ? input.confirm_username : ''
    const expectedVersion = input.expected_binding_version
    if (!UUID.test(operationId) || reason.length < 1 || reason.length > 500 || !confirmUsername || !Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 0) {
      throw new AdminIdentityError('INVALID_REQUEST', '操作参数无效', 400)
    }
    const requestHash = await digest(JSON.stringify({ targetId, reason, confirmUsername, expectedVersion }))
    const replay = await queryOne<{ actor_id: number | null; target_user_id: number | null; request_hash: string; response_status: number; response_body: string }>(
      c.env.abdl_space_db, 'SELECT actor_id,target_user_id,request_hash,response_status,response_body FROM admin_identity_operations WHERE operation_id=?', [operationId]
    )
    if (replay) {
      if (replay.actor_id === actor.sub && replay.target_user_id === targetId && replay.request_hash === requestHash) return c.json(JSON.parse(replay.response_body), replay.response_status as 200)
      throw new AdminIdentityError('IDEMPOTENCY_CONFLICT', 'operation_id 已用于不同请求', 409)
    }
    const target = await queryOne<{ username: string; role: string; password_hash: string | null; email: string | null; email_verified: number | null; nbw_uid: string | null; binding_version: number | null; passkey_count: number }>(c.env.abdl_space_db,
      `SELECT u.username,u.role,u.password_hash,u.email,u.email_verified,u.nbw_uid,q.updated_at AS binding_version,
       (SELECT COUNT(*) FROM passkeys p WHERE p.user_id=u.id) AS passkey_count
       FROM users u LEFT JOIN qq_identities q ON q.user_id=u.id WHERE u.id=?`, [targetId])
    if (!target) throw new AdminIdentityError('USER_NOT_FOUND', '用户不存在', 404)
    if (target.role === 'admin') throw new AdminIdentityError('ADMIN_TARGET_FORBIDDEN', '不能解除管理员的身份绑定', 403)
    if (target.username !== confirmUsername) throw new AdminIdentityError('USERNAME_MISMATCH', '确认用户名不匹配', 409)
    if (target.binding_version === null) throw new AdminIdentityError('QQ_NOT_BOUND', '目标用户未绑定 QQ', 409)
    if (target.binding_version !== expectedVersion) throw new AdminIdentityError('QQ_BINDING_CHANGED', 'QQ 绑定状态已变化', 409)
    const hasAlternative = Boolean(target.password_hash) || Boolean(target.email && target.email_verified) || Boolean(target.nbw_uid) || target.passkey_count > 0
    if (!hasAlternative) throw new AdminIdentityError('QQ_UNBIND_WOULD_LOCK_ACCOUNT', '解绑会导致用户无法登录', 409)
    const invalidBefore = Math.floor(Date.now() / 1000)
    const responseBody = { operation_id: operationId, user_id: targetId, username: target.username, qq_bound: false, previous_binding_version: expectedVersion, auth_invalid_before: invalidBefore }
    const responseText = JSON.stringify(responseBody)
    try {
      await c.env.abdl_space_db.batch([
        c.env.abdl_space_db.prepare(`INSERT INTO admin_identity_operations(operation_id,actor_id,target_user_id,action,request_hash,confirmed_username,expected_binding_version,response_status,response_body) VALUES(?,?,?,'qq_unbind',?,?,?,?,?)`).bind(operationId, actor.sub, targetId, requestHash, confirmUsername, expectedVersion, 200, responseText),
        c.env.abdl_space_db.prepare('DELETE FROM qq_app_subjects WHERE unionid_hmac IN (SELECT unionid_hmac FROM qq_identities WHERE user_id=? AND updated_at=?)').bind(targetId, expectedVersion),
        c.env.abdl_space_db.prepare('DELETE FROM qq_identities WHERE user_id=? AND updated_at=?').bind(targetId, expectedVersion),
        c.env.abdl_space_db.prepare('UPDATE users SET auth_invalid_before=? WHERE id=?').bind(invalidBefore, targetId),
        c.env.abdl_space_db.prepare('UPDATE oauth_tokens SET revoked=1 WHERE user_id=? AND revoked=0').bind(targetId),
        c.env.abdl_space_db.prepare(`INSERT INTO notifications(user_id,type,message,related_id,read,actor_id) VALUES(?,'identity_security','管理员已解除你的 QQ 登录绑定，请使用其他方式重新登录',NULL,0,?)`).bind(targetId, actor.sub),
        c.env.abdl_space_db.prepare(`INSERT INTO admin_identity_audit(id,operation_id,actor_id,target_user_id,action,reason,metadata_json) VALUES(?,?,?,?, 'qq_unbind',?,?)`).bind(crypto.randomUUID(), operationId, actor.sub, targetId, reason, JSON.stringify({ previous_binding_version: expectedVersion })),
      ])
    } catch (error) {
      if (error instanceof Error && error.message.includes('AUTH_LAST_LOGIN_METHOD')) throw new AdminIdentityError('QQ_UNBIND_WOULD_LOCK_ACCOUNT', '解绑会导致用户无法登录', 409)
      throw error
    }
    return c.json(responseBody)
  } catch (error) { return errorResponse(c, error) }
})

export default adminIdentities
