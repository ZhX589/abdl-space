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

interface VolumeRow {
	id: string
	novel_id: string
	title: string
	sort_order: number
	idempotency_key: string | null
	created_at: number
	updated_at: number
	deleted_at: number | null
}

interface ChapterRow {
	id: string
	novel_id: string
	volume_id: string
	title: string
	sort_order: number
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
	allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
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

function safeVolumeResponse(row: VolumeRow) {
	return { id: row.id, title: row.title, sort_order: row.sort_order, created_at: row.created_at, updated_at: row.updated_at }
}

function safeChapterResponse(row: ChapterRow) {
	return { id: row.id, volume_id: row.volume_id, title: row.title, sort_order: row.sort_order, created_at: row.created_at, updated_at: row.updated_at }
}

async function getOwnedVolume(db: D1Database, authorId: number, novelId: string, volumeId: string) {
	return db.prepare(`SELECT v.id, v.novel_id, v.title, v.sort_order, v.idempotency_key, v.created_at, v.updated_at, v.deleted_at
		FROM novel_volumes v JOIN novels n ON n.id = v.novel_id
		WHERE n.author_id = ? AND n.id = ? AND n.deleted_at IS NULL AND v.id = ? AND v.deleted_at IS NULL`)
		.bind(authorId, novelId, volumeId).first<VolumeRow>()
}

async function getOwnedChapter(db: D1Database, authorId: number, novelId: string, volumeId: string, chapterId: string) {
	return db.prepare(`SELECT c.id, c.novel_id, c.volume_id, c.title, c.sort_order, c.idempotency_key, c.created_at, c.updated_at, c.deleted_at
		FROM novel_chapters c JOIN novels n ON n.id = c.novel_id
		WHERE n.author_id = ? AND n.id = ? AND n.deleted_at IS NULL AND c.volume_id = ? AND c.id = ? AND c.deleted_at IS NULL`)
		.bind(authorId, novelId, volumeId, chapterId).first<ChapterRow>()
}

function validTitle(input: Record<string, unknown>) {
	const title = typeof input.title === 'string' ? input.title.trim() : ''
	return title && title.length <= TITLE_LIMIT ? title : null
}

function validSortOrder(value: unknown): number | undefined | null {
	if (value === undefined) return undefined
	return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
}

function idempotencyKey(c: Context<AppType>) {
	const key = c.req.header('Idempotency-Key')?.trim() ?? ''
	return key && key.length <= IDEMPOTENCY_KEY_LIMIT ? key : null
}

async function editableWork(db: D1Database, authorId: number, novelId: string): Promise<NovelRow | Response | null> {
	const work = await getOwnedNovel(db, authorId, novelId)
	return work
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

novelAuthoring.get('/works/:id/structure', async c => {
	const auth = await authenticate(c, 'read')
	if (auth instanceof Response) return auth
	try {
		const work = await getOwnedNovel(c.env.abdl_space_db, auth.user.sub, c.req.param('id'))
		if (!work) return c.json({ error: 'Author work not found', code: 'work_not_found' }, 404)
		const volumes = await c.env.abdl_space_db.prepare(`SELECT id, novel_id, title, sort_order, idempotency_key, created_at, updated_at, deleted_at
			FROM novel_volumes WHERE novel_id = ? AND deleted_at IS NULL ORDER BY sort_order, id`).bind(work.id).all<VolumeRow>()
		const chapters = await c.env.abdl_space_db.prepare(`SELECT id, novel_id, volume_id, title, sort_order, idempotency_key, created_at, updated_at, deleted_at
			FROM novel_chapters WHERE novel_id = ? AND deleted_at IS NULL ORDER BY volume_id, sort_order, id`).bind(work.id).all<ChapterRow>()
		if (!volumes.success || !chapters.success) throw new Error('Database query failed')
		return c.json({
			work: safeNovelResponse(work),
			volumes: volumes.results.map(volume => ({ ...safeVolumeResponse(volume), chapters: chapters.results.filter(chapter => chapter.volume_id === volume.id).map(safeChapterResponse) })),
		})
	} catch {
		return c.json({ error: 'Author structure query failed', code: 'structure_query_failed' }, 500)
	}
})

novelAuthoring.post('/works/:id/volumes', async c => {
	const auth = await authenticate(c, 'write')
	if (auth instanceof Response) return auth
	const key = idempotencyKey(c)
	if (!key) return c.json({ error: 'A valid idempotency key is required', code: 'invalid_idempotency_key' }, 400)
	const input = await readJsonObjectLimited(c)
	if (input === 'too_large') return c.json({ error: 'Request is too large', code: 'request_too_large' }, 413)
	const title = input && validTitle(input)
	if (!input || !title) return c.json({ error: 'Invalid volume', code: 'invalid_volume' }, 400)
	try {
		const work = await editableWork(c.env.abdl_space_db, auth.user.sub, c.req.param('id'))
		if (!work) return c.json({ error: 'Author work not found', code: 'work_not_found' }, 404)
		if (work instanceof Response) return work
		if (work.status !== 'draft') return c.json({ error: 'Author work is not editable', code: 'work_not_editable' }, 409)
		const existing = await c.env.abdl_space_db.prepare(`SELECT id, novel_id, title, sort_order, idempotency_key, created_at, updated_at, deleted_at FROM novel_volumes WHERE novel_id = ? AND idempotency_key = ?`).bind(work.id, key).first<VolumeRow>()
		if (existing) return existing.deleted_at === null && existing.title === title ? c.json(safeVolumeResponse(existing)) : c.json({ error: 'Volume conflict', code: 'volume_conflict' }, 409)
		const id = crypto.randomUUID()
		const result = await c.env.abdl_space_db.prepare(`INSERT OR IGNORE INTO novel_volumes (id, novel_id, title, sort_order, idempotency_key)
			SELECT ?, n.id, ?, COALESCE((SELECT MAX(v.sort_order) + 10 FROM novel_volumes v WHERE v.novel_id = n.id AND v.deleted_at IS NULL), 0), ?
			FROM novels n WHERE n.id = ? AND n.author_id = ? AND n.status = 'draft' AND n.deleted_at IS NULL`)
			.bind(id, title, key, work.id, auth.user.sub).run()
		if (!result.success) throw new Error('Database operation failed')
		const created = result.meta.changes === 1 ? await getOwnedVolume(c.env.abdl_space_db, auth.user.sub, work.id, id)
			: await c.env.abdl_space_db.prepare(`SELECT id, novel_id, title, sort_order, idempotency_key, created_at, updated_at, deleted_at FROM novel_volumes WHERE novel_id = ? AND idempotency_key = ?`).bind(work.id, key).first<VolumeRow>()
		if (!created || created.deleted_at !== null || created.title !== title) return c.json({ error: 'Volume conflict', code: 'volume_conflict' }, 409)
		return c.json(safeVolumeResponse(created), result.meta.changes === 1 ? 201 : 200)
	} catch {
		return c.json({ error: 'Volume creation failed', code: 'create_volume_failed' }, 500)
	}
})

novelAuthoring.post('/works/:id/volumes/:volumeId/chapters', async c => {
	const auth = await authenticate(c, 'write')
	if (auth instanceof Response) return auth
	const key = idempotencyKey(c)
	if (!key) return c.json({ error: 'A valid idempotency key is required', code: 'invalid_idempotency_key' }, 400)
	const input = await readJsonObjectLimited(c)
	if (input === 'too_large') return c.json({ error: 'Request is too large', code: 'request_too_large' }, 413)
	const title = input && validTitle(input)
	if (!input || !title) return c.json({ error: 'Invalid chapter', code: 'invalid_chapter' }, 400)
	try {
		const work = await getOwnedNovel(c.env.abdl_space_db, auth.user.sub, c.req.param('id'))
		if (!work) return c.json({ error: 'Author work not found', code: 'work_not_found' }, 404)
		if (work.status !== 'draft') return c.json({ error: 'Author work is not editable', code: 'work_not_editable' }, 409)
		const volume = await getOwnedVolume(c.env.abdl_space_db, auth.user.sub, work.id, c.req.param('volumeId'))
		if (!volume) return c.json({ error: 'Volume not found', code: 'volume_not_found' }, 404)
		const existing = await c.env.abdl_space_db.prepare(`SELECT id, novel_id, volume_id, title, sort_order, idempotency_key, created_at, updated_at, deleted_at FROM novel_chapters WHERE volume_id = ? AND idempotency_key = ?`).bind(volume.id, key).first<ChapterRow>()
		if (existing) return existing.deleted_at === null && existing.title === title ? c.json(safeChapterResponse(existing)) : c.json({ error: 'Chapter conflict', code: 'chapter_conflict' }, 409)
		const id = crypto.randomUUID()
		const result = await c.env.abdl_space_db.prepare(`INSERT OR IGNORE INTO novel_chapters (id, novel_id, volume_id, title, sort_order, idempotency_key)
			SELECT ?, n.id, v.id, ?, COALESCE((SELECT MAX(c.sort_order) + 10 FROM novel_chapters c WHERE c.volume_id = v.id AND c.deleted_at IS NULL), 0), ?
			FROM novel_volumes v JOIN novels n ON n.id = v.novel_id
			WHERE n.id = ? AND n.author_id = ? AND n.status = 'draft' AND n.deleted_at IS NULL AND v.id = ? AND v.deleted_at IS NULL`)
			.bind(id, title, key, work.id, auth.user.sub, volume.id).run()
		if (!result.success) throw new Error('Database operation failed')
		const created = result.meta.changes === 1 ? await getOwnedChapter(c.env.abdl_space_db, auth.user.sub, work.id, volume.id, id)
			: await c.env.abdl_space_db.prepare(`SELECT id, novel_id, volume_id, title, sort_order, idempotency_key, created_at, updated_at, deleted_at FROM novel_chapters WHERE volume_id = ? AND idempotency_key = ?`).bind(volume.id, key).first<ChapterRow>()
		if (!created || created.deleted_at !== null || created.title !== title) return c.json({ error: 'Chapter conflict', code: 'chapter_conflict' }, 409)
		return c.json(safeChapterResponse(created), result.meta.changes === 1 ? 201 : 200)
	} catch {
		return c.json({ error: 'Chapter creation failed', code: 'create_chapter_failed' }, 500)
	}
})

novelAuthoring.patch('/works/:id/volumes/:volumeId', async c => {
	const auth = await authenticate(c, 'write')
	if (auth instanceof Response) return auth
	const input = await readJsonObjectLimited(c)
	if (input === 'too_large') return c.json({ error: 'Request is too large', code: 'request_too_large' }, 413)
	if (!input) return c.json({ error: 'Invalid volume', code: 'invalid_volume' }, 400)
	const title = input.title === undefined ? undefined : validTitle(input)
	const sortOrder = validSortOrder(input.sort_order)
	if ((title === undefined && sortOrder === undefined) || title === null || sortOrder === null) return c.json({ error: 'Invalid volume', code: 'invalid_volume' }, 400)
	try {
		const work = await getOwnedNovel(c.env.abdl_space_db, auth.user.sub, c.req.param('id'))
		if (!work) return c.json({ error: 'Author work not found', code: 'work_not_found' }, 404)
		if (work.status !== 'draft') return c.json({ error: 'Author work is not editable', code: 'work_not_editable' }, 409)
		const volume = await getOwnedVolume(c.env.abdl_space_db, auth.user.sub, work.id, c.req.param('volumeId'))
		if (!volume) return c.json({ error: 'Volume not found', code: 'volume_not_found' }, 404)
		const result = await c.env.abdl_space_db.prepare(`UPDATE novel_volumes SET title = COALESCE(?, title), sort_order = COALESCE(?, sort_order), updated_at = unixepoch()
			WHERE id = ? AND novel_id = ? AND deleted_at IS NULL AND EXISTS (
				SELECT 1 FROM novels n WHERE n.id = novel_volumes.novel_id AND n.author_id = ? AND n.status = 'draft' AND n.deleted_at IS NULL
			)`).bind(title ?? null, sortOrder ?? null, volume.id, work.id, auth.user.sub).run()
		if (!result.success) throw new Error('Database operation failed')
		if (result.meta.changes !== 1) return c.json({ error: 'Author work is not editable', code: 'work_not_editable' }, 409)
		return c.json(safeVolumeResponse({ ...volume, title: title ?? volume.title, sort_order: sortOrder ?? volume.sort_order, updated_at: Math.floor(Date.now() / 1000) }))
	} catch {
		return c.json({ error: 'Volume update failed', code: 'update_volume_failed' }, 500)
	}
})

novelAuthoring.patch('/works/:id/volumes/:volumeId/chapters/:chapterId', async c => {
	const auth = await authenticate(c, 'write')
	if (auth instanceof Response) return auth
	const input = await readJsonObjectLimited(c)
	if (input === 'too_large') return c.json({ error: 'Request is too large', code: 'request_too_large' }, 413)
	if (!input) return c.json({ error: 'Invalid chapter', code: 'invalid_chapter' }, 400)
	const title = input.title === undefined ? undefined : validTitle(input)
	const sortOrder = validSortOrder(input.sort_order)
	if ((title === undefined && sortOrder === undefined) || title === null || sortOrder === null) return c.json({ error: 'Invalid chapter', code: 'invalid_chapter' }, 400)
	try {
		const work = await getOwnedNovel(c.env.abdl_space_db, auth.user.sub, c.req.param('id'))
		if (!work) return c.json({ error: 'Author work not found', code: 'work_not_found' }, 404)
		if (work.status !== 'draft') return c.json({ error: 'Author work is not editable', code: 'work_not_editable' }, 409)
		const chapter = await getOwnedChapter(c.env.abdl_space_db, auth.user.sub, work.id, c.req.param('volumeId'), c.req.param('chapterId'))
		if (!chapter) return c.json({ error: 'Chapter not found', code: 'chapter_not_found' }, 404)
		const result = await c.env.abdl_space_db.prepare(`UPDATE novel_chapters SET title = COALESCE(?, title), sort_order = COALESCE(?, sort_order), updated_at = unixepoch()
			WHERE id = ? AND novel_id = ? AND volume_id = ? AND deleted_at IS NULL AND EXISTS (
				SELECT 1 FROM novels n JOIN novel_volumes v ON v.novel_id = n.id
				WHERE n.id = novel_chapters.novel_id AND n.author_id = ? AND n.status = 'draft' AND n.deleted_at IS NULL
					AND v.id = novel_chapters.volume_id AND v.deleted_at IS NULL
			)`).bind(title ?? null, sortOrder ?? null, chapter.id, work.id, chapter.volume_id, auth.user.sub).run()
		if (!result.success) throw new Error('Database operation failed')
		if (result.meta.changes !== 1) return c.json({ error: 'Author work is not editable', code: 'work_not_editable' }, 409)
		return c.json(safeChapterResponse({ ...chapter, title: title ?? chapter.title, sort_order: sortOrder ?? chapter.sort_order, updated_at: Math.floor(Date.now() / 1000) }))
	} catch {
		return c.json({ error: 'Chapter update failed', code: 'update_chapter_failed' }, 500)
	}
})

novelAuthoring.delete('/works/:id/volumes/:volumeId/chapters/:chapterId', async c => {
	const auth = await authenticate(c, 'write')
	if (auth instanceof Response) return auth
	try {
		const work = await getOwnedNovel(c.env.abdl_space_db, auth.user.sub, c.req.param('id'))
		if (!work) return c.json({ error: 'Author work not found', code: 'work_not_found' }, 404)
		if (work.status !== 'draft') return c.json({ error: 'Author work is not editable', code: 'work_not_editable' }, 409)
		const chapter = await getOwnedChapter(c.env.abdl_space_db, auth.user.sub, work.id, c.req.param('volumeId'), c.req.param('chapterId'))
		if (!chapter) return c.json({ id: c.req.param('chapterId'), deleted: true })
		const result = await c.env.abdl_space_db.prepare(`UPDATE novel_chapters SET deleted_at = unixepoch(), updated_at = unixepoch()
			WHERE id = ? AND novel_id = ? AND volume_id = ? AND deleted_at IS NULL AND EXISTS (
				SELECT 1 FROM novels n JOIN novel_volumes v ON v.novel_id = n.id
				WHERE n.id = novel_chapters.novel_id AND n.author_id = ? AND n.status = 'draft' AND n.deleted_at IS NULL
					AND v.id = novel_chapters.volume_id AND v.deleted_at IS NULL
			)`).bind(chapter.id, work.id, chapter.volume_id, auth.user.sub).run()
		if (!result.success) throw new Error('Database operation failed')
		return c.json({ id: chapter.id, deleted: true })
	} catch {
		return c.json({ error: 'Chapter deletion failed', code: 'delete_chapter_failed' }, 500)
	}
})

novelAuthoring.delete('/works/:id/volumes/:volumeId', async c => {
	const auth = await authenticate(c, 'write')
	if (auth instanceof Response) return auth
	try {
		const work = await getOwnedNovel(c.env.abdl_space_db, auth.user.sub, c.req.param('id'))
		if (!work) return c.json({ error: 'Author work not found', code: 'work_not_found' }, 404)
		if (work.status !== 'draft') return c.json({ error: 'Author work is not editable', code: 'work_not_editable' }, 409)
		const volume = await getOwnedVolume(c.env.abdl_space_db, auth.user.sub, work.id, c.req.param('volumeId'))
		if (!volume) return c.json({ id: c.req.param('volumeId'), deleted: true })
		const result = await c.env.abdl_space_db.prepare(`UPDATE novel_volumes SET deleted_at = unixepoch(), updated_at = unixepoch()
			WHERE id = ? AND novel_id = ? AND deleted_at IS NULL
				AND NOT EXISTS (SELECT 1 FROM novel_chapters c WHERE c.volume_id = novel_volumes.id AND c.deleted_at IS NULL)
				AND EXISTS (SELECT 1 FROM novels n WHERE n.id = novel_volumes.novel_id AND n.author_id = ? AND n.status = 'draft' AND n.deleted_at IS NULL)`)
			.bind(volume.id, work.id, auth.user.sub).run()
		if (!result.success) throw new Error('Database operation failed')
		if (result.meta.changes !== 1) {
			const count = await c.env.abdl_space_db.prepare(`SELECT COUNT(*) AS count FROM novel_chapters WHERE volume_id = ? AND deleted_at IS NULL`).bind(volume.id).first<{ count: number }>()
			if (Number(count?.count ?? 0) > 0) return c.json({ error: 'Volume is not empty', code: 'volume_not_empty' }, 409)
			return c.json({ error: 'Author work is not editable', code: 'work_not_editable' }, 409)
		}
		return c.json({ id: volume.id, deleted: true })
	} catch {
		return c.json({ error: 'Volume deletion failed', code: 'delete_volume_failed' }, 500)
	}
})

export default novelAuthoring
