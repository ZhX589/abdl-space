import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { SponsorAppType } from '../lib/sponsors.ts'
import {
  getSponsorConfig, getSponsorMe, updateSponsorConfig, saveSponsorPlan,
  mutateSponsorUser, createSponsorCodeBatch, exportSponsorCodeBatch, sponsorAdminMiddleware,
  sponsorErrorResponse, SponsorError, sponsorObject, sponsorInteger, sponsorText,
} from '../lib/sponsors.ts'
import { requestBody, sponsorPagination } from './sponsors.ts'

function identifier(value: unknown): string {
  const id = sponsorText(value, '标识', 64)
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new SponsorError('invalid_request', '标识格式不正确')
  return id
}

const adminSponsors = new Hono<SponsorAppType>()

adminSponsors.use('*', bodyLimit({ maxSize: 262144, onError: c => c.json({ error: '请求内容过大', code: 'invalid_request' }, 413) }))
adminSponsors.onError((error, c) => sponsorErrorResponse(error, c))

// 每条管理路由自带 sponsorAdminMiddleware（实时角色 + Origin/CSRF + no-store + 限流）。
adminSponsors.get('/config', sponsorAdminMiddleware, async c => c.json(await getSponsorConfig(c.env)))

adminSponsors.put('/config', sponsorAdminMiddleware, async c => {
  const body = await requestBody(c.req.raw)
  const config = await updateSponsorConfig(c.env, c.get('user').sub, body)
  await c.env.abdl_space_db // config transaction already audited
  return c.json(config)
})

adminSponsors.get('/plans', sponsorAdminMiddleware, async c => {
  const rows = await c.env.abdl_space_db.prepare('SELECT plan_json FROM sponsor_plans ORDER BY sort_order,id').all<{ plan_json: string }>()
  return c.json({ items: rows.results.map(row => JSON.parse(row.plan_json)) })
})

adminSponsors.post('/plans', sponsorAdminMiddleware, async c => {
  const body = await requestBody(c.req.raw)
  return c.json(await saveSponsorPlan(c.env, c.get('user').sub, body), 201)
})

adminSponsors.put('/plans/:id', sponsorAdminMiddleware, async c => {
  const body = await requestBody(c.req.raw)
  return c.json(await saveSponsorPlan(c.env, c.get('user').sub, body, c.req.param('id')))
})

adminSponsors.get('/users', sponsorAdminMiddleware, async c => {
  const { limit, offset } = sponsorPagination(c.req.query())
  const q = (c.req.query('q') ?? '').trim()
  const params: (string | number)[] = []
  let where = ''
  if (q) {
    where = 'WHERE u.username LIKE ? OR CAST(u.id AS TEXT) = ?'
    params.push(`%${q.replace(/[%_]/g, v => `\\${v}`)}%`, q)
  }
  const rows = await c.env.abdl_space_db.prepare(
    `SELECT u.id, u.username, u.avatar,
       CASE WHEN m.permanent=1 OR m.expires_at>unixepoch() THEN 1 ELSE 0 END AS active,
       COALESCE(m.permanent,0) AS permanent, m.expires_at, m.plan_name
     FROM users u LEFT JOIN sponsor_memberships m ON m.user_id=u.id ${where}
     ORDER BY u.id LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all()
  const total = await c.env.abdl_space_db.prepare(
    `SELECT COUNT(*) AS total FROM users u LEFT JOIN sponsor_memberships m ON m.user_id=u.id ${where}`
  ).bind(...params).first<{ total: number }>()
  return c.json({
    items: rows.results.map(row => ({
      id: row.id, username: row.username, avatar: row.avatar || null,
      sponsor: {
        active: !!row.active, permanent: !!row.permanent,
        expires_at: row.permanent ? null : row.expires_at, plan_name: row.plan_name || null,
        color_key: null, color_light: null, color_dark: null,
      },
    })),
    total: total?.total ?? 0,
  })
})

adminSponsors.get('/users/:id', sponsorAdminMiddleware, async c => {
  const userId = sponsorInteger(Number(c.req.param('id')), 1, 9223372036854770000, '用户标识')
  return c.json(await getSponsorMe(c.env, userId))
})

adminSponsors.post('/users/:id/grants', sponsorAdminMiddleware, async c => {
  const body = await requestBody(c.req.raw)
  return c.json(await mutateSponsorUser(c.env, c.get('user').sub, sponsorInteger(Number(c.req.param('id')), 1, 9223372036854770000, '用户标识'), 'grant', body))
})

adminSponsors.post('/users/:id/revoke', sponsorAdminMiddleware, async c => {
  const body = await requestBody(c.req.raw)
  return c.json(await mutateSponsorUser(c.env, c.get('user').sub, sponsorInteger(Number(c.req.param('id')), 1, 9223372036854770000, '用户标识'), 'revoke', body))
})

adminSponsors.post('/users/:id/quota', sponsorAdminMiddleware, async c => {
  const body = await requestBody(c.req.raw)
  return c.json(await mutateSponsorUser(c.env, c.get('user').sub, sponsorInteger(Number(c.req.param('id')), 1, 9223372036854770000, '用户标识'), 'quota', body))
})

adminSponsors.get('/codes', sponsorAdminMiddleware, async c => {
  const { limit, offset } = sponsorPagination(c.req.query())
  const planId = c.req.query('plan_id') ? identifier(c.req.query('plan_id')) : null
  const state = c.req.query('state') ?? null
  if (state && !['active', 'disabled', 'expired', 'redeemed'].includes(state)) throw new SponsorError('invalid_request', '状态筛选不正确')
  const q = (c.req.query('q') ?? '').trim()
  const params: (string | number)[] = []
  const conditions = ['1=1']
  if (planId) { conditions.push('c.plan_id=?'); params.push(planId) }
  if (state) {
    const mapping: Record<string, string> = {
      redeemed: 'c.redeemed_at IS NOT NULL',
      disabled: 'c.redeemed_at IS NULL AND c.disabled=1',
      expired: 'c.redeemed_at IS NULL AND c.disabled=0 AND c.expires_at IS NOT NULL AND c.expires_at<=unixepoch()',
      active: 'c.redeemed_at IS NULL AND c.disabled=0 AND (c.expires_at IS NULL OR c.expires_at>unixepoch())',
    }
    conditions.push(`(${mapping[state]})`)
  }
  // 仅支持完整兑换码精确检索；数据库只存哈希，不保存明文。
  if (q) {
    if (!/^[A-Za-z0-9-]{8,100}$/.test(q.replace(/\s/g, '').toUpperCase())) throw new SponsorError('invalid_request', '兑换码格式不正确')
    const { sponsorHash } = await import('../lib/sponsors.ts')
    conditions.push('c.code_hash=?')
    params.push(await sponsorHash(q.replace(/\s/g, '').toUpperCase()))
  }
  const rows = await c.env.abdl_space_db.prepare(
    `SELECT c.id, c.batch_id, c.plan_id, p.plan_json->>'$.name' AS plan_name, c.masked_code,
       c.disabled, c.expires_at, c.redeemed_at, c.redeemed_by, u.username AS redeemed_by_username
     FROM sponsor_codes c
     JOIN sponsor_plans p ON p.id=c.plan_id
     LEFT JOIN users u ON u.id=c.redeemed_by
     WHERE ${conditions.join(' AND ')}
     ORDER BY c.created_at DESC, c.id DESC LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all()
  const total = await c.env.abdl_space_db.prepare(
    `SELECT COUNT(*) AS total FROM sponsor_codes c WHERE ${conditions.join(' AND ')}`
  ).bind(...params).first<{ total: number }>()
  return c.json({
    items: rows.results.map(row => ({
      id: row.id, masked_code: row.masked_code, batch_id: row.batch_id, plan_id: row.plan_id,
      plan_name: row.plan_name,
      state: row.redeemed_at ? 'redeemed' : row.disabled ? 'disabled'
        : (row.expires_at != null && Number(row.expires_at) <= Math.floor(Date.now() / 1000)) ? 'expired' : 'active',
      expires_at: row.expires_at, redeemed_at: row.redeemed_at,
      redeemed_by: row.redeemed_by, redeemed_by_username: row.redeemed_by_username || null,
    })),
    total: total?.total ?? 0,
  })
})

adminSponsors.post('/code-batches', sponsorAdminMiddleware, async c => {
  const b = sponsorObject(await requestBody(c.req.raw))
  const planId = identifier(b.plan_id)
  const count = sponsorInteger(b.count, 1, 200, '数量')
  const expiresAt = b.expires_at == null ? null : sponsorInteger(b.expires_at, 1, 253402300799, '过期时间')
  const operationId = typeof b.operation_id === 'string' ? b.operation_id : crypto.randomUUID()
  const reason = sponsorText(b.reason, '操作原因', 500)
  const created = await createSponsorCodeBatch(c.env, { planId, count, expiresAt, operationId, reason, actorId: String(c.get('user').sub), source: 'admin' })
  return c.json(created, 201)
})

adminSponsors.post('/code-batches/:id/export', sponsorAdminMiddleware, async c => {
  const body = await requestBody(c.req.raw)
  const reason = sponsorText(sponsorObject(body).reason, '操作原因', 500)
  const batchId = identifier(c.req.param('id'))
  await c.env.abdl_space_db.prepare(
    "INSERT INTO sponsor_audit(id,actor_id,user_id,action,reason) VALUES(?,?,NULL,'code_batch_export',?)"
  ).bind(crypto.randomUUID(), String(c.get('user').sub), `${reason}（批次 ${batchId}）`).run()
  const codes = await exportSponsorCodeBatch(c.env, batchId)
  return c.json({ id: batchId, codes })
})

adminSponsors.post('/codes/:id/state', sponsorAdminMiddleware, async c => {
  const b = sponsorObject(await requestBody(c.req.raw))
  const disabled = b.disabled === true
  if (typeof b.disabled !== 'boolean') throw new SponsorError('invalid_request', 'disabled 必须为布尔值')
  const reason = sponsorText(b.reason, '操作原因', 500)
  const result = await c.env.abdl_space_db.prepare(
    'UPDATE sponsor_codes SET disabled=? WHERE id=? AND redeemed_at IS NULL'
  ).bind(disabled ? 1 : 0, c.req.param('id')).run()
  if (result.meta.changes !== 1) throw new SponsorError('code_unavailable', '兑换码不存在或已被使用', 409)
  await c.env.abdl_space_db.prepare(
    "INSERT INTO sponsor_audit(id,actor_id,user_id,action,reason) VALUES(?,?,NULL,?,?)"
  ).bind(crypto.randomUUID(), String(c.get('user').sub), disabled ? 'code_disable' : 'code_enable', reason).run()
  return c.json({ id: c.req.param('id'), state: disabled ? 'disabled' : 'active' })
})

adminSponsors.get('/audit', sponsorAdminMiddleware, async c => {
  const { limit, offset } = sponsorPagination(c.req.query())
  const rows = await c.env.abdl_space_db.prepare(
    'SELECT id, actor_id, user_id, action, reason, created_at FROM sponsor_audit ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?'
  ).bind(limit, offset).all()
  const total = await c.env.abdl_space_db.prepare('SELECT COUNT(*) AS total FROM sponsor_audit').first<{ total: number }>()
  return c.json({ items: rows.results, total: total?.total ?? 0 })
})

export default adminSponsors
