import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Context } from 'hono'
import type { Env } from '../types/index.ts'
import { assertSessionNotStale } from '../middleware/auth.ts'
import { mastodonAuthDetails, type MastodonAuthResult } from '../mastodon/shared.ts'

interface AppType {
	Bindings: Env
}

interface EligibilityRow {
	account_age_eligible: number
	post_eligible: number
}

interface NovelRow {
	id: string
	author_id: number
	title: string
	description: string
	category: string
	status: string
	idempotency_key: string | null
	created_at: number
	updated_at: number
	deleted_at: number | null
}

const MAX_JSON_BYTES = 16 * 1024
const TITLE_LIMIT = 120
const DESCRIPTION_LIMIT = 2000
const IDEMPOTENCY_KEY_LIMIT = 128
const MAX_ACTIVE_WORKS = 100
const CATEGORIES = new Set(['fiction', 'fantasy', 'romance', 'science_fiction', 'mystery', 'history', 'essay', 'other'])

const novelAuthoring = new Hono<AppType>()

novelAuthoring.use('*', cors({
	origin: '*',
	allowMethods: ['GET', 'POST', 'OPTIONS'],
	allowHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
}))

async function authenticate(c: Context<AppType>, scope: 'read' | 'write'): Promise<MastodonAuthResult | Response> {
	const auth = await mastodonAuthDetails(c)
	if (!auth) return c.json({ error: 'The access token is invalid', code: 'unauthorized' }, 401)
	if (auth.tokenType === 'oauth' && !auth.scopes.includes(scope)) {
		return c.json({ error: 'Insufficient OAuth scope', code: 'insufficient_scope' }, 403)
	}
	if (auth.tokenType === 'jwt' && await assertSessionNotStale(auth.user, c.env.abdl_space_db)) {
		return c.json({ error: 'The access token is invalid', code: 'unauthorized' }, 401)
	}
	return auth
}

async function readJsonObjectLimited(c: Context<AppType>): Promise<Record<string, unknown> | null | 'too_large'> {
	const contentLength = c.req.header('Content-Length')
	if (contentLength !== undefined) {
		const declared = Number(contentLength)
		if (!Number.isSafeInteger(declared) || declared < 0) return null
		if (declared > MAX_JSON_BYTES) return 'too_large'
	}
	try {
		const reader = c.req.raw.body?.getReader()
		if (!reader) return {}
		const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
		let bytesRead = 0
		let text = ''
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			bytesRead += value.byteLength
			if (bytesRead > MAX_JSON_BYTES) {
				await reader.cancel()
				return 'too_large'
			}
			text += decoder.decode(value, { stream: true })
		}
		text += decoder.decode()
		const value: unknown = text.trim() ? JSON.parse(text) : {}
		return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
	} catch {
		return null
	}
}

async function getEligibility(db: D1Database, authorId: number) {
	const row = await db.prepare(`
		SELECT
			CASE WHEN datetime(created_at) <= datetime('now', '-72 hours') THEN 1 ELSE 0 END AS account_age_eligible,
			CASE WHEN EXISTS (SELECT 1 FROM posts WHERE user_id = users.id) THEN 1 ELSE 0 END AS post_eligible
		FROM users WHERE id = ?
	`).bind(authorId).first<EligibilityRow>()
	if (!row) return null
	const accountAgeEligible = row.account_age_eligible === 1
	const postEligible = row.post_eligible === 1
	return {
		eligible: accountAgeEligible && postEligible,
		account_age_eligible: accountAgeEligible,
		post_eligible: postEligible,
		reasons: [
			...(accountAgeEligible ? [] : ['account_too_new']),
			...(postEligible ? [] : ['post_required']),
		],
	}
}

function safeNovelResponse(row: NovelRow) {
	return {
		id: row.id,
		title: row.title,
		description: row.description,
		category: row.category,
		status: row.status,
		created_at: row.created_at,
		updated_at: row.updated_at,
	}
}

async function getOwnedNovel(db: D1Database, authorId: number, id: string) {
	return db.prepare(`
		SELECT id, author_id, title, description, category, status, idempotency_key, created_at, updated_at, deleted_at
		FROM novels WHERE author_id = ? AND id = ? AND deleted_at IS NULL
	`).bind(authorId, id).first<NovelRow>()
}

novelAuthoring.get('/eligibility', async c => {
	const auth = await authenticate(c, 'read')
	if (auth instanceof Response) return auth
	try {
		const eligibility = await getEligibility(c.env.abdl_space_db, auth.user.sub)
		if (!eligibility) return c.json({ error: 'Account not found', code: 'account_not_found' }, 404)
		return c.json(eligibility)
	} catch {
		return c.json({ error: 'Author eligibility query failed', code: 'eligibility_query_failed' }, 500)
	}
})

novelAuthoring.get('/works', async c => {
	const auth = await authenticate(c, 'read')
	if (auth instanceof Response) return auth
	try {
		const result = await c.env.abdl_space_db.prepare(`
			SELECT id, author_id, title, description, category, status, idempotency_key, created_at, updated_at, deleted_at
			FROM novels WHERE author_id = ? AND deleted_at IS NULL
			ORDER BY updated_at DESC, id DESC
		`).bind(auth.user.sub).all<NovelRow>()
		if (!result.success) throw new Error('Database query failed')
		return c.json({ items: result.results.map(safeNovelResponse) })
	} catch {
		return c.json({ error: 'Author works query failed', code: 'works_query_failed' }, 500)
	}
})

novelAuthoring.get('/works/:id', async c => {
	const auth = await authenticate(c, 'read')
	if (auth instanceof Response) return auth
	try {
		const work = await getOwnedNovel(c.env.abdl_space_db, auth.user.sub, c.req.param('id'))
		if (!work) return c.json({ error: 'Author work not found', code: 'work_not_found' }, 404)
		return c.json(safeNovelResponse(work))
	} catch {
		return c.json({ error: 'Author work query failed', code: 'work_query_failed' }, 500)
	}
})

novelAuthoring.post('/works', async c => {
	const auth = await authenticate(c, 'write')
	if (auth instanceof Response) return auth
	const idempotencyKey = c.req.header('Idempotency-Key')?.trim() ?? ''
	if (!idempotencyKey || idempotencyKey.length > IDEMPOTENCY_KEY_LIMIT) {
		return c.json({ error: 'A valid idempotency key is required', code: 'invalid_idempotency_key' }, 400)
	}
	const input = await readJsonObjectLimited(c)
	if (input === 'too_large') return c.json({ error: 'Create work request is too large', code: 'request_too_large' }, 413)
	if (!input) return c.json({ error: 'Invalid create work request', code: 'invalid_work' }, 400)
	const title = typeof input.title === 'string' ? input.title.trim() : ''
	const description = typeof input.description === 'string' ? input.description.trim() : ''
	const category = typeof input.category === 'string' ? input.category.trim() : ''
	if (!title || title.length > TITLE_LIMIT || description.length > DESCRIPTION_LIMIT || !CATEGORIES.has(category)) {
		return c.json({ error: 'Invalid author work metadata', code: 'invalid_work' }, 400)
	}
	try {
		const existing = await c.env.abdl_space_db.prepare(`
			SELECT id, author_id, title, description, category, status, idempotency_key, created_at, updated_at, deleted_at
			FROM novels WHERE author_id = ? AND idempotency_key = ?
		`).bind(auth.user.sub, idempotencyKey).first<NovelRow>()
		if (existing) {
			if (existing.deleted_at !== null || existing.title !== title || existing.description !== description || existing.category !== category) {
				return c.json({ error: 'Idempotency key metadata conflict', code: 'work_conflict' }, 409)
			}
			return c.json(safeNovelResponse(existing))
		}

		const id = crypto.randomUUID()
		const result = await c.env.abdl_space_db.prepare(`
			INSERT OR IGNORE INTO novels (id, author_id, title, description, category, status, idempotency_key)
			SELECT ?, users.id, ?, ?, ?, 'draft', ? FROM users
			WHERE users.id = ?
				AND datetime(users.created_at) <= datetime('now', '-72 hours')
				AND EXISTS (SELECT 1 FROM posts WHERE posts.user_id = users.id)
				AND (SELECT COUNT(*) FROM novels WHERE author_id = users.id AND deleted_at IS NULL) < ?
		`).bind(id, title, description, category, idempotencyKey, auth.user.sub, MAX_ACTIVE_WORKS).run()
		if (!result.success) throw new Error('Database operation failed')
		if (result.meta.changes === 1) {
			const created = await getOwnedNovel(c.env.abdl_space_db, auth.user.sub, id)
			if (!created) throw new Error('Created work not found')
			return c.json(safeNovelResponse(created), 201)
		}

		const concurrent = await c.env.abdl_space_db.prepare(`
			SELECT id, author_id, title, description, category, status, idempotency_key, created_at, updated_at, deleted_at
			FROM novels WHERE author_id = ? AND idempotency_key = ?
		`).bind(auth.user.sub, idempotencyKey).first<NovelRow>()
		if (concurrent) {
			if (concurrent.deleted_at !== null || concurrent.title !== title || concurrent.description !== description || concurrent.category !== category) {
				return c.json({ error: 'Idempotency key metadata conflict', code: 'work_conflict' }, 409)
			}
			return c.json(safeNovelResponse(concurrent))
		}

		const eligibility = await getEligibility(c.env.abdl_space_db, auth.user.sub)
		if (!eligibility) return c.json({ error: 'Account not found', code: 'account_not_found' }, 404)
		if (!eligibility.eligible) return c.json({ error: 'Author eligibility requirements are not met', code: 'author_ineligible', eligibility }, 403)
		const count = await c.env.abdl_space_db.prepare(`
			SELECT COUNT(*) AS count FROM novels WHERE author_id = ? AND deleted_at IS NULL
		`).bind(auth.user.sub).first<{ count: number }>()
		if (Number(count?.count ?? 0) >= MAX_ACTIVE_WORKS) {
			return c.json({ error: 'Author work limit reached', code: 'work_limit' }, 429)
		}
		return c.json({ error: 'Author work state changed', code: 'work_conflict' }, 409)
	} catch {
		return c.json({ error: 'Author work creation failed', code: 'create_work_failed' }, 500)
	}
})

export default novelAuthoring
