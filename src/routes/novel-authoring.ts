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

interface RevisionRow {
	id: string
	owner_id: number
	chapter_id: string
	body: string
	status: string
	version: number
	create_idempotency_key: string | null
	created_at: number
	updated_at: number
}

interface RevisionOperationRow {
	owner_id: number
	idempotency_key: string
	revision_id: string
	request_body: string
	request_base_version: number
	response_body: string
	response_chapter_id: string
	response_status: string
	response_version: number
	response_created_at: number
	response_updated_at: number
}

const MAX_JSON_BYTES = 16 * 1024
const TITLE_LIMIT = 120
const DESCRIPTION_LIMIT = 2000
const IDEMPOTENCY_KEY_LIMIT = 128
const MAX_ACTIVE_WORKS = 100
const MAX_REVISION_BODY_LENGTH = 500_000
const MAX_REVISION_JSON_BYTES = 2 * 1024 * 1024
const CATEGORIES = new Set(['fiction', 'fantasy', 'romance', 'science_fiction', 'mystery', 'history', 'essay', 'other'])

const novelAuthoring = new Hono<AppType>()

novelAuthoring.use('*', cors({
	origin: '*',
	allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
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

async function readJsonObjectLimited(c: Context<AppType>, maximumBytes = MAX_JSON_BYTES): Promise<Record<string, unknown> | null | 'too_large'> {
	const contentLength = c.req.header('Content-Length')
	if (contentLength !== undefined) {
		const declared = Number(contentLength)
		if (!Number.isSafeInteger(declared) || declared < 0) return null
		if (declared > maximumBytes) return 'too_large'
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
			if (bytesRead > maximumBytes) {
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

function safeRevisionResponse(row: RevisionRow) {
	return { id: row.id, chapter_id: row.chapter_id, body: row.body, status: row.status, version: row.version, created_at: row.created_at, updated_at: row.updated_at }
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

async function getOwnedChapterById(db: D1Database, authorId: number, chapterId: string) {
	return db.prepare(`SELECT c.id, c.novel_id, c.volume_id, c.title, c.sort_order, c.idempotency_key, c.created_at, c.updated_at, c.deleted_at
		FROM novel_chapters c JOIN novel_volumes v ON v.id = c.volume_id AND v.novel_id = c.novel_id JOIN novels n ON n.id = c.novel_id
		WHERE n.author_id = ? AND n.deleted_at IS NULL AND n.status = 'draft' AND v.deleted_at IS NULL AND c.id = ? AND c.deleted_at IS NULL`)
		.bind(authorId, chapterId).first<ChapterRow>()
}

async function getOwnedRevision(db: D1Database, authorId: number, revisionId: string) {
	return db.prepare(`SELECT r.id, r.owner_id, r.chapter_id, r.body, r.status, r.version, r.create_idempotency_key, r.created_at, r.updated_at
		FROM chapter_revisions r JOIN novel_chapters c ON c.id = r.chapter_id
		JOIN novel_volumes v ON v.id = c.volume_id AND v.novel_id = c.novel_id JOIN novels n ON n.id = c.novel_id
		WHERE n.author_id = ? AND n.deleted_at IS NULL AND v.deleted_at IS NULL AND c.deleted_at IS NULL AND r.id = ?`)
		.bind(authorId, revisionId).first<RevisionRow>()
}

function normalizedRevisionBody(input: Record<string, unknown>): string | null {
	if (typeof input.body !== 'string') return null
	const body = input.body.replace(/\r\n?/g, '\n')
	return body.length <= MAX_REVISION_BODY_LENGTH ? body : null
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
		const input = await readJsonObjectLimited(c, MAX_REVISION_JSON_BYTES)
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

novelAuthoring.post('/chapters/:chapterId/revisions', async c => {
	const auth = await authenticate(c, 'write')
	if (auth instanceof Response) return auth
	const key = idempotencyKey(c)
	if (!key) return c.json({ error: 'A valid idempotency key is required', code: 'invalid_idempotency_key' }, 400)
	const input = await readJsonObjectLimited(c)
	if (input === 'too_large') return c.json({ error: 'Request is too large', code: 'request_too_large' }, 413)
	const body = input && normalizedRevisionBody(input)
	if (!input || body === null) return c.json({ error: 'Invalid revision body', code: 'invalid_revision' }, 400)
	try {
		const chapter = await getOwnedChapterById(c.env.abdl_space_db, auth.user.sub, c.req.param('chapterId'))
		if (!chapter) return c.json({ error: 'Chapter not found', code: 'chapter_not_found' }, 404)
		const existing = await c.env.abdl_space_db.prepare(`SELECT id, owner_id, chapter_id, body, status, version, create_idempotency_key, created_at, updated_at FROM chapter_revisions WHERE owner_id = ? AND chapter_id = ? AND create_idempotency_key = ?`)
			.bind(auth.user.sub, chapter.id, key).first<RevisionRow>()
		if (existing) return existing.body === body ? c.json(safeRevisionResponse(existing)) : c.json({ error: 'Idempotency metadata conflict', code: 'idempotency_conflict' }, 409)
		const id = crypto.randomUUID()
		const result = await c.env.abdl_space_db.prepare(`INSERT OR IGNORE INTO chapter_revisions (id, owner_id, chapter_id, body, status, version, create_idempotency_key)
			SELECT ?, n.author_id, c.id, ?, 'draft', 1, ? FROM novel_chapters c
			JOIN novel_volumes v ON v.id = c.volume_id AND v.novel_id = c.novel_id JOIN novels n ON n.id = c.novel_id
			WHERE c.id = ? AND c.deleted_at IS NULL AND v.deleted_at IS NULL AND n.deleted_at IS NULL AND n.status = 'draft' AND n.author_id = ?`)
			.bind(id, body, key, chapter.id, auth.user.sub).run()
		if (!result.success) throw new Error('Database operation failed')
		const created = result.meta.changes === 1 ? await getOwnedRevision(c.env.abdl_space_db, auth.user.sub, id)
			: await c.env.abdl_space_db.prepare(`SELECT id, owner_id, chapter_id, body, status, version, create_idempotency_key, created_at, updated_at FROM chapter_revisions WHERE owner_id = ? AND chapter_id = ? AND create_idempotency_key = ?`).bind(auth.user.sub, chapter.id, key).first<RevisionRow>()
		if (!created || created.body !== body) return c.json({ error: 'Revision conflict', code: 'idempotency_conflict' }, 409)
		return c.json(safeRevisionResponse(created), result.meta.changes === 1 ? 201 : 200)
	} catch {
		return c.json({ error: 'Revision creation failed', code: 'create_revision_failed' }, 500)
	}
})

novelAuthoring.get('/revisions/:revisionId', async c => {
	const auth = await authenticate(c, 'read')
	if (auth instanceof Response) return auth
	try {
		const revision = await getOwnedRevision(c.env.abdl_space_db, auth.user.sub, c.req.param('revisionId'))
		if (!revision) return c.json({ error: 'Revision not found', code: 'revision_not_found' }, 404)
		return c.json(safeRevisionResponse(revision))
	} catch {
		return c.json({ error: 'Revision query failed', code: 'revision_query_failed' }, 500)
	}
})

novelAuthoring.put('/revisions/:revisionId/draft', async c => {
	const auth = await authenticate(c, 'write')
	if (auth instanceof Response) return auth
	const key = idempotencyKey(c)
	if (!key) return c.json({ error: 'A valid idempotency key is required', code: 'invalid_idempotency_key' }, 400)
	const input = await readJsonObjectLimited(c, MAX_REVISION_JSON_BYTES)
	if (input === 'too_large') return c.json({ error: 'Request is too large', code: 'request_too_large' }, 413)
	const body = input && normalizedRevisionBody(input)
	const baseVersion = input && Number.isSafeInteger(input.base_version) && Number(input.base_version) >= 1 ? Number(input.base_version) : null
	if (!input || body === null || baseVersion === null) return c.json({ error: 'Invalid draft update', code: 'invalid_draft' }, 400)
	try {
		const replay = await c.env.abdl_space_db.prepare(`SELECT owner_id, idempotency_key, revision_id, request_body, request_base_version, response_body, response_chapter_id, response_status, response_version, response_created_at, response_updated_at
			FROM novel_revision_operations WHERE owner_id = ? AND idempotency_key = ?`).bind(auth.user.sub, key).first<RevisionOperationRow>()
		if (replay) {
			if (replay.revision_id !== c.req.param('revisionId') || replay.request_body !== body || replay.request_base_version !== baseVersion) return c.json({ error: 'Idempotency metadata conflict', code: 'idempotency_conflict' }, 409)
			return c.json({ id: replay.revision_id, chapter_id: replay.response_chapter_id, body: replay.response_body, status: replay.response_status, version: replay.response_version, created_at: replay.response_created_at, updated_at: replay.response_updated_at })
		}

		const revision = await getOwnedRevision(c.env.abdl_space_db, auth.user.sub, c.req.param('revisionId'))
		if (!revision) return c.json({ error: 'Revision not found', code: 'revision_not_found' }, 404)
		if (revision.status !== 'draft') return c.json({ error: 'Revision is frozen', code: 'revision_frozen' }, 409)
		const updatedAt = Math.floor(Date.now() / 1000)
		const updateStatement = c.env.abdl_space_db.prepare(`UPDATE chapter_revisions SET body = ?, version = version + 1, updated_at = ?
			WHERE id = ? AND owner_id = ? AND status = 'draft' AND version = ? AND EXISTS (
				SELECT 1 FROM novel_chapters c JOIN novel_volumes v ON v.id = c.volume_id AND v.novel_id = c.novel_id JOIN novels n ON n.id = c.novel_id
				WHERE c.id = chapter_revisions.chapter_id AND c.deleted_at IS NULL AND v.deleted_at IS NULL
					AND n.deleted_at IS NULL AND n.status = 'draft' AND n.author_id = ?
			)`).bind(body, updatedAt, revision.id, auth.user.sub, baseVersion, auth.user.sub)
		const responseVersion = baseVersion + 1
		const operationStatement = c.env.abdl_space_db.prepare(`INSERT INTO novel_revision_operations
			(owner_id, idempotency_key, revision_id, request_body, request_base_version, response_body, response_chapter_id, response_status, response_version, response_created_at, response_updated_at)
			SELECT ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ? WHERE changes() = 1`)
			.bind(auth.user.sub, key, revision.id, body, baseVersion, body, revision.chapter_id, responseVersion, revision.created_at, updatedAt)
		let batchResults
		try {
			batchResults = await c.env.abdl_space_db.batch([updateStatement, operationStatement])
		} catch {
			const winner = await c.env.abdl_space_db.prepare(`SELECT owner_id, idempotency_key, revision_id, request_body, request_base_version, response_body, response_chapter_id, response_status, response_version, response_created_at, response_updated_at FROM novel_revision_operations WHERE owner_id = ? AND idempotency_key = ?`).bind(auth.user.sub, key).first<RevisionOperationRow>()
			if (winner) {
				if (winner.revision_id !== revision.id || winner.request_body !== body || winner.request_base_version !== baseVersion) return c.json({ error: 'Idempotency metadata conflict', code: 'idempotency_conflict' }, 409)
				return c.json({ id: winner.revision_id, chapter_id: winner.response_chapter_id, body: winner.response_body, status: winner.response_status, version: winner.response_version, created_at: winner.response_created_at, updated_at: winner.response_updated_at })
			}
			throw new Error('Database operation failed')
		}
		const update = batchResults[0]
		const operation = batchResults[1]
		if (!update.success || !operation.success) throw new Error('Database operation failed')
		if (update.meta.changes !== 1 || operation.meta.changes !== 1) {
			const current = await getOwnedRevision(c.env.abdl_space_db, auth.user.sub, revision.id)
			if (!current) return c.json({ error: 'Revision not found', code: 'revision_not_found' }, 404)
			if (current.status !== 'draft') return c.json({ error: 'Revision is frozen', code: 'revision_frozen' }, 409)
			return c.json({ error: 'Draft changed on another device', code: 'revision_conflict', server_revision: safeRevisionResponse(current) }, 409)
		}
		return c.json({ ...safeRevisionResponse(revision), body, version: responseVersion, updated_at: updatedAt })
	} catch {
		return c.json({ error: 'Draft update failed', code: 'update_draft_failed' }, 500)
	}
})

// === MiMo 审核、评级与申诉 (spec S9 / migration 0054) ===

const RATING_LABELS = new Set(['all_ages', 'suggest_12', 'suggest_15', 'suggest_18'])
const APPEAL_REASON_LIMIT = 2000
const MIMO_DEFAULT_TIMEOUT_MS = 30_000

interface MiMoRiskCategory {
	category: string
	confidence: number
}

interface MiMoStructuredResult {
	violation_flag: boolean
	risk_categories: MiMoRiskCategory[]
	rating: string
	content_hint: string
	summary: string
}

export interface MiMoCaller {
	review(body: string): Promise<MiMoStructuredResult>
}

interface MiMoResponseShape {
	violation_flag: unknown
	risk_categories: unknown
	rating: unknown
	content_hint: unknown
	summary: unknown
}

function coerceMiMoResult(raw: unknown): MiMoStructuredResult | null {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
	const value = raw as MiMoResponseShape
	if (typeof value.violation_flag !== 'boolean') return null
	if (!Array.isArray(value.risk_categories)) return null
	const riskCategories: MiMoRiskCategory[] = []
	for (const entry of value.risk_categories) {
		if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null
		const item = entry as { category?: unknown, confidence?: unknown }
		if (typeof item.category !== 'string' || item.category.length === 0 || item.category.length > 64) return null
		if (typeof item.confidence !== 'number' || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) return null
		riskCategories.push({ category: item.category, confidence: item.confidence })
	}
	if (riskCategories.length > 16) return null
	if (typeof value.rating !== 'string' || !RATING_LABELS.has(value.rating)) return null
	if (typeof value.content_hint !== 'string' || value.content_hint.length > 500) return null
	if (typeof value.summary !== 'string' || value.summary.length > 1000) return null
	return {
		violation_flag: value.violation_flag,
		risk_categories: riskCategories,
		rating: value.rating,
		content_hint: value.content_hint,
		summary: value.summary,
	}
}

function WorkerSecretMiMoCaller(env: Env): MiMoCaller {
	return {
		async review(body: string): Promise<MiMoStructuredResult> {
			const endpoint = env.MIMO_ENDPOINT
			const apiKey = env.MIMO_API_KEY
			if (!endpoint || !apiKey) throw new Error('MiMo credentials not configured')
			const timeoutMs = env.MIMO_TIMEOUT_MS ? Number(env.MIMO_TIMEOUT_MS) : MIMO_DEFAULT_TIMEOUT_MS
			const controller = new AbortController()
			const timer = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) ? timeoutMs : MIMO_DEFAULT_TIMEOUT_MS)
			try {
				const response = await fetch(endpoint, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
					body: JSON.stringify({ content: body }),
					signal: controller.signal,
				})
				if (!response.ok) throw new Error(`MiMo HTTP ${response.status}`)
				const parsed: unknown = await response.json()
				const coerced = coerceMiMoResult(parsed)
				if (!coerced) throw new Error('MiMo returned invalid structured result')
				return coerced
			} finally {
				clearTimeout(timer)
			}
		},
	}
}

function resolveMiMoCaller(env: Env): MiMoCaller {
	return (env.novel_mimo_caller as MiMoCaller | undefined) ?? WorkerSecretMiMoCaller(env)
}

interface ReviewResultRow {
	id: string
	owner_id: number
	revision_id: string
	snapshot_id: string
	violation_flag: number
	risk_categories: string
	rating: string
	content_hint: string
	summary: string
	model_id: string
	decided_at: number
}

function ratingLabel(value: string) {
	switch (value) {
		case 'all_ages': return '全年龄'
		case 'suggest_12': return '建议12+'
		case 'suggest_15': return '建议15+'
		case 'suggest_18': return '建议18+'
		default: return value
	}
}

function safeReviewResultResponse(result: ReviewResultRow, revision: { status: string }) {
	return {
		id: result.id,
		revision_id: result.revision_id,
		snapshot_id: result.snapshot_id,
		status: revision.status,
		violation_flag: result.violation_flag === 1,
		risk_categories: JSON.parse(result.risk_categories) as MiMoRiskCategory[],
		rating: result.rating,
		rating_label: ratingLabel(result.rating),
		content_hint: result.content_hint,
		summary: result.summary,
		decided_at: result.decided_at,
	}
}

async function getOwnedReviewResult(db: D1Database, ownerRevisionId: { owner_id: number, id: string }) {
	return db.prepare(`SELECT id, owner_id, revision_id, snapshot_id, violation_flag, risk_categories, rating, content_hint, summary, model_id, decided_at
		FROM novel_review_results WHERE owner_id = ? AND revision_id = ? ORDER BY decided_at DESC, id LIMIT 1`)
		.bind(ownerRevisionId.owner_id, ownerRevisionId.id).first<ReviewResultRow>()
}

novelAuthoring.post('/chapters/:chapterId/revisions/:revisionId/submit', async c => {
	const auth = await authenticate(c, 'write')
	if (auth instanceof Response) return auth
	const key = idempotencyKey(c)
	if (!key) return c.json({ error: 'A valid idempotency key is required', code: 'invalid_idempotency_key' }, 400)
	const db = c.env.abdl_space_db
	const revision = await getOwnedRevision(db, auth.user.sub, c.req.param('revisionId'))
	if (!revision) return c.json({ error: 'Revision not found', code: 'revision_not_found' }, 404)
	if (revision.chapter_id !== c.req.param('chapterId')) return c.json({ error: 'Revision does not belong to this chapter', code: 'chapter_mismatch' }, 400)

	const submitOp = await db.prepare(`SELECT revision_id, response_status, response_body FROM novel_revision_operations WHERE owner_id = ? AND idempotency_key = ?`)
		.bind(auth.user.sub, key).first<{ revision_id: string, response_status: string, response_body: string }>()
	if (submitOp && submitOp.revision_id === revision.id) {
		return new Response(submitOp.response_body, { status: 200, headers: { 'Content-Type': 'application/json' } })
	}
	if (submitOp && submitOp.revision_id !== revision.id) return c.json({ error: 'Idempotency metadata conflict', code: 'idempotency_conflict' }, 409)

	if (revision.status !== 'draft') return c.json({ error: 'Only draft revisions can be submitted', code: 'revision_not_draft' }, 409)

	const snapshotId = crypto.randomUUID()
	const resultId = crypto.randomUUID()
	const now = Math.floor(Date.now() / 1000)
	const bodyBytes = new Blob([revision.body]).size

	const snapshotInsert = db.prepare(`INSERT INTO novel_review_snapshots (id, owner_id, revision_id, body_snapshot, body_bytes, submitted_at)
		VALUES (?, ?, ?, ?, ?, ?)`).bind(snapshotId, auth.user.sub, revision.id, revision.body, bodyBytes, now)
	const submitAudit = db.prepare(`INSERT INTO novel_review_audit (owner_id, revision_id, actor_id, action, metadata)
		VALUES (?, ?, ?, 'submit', ?)`).bind(auth.user.sub, revision.id, auth.user.sub, JSON.stringify({ snapshot_id: snapshotId, idempotency_key: key }))

	await db.batch([snapshotInsert, submitAudit])

	let mimoResult: MiMoStructuredResult | null
	try {
		const raw = await resolveMiMoCaller(c.env).review(revision.body)
		mimoResult = coerceMiMoResult(raw)
	} catch {
		mimoResult = null
	}
	if (!mimoResult) {
		const keptAudit = db.prepare(`INSERT INTO novel_review_audit (owner_id, revision_id, actor_id, action, metadata)
			VALUES (?, ?, ?, 'review_kept_pending', ?)`).bind(auth.user.sub, revision.id, auth.user.sub, JSON.stringify({ snapshot_id: snapshotId }))
		const markPending = db.prepare(`UPDATE chapter_revisions SET status = 'review_pending', updated_at = ? WHERE id = ? AND owner_id = ? AND status = 'draft'`).bind(now, revision.id, auth.user.sub)
		const opRecord = db.prepare(`INSERT INTO novel_revision_operations (owner_id, idempotency_key, revision_id, request_body, request_base_version, response_body, response_chapter_id, response_status, response_version, response_created_at, response_updated_at)
			VALUES (?, ?, ?, '', 0, ?, ?, 'review_pending', ?, ?, ?)`)
			.bind(auth.user.sub, key, revision.id, JSON.stringify({ status: 'review_pending' }), revision.chapter_id, revision.version, revision.created_at, now)
		await db.batch([keptAudit, markPending, opRecord])
		return c.json({ id: revision.id, chapter_id: revision.chapter_id, status: 'review_pending', snapshot_id: snapshotId })
	}

	const violation = mimoResult.violation_flag ? 1 : 0
	const nextStatus = mimoResult.violation_flag ? 'rejected' : 'approved'
	const action = mimoResult.violation_flag ? 'auto_reject' : 'auto_approve'
	const riskJson = JSON.stringify(mimoResult.risk_categories)

	const resultInsert = db.prepare(`INSERT INTO novel_review_results (id, owner_id, revision_id, snapshot_id, violation_flag, risk_categories, rating, content_hint, summary, model_id, decided_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)`).bind(resultId, auth.user.sub, revision.id, snapshotId, violation, riskJson, mimoResult.rating, mimoResult.content_hint, mimoResult.summary, now)
	const revisionUpdate = db.prepare(`UPDATE chapter_revisions SET status = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND status = 'draft'`)
		.bind(nextStatus, now, revision.id, auth.user.sub)
	const decisionAudit = db.prepare(`INSERT INTO novel_review_audit (owner_id, revision_id, actor_id, action, metadata)
		VALUES (?, ?, ?, ?, ?)`).bind(auth.user.sub, revision.id, auth.user.sub, action, JSON.stringify({ result_id: resultId, snapshot_id: snapshotId, rating: mimoResult.rating }))
	const opRecord = db.prepare(`INSERT INTO novel_revision_operations (owner_id, idempotency_key, revision_id, request_body, request_base_version, response_body, response_chapter_id, response_status, response_version, response_created_at, response_updated_at)
		VALUES (?, ?, ?, '', 0, ?, ?, ?, ?, ?, ?)`)
		.bind(auth.user.sub, key, revision.id, JSON.stringify({ status: nextStatus, result_id: resultId }), revision.chapter_id, nextStatus, revision.version, revision.created_at, now)

	await db.batch([resultInsert, revisionUpdate, decisionAudit, opRecord])

	return c.json({ id: revision.id, chapter_id: revision.chapter_id, status: nextStatus, snapshot_id: snapshotId, result_id: resultId, rating: mimoResult.rating, violation_flag: mimoResult.violation_flag })
})

novelAuthoring.get('/revisions/:revisionId/review', async c => {
	const auth = await authenticate(c, 'read')
	if (auth instanceof Response) return auth
	const db = c.env.abdl_space_db
	const revision = await getOwnedRevision(db, auth.user.sub, c.req.param('revisionId'))
	if (!revision) return c.json({ error: 'Revision not found', code: 'revision_not_found' }, 404)
	const result = await getOwnedReviewResult(db, { owner_id: auth.user.sub, id: revision.id })
	if (!result) return c.json({ id: revision.id, status: revision.status, rating: null, content_hint: null, violation_flag: null })
	return c.json(safeReviewResultResponse(result, revision))
})

novelAuthoring.post('/revisions/:revisionId/appeals', async c => {
	const auth = await authenticate(c, 'write')
	if (auth instanceof Response) return auth
	const key = idempotencyKey(c)
	if (!key) return c.json({ error: 'A valid idempotency key is required', code: 'invalid_idempotency_key' }, 400)
	const input = await readJsonObjectLimited(c)
	if (input === 'too_large') return c.json({ error: 'Request is too large', code: 'request_too_large' }, 413)
	const reason = typeof input?.reason === 'string' ? input.reason.trim() : ''
	if (!reason || reason.length > APPEAL_REASON_LIMIT) return c.json({ error: 'Invalid appeal reason', code: 'invalid_appeal' }, 400)

	const db = c.env.abdl_space_db
	const revision = await getOwnedRevision(db, auth.user.sub, c.req.param('revisionId'))
	if (!revision) return c.json({ error: 'Revision not found', code: 'revision_not_found' }, 404)
	if (revision.status !== 'rejected') return c.json({ error: 'Only rejected revisions can be appealed', code: 'not_rejected' }, 409)

	const existing = await db.prepare(`SELECT id, status FROM novel_review_appeals WHERE revision_id = ? AND idempotency_key = ?`).bind(revision.id, key).first<{ id: string, status: string }>()
	if (existing) return c.json({ id: existing.id, revision_id: revision.id, status: existing.status }, 200)

	const appealId = crypto.randomUUID()
	const now = Math.floor(Date.now() / 1000)
	const appealInsert = db.prepare(`INSERT INTO novel_review_appeals (id, owner_id, revision_id, reason, status, idempotency_key, created_at, updated_at)
		VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`).bind(appealId, auth.user.sub, revision.id, reason, key, now, now)
	const appealAudit = db.prepare(`INSERT INTO novel_review_audit (owner_id, revision_id, actor_id, action, metadata)
		VALUES (?, ?, ?, 'appeal', ?)`).bind(auth.user.sub, revision.id, auth.user.sub, JSON.stringify({ appeal_id: appealId }))

	await db.batch([appealInsert, appealAudit])
	return c.json({ id: appealId, revision_id: revision.id, status: 'pending' }, 201)
})

export default novelAuthoring