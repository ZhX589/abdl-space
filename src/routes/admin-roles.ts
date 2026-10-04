import { Hono } from 'hono'
import type { AdminRoleResponse, Env, JWTPayload } from '../types/index.ts'
import { adminMiddleware } from '../middleware/auth.ts'
import { query, queryOne } from '../lib/db.ts'
import { adminActorPredicate, isSuperAdmin, parseUserId, roleRequestSafety } from '../lib/admin-security.ts'

const roles = new Hono<{ Bindings: Env; Variables: { user: JWTPayload } }>()
for (const path of ['/add', '/users/:id/role']) {
  roles.use(path, async (c, next) => { c.header('Cache-Control', 'private, no-store'); await next() })
  roles.use(path, adminMiddleware)
  roles.use(path, async (c, next) => {
    const actor = c.get('user')
    if (!isSuperAdmin(actor.sub, actor.role)) return c.json({ error: 'Super admin access required' }, 403)
    await next()
  })
  roles.use(path, roleRequestSafety)
}

roles.post('/add', async c => {
  const body: unknown = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !('user_ids' in body)) {
    return c.json({ error: 'user_ids must be a non-empty array' }, 400)
  }
  const ids = body.user_ids
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || ids.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) {
    return c.json({ error: 'user_ids must contain 1 to 100 distinct positive safe integers' }, 400)
  }
  try {
    const db = c.env.abdl_space_db
    const actor = await adminActorPredicate(db)
    const changed = await query<{ id: number }>(db,
      `UPDATE users SET role = 'admin' WHERE id IN (${ids.map(() => '?').join(',')}) AND role = 'user' AND ${actor} RETURNING id`,
      [...ids, c.get('user').sub])
    // Distinguish a demoted/deleted/banned actor from a valid idempotent zero-change request.
    if (!changed.length) {
      const liveActor = await queryOne<{ id: number }>(db, `SELECT id FROM users WHERE id = 1 AND ${actor}`, [1])
      if (!liveActor) return c.json({ error: 'Super admin access required' }, 403)
    }
    console.info(JSON.stringify({ event: 'admin_role_change', actor_id: 1, targets: changed.map(row => row.id), from_role: 'user', to_role: 'admin', result: 'success' }))
    return c.json({ promoted: changed.length, message: `${changed.length} 个用户已提升为管理员` })
  } catch {
    console.error(JSON.stringify({ event: 'admin_role_change', actor_id: 1, result: 'failed' }))
    return c.json({ error: '操作失败' }, 500)
  }
})

roles.patch('/users/:id/role', async c => {
  const id = parseUserId(c.req.param('id'))
  if (id === null) return c.json({ error: 'Invalid user id' }, 400)
  const body: unknown = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !('role' in body) || (body.role !== 'admin' && body.role !== 'user')) {
    return c.json({ error: 'role must be admin or user' }, 400)
  }
  if (id === 1 && body.role === 'user') return c.json({ error: 'Super admin cannot be demoted' }, 403)
  try {
    const db = c.env.abdl_space_db
    const target = await queryOne<{ id: number; role: string }>(db, 'SELECT id, role FROM users WHERE id = ?', [id])
    if (!target) return c.json({ error: 'User not found' }, 404)
    const actor = await adminActorPredicate(db)
    const row = await queryOne<AdminRoleResponse & { banned?: number }>(db,
      `UPDATE users SET role = ? WHERE id = ? AND role = ? AND ${actor} RETURNING *`,
      [body.role, id, target.role, c.get('user').sub])
    if (!row) return c.json({ error: 'Role or administrator changed; refresh and retry' }, 409)
    console.info(JSON.stringify({ event: 'admin_role_change', actor_id: 1, target_id: id, from_role: target.role, to_role: row.role, result: 'success' }))
    return c.json({ id: row.id, role: row.role, is_super_admin: isSuperAdmin(row.id, row.role, row.banned) } satisfies AdminRoleResponse)
  } catch {
    console.error(JSON.stringify({ event: 'admin_role_change', actor_id: 1, target_id: id, result: 'failed' }))
    return c.json({ error: '操作失败' }, 500)
  }
})

export default roles
