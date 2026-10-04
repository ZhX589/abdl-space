import type { Context, Next } from 'hono'
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types'
import type { Env, JWTPayload } from '../types/index.ts'
import { queryOne } from './db.ts'

/** Super-admin is a projection of the current users row, never a stored role or JWT claim. */
export function isSuperAdmin(id: number, role: unknown, banned: unknown = false): boolean {
  return id === 1 && role === 'admin' && !banned
}

/** Account 1 is reserved even if misconfigured; unknown roles are not ordinary users. */
export function isProtectedAccount(id: number, role: unknown): boolean {
  return id === 1 || role !== 'user'
}

/** Strict canonical positive SQLite/API user identifier. */
export function parseUserId(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) ? id : null
}

/** SQL assertion: failure aborts and rolls back the whole D1 batch (SQLite integer overflow). */
export function transactionGuard(db: D1Database, predicate: string, params: unknown[]): D1PreparedStatement {
  return db.prepare(`SELECT CASE WHEN ${predicate} THEN 1 ELSE abs(-9223372036854775808) END AS allowed`).bind(...params)
}

/** Commit related account mutations as one transaction; never accept unsuccessful D1 results. */
export async function guardedBatch(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  const results = await db.batch(statements)
  if (results.length !== statements.length || results.some(result => !result.success)) {
    throw new Error('Account operation failed')
  }
}

/** Recheck after transaction failure to distinguish revoked/protected accounts from genuine DB errors. */
export async function accountMutationDenied(db: D1Database, targetId: number, actorId: number): Promise<boolean> {
  const target = await queryOne<{ id: number; role: string }>(db, 'SELECT id, role FROM users WHERE id = ?', [targetId])
  const actor = await queryOne<{ role: string; banned?: number }>(db, 'SELECT * FROM users WHERE id = ?', [actorId])
  return !target || isProtectedAccount(targetId, target.role) || !actor || actor.role !== 'admin' || !!actor.banned
}

/** Fixed actor predicate supports existing databases without a banned column; all failures propagate. */
export async function adminActorPredicate(db: D1Database): Promise<string> {
  const banned = await queryOne<{ name: string }>(db, "SELECT name FROM pragma_table_info('users') WHERE name = ?", ['banned'])
  return `EXISTS (SELECT 1 FROM users WHERE id = ? AND role = 'admin'${banned ? ' AND COALESCE(banned, 0) = 0' : ''})`
}

const ROLE_ORIGINS = new Set([
  'https://abdl-space.top', 'https://www.abdl-space.top', 'https://m.abdl-space.top',
  'https://wiki.abdl-space.top', 'http://localhost:5173', 'http://localhost:5174',
])

/** Role changes require explicit JSON, trusted browser origin, and OAuth admin+write scopes. */
export async function roleRequestSafety(c: Context<{ Bindings: Env; Variables: { user: JWTPayload } }>, next: Next): Promise<Response | void> {
  const mediaType = c.req.header('Content-Type')?.split(';')[0].trim().toLowerCase()
  if (mediaType !== 'application/json') return c.json({ error: 'JSON request required' }, 415)
  const origin = c.req.header('Origin')
  const site = c.req.header('Sec-Fetch-Site')
  if ((origin !== undefined && !ROLE_ORIGINS.has(origin)) || site === 'cross-site') {
    return c.json({ error: 'Request origin rejected' }, 403)
  }
  // A cookie-only browser mutation must prove its origin; native bearer requests may omit it.
  if (!origin) {
    const { extractBearerUser } = await import('../middleware/auth.ts')
    const bearer = await extractBearerUser(c)
    // An invalid Authorization header may have fallen back to a valid cookie in adminMiddleware.
    if (!bearer || bearer.sub !== c.get('user').sub) return c.json({ error: 'Request origin required' }, 403)
  }
  const scopes = c.get('user').oauth_scopes
  if (scopes && (!scopes.includes('admin') || !scopes.includes('write'))) {
    return c.json({ error: 'OAuth admin and write scopes required' }, 403)
  }
  await next()
}
