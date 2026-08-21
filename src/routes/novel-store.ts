import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Env } from '../types/index.ts'

interface AppType {
	Bindings: Env
}

interface StoreWorkRow {
	id: string
	title: string
	description: string
	category: string
	created_at: number
	updated_at: number
	username: string
	published_chapter_count: number
	published_at: number
	publication_seq: number
}

interface StoreVolumeRow {
	id: string
	title: string
	sort_order: number
}

interface StoreChapterRow {
	id: string
	volume_id: string
	title: string
	sort_order: number
	revision_id: string
	updated_at: number
	rating: string | null
	content_hint: string | null
}

const novelStore = new Hono<AppType>()

function encodeCursor(parts: Array<string | number>): string {
	const bytes = new TextEncoder().encode(JSON.stringify(parts))
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeCursor(value: string | undefined): [number, number, string] | null | undefined {
	if (value === undefined || value === '') return undefined
	try {
		const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
		const binary = atob(base64 + '='.repeat((4 - base64.length % 4) % 4))
		const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, character => character.charCodeAt(0))))
		return Array.isArray(decoded) && decoded.length === 3 && Number.isSafeInteger(decoded[0]) && Number.isSafeInteger(decoded[1]) && typeof decoded[2] === 'string' ? [decoded[0], decoded[1], decoded[2]] : null
	} catch {
		return null
	}
}

novelStore.use('*', cors({
	origin: '*',
	allowMethods: ['GET', 'OPTIONS'],
}))

function safeWork(row: StoreWorkRow) {
	return {
		id: row.id,
		title: row.title,
		description: row.description,
		category: row.category,
		author: { username: row.username },
		published_chapter_count: row.published_chapter_count,
		published_at: row.published_at,
		created_at: row.created_at,
		updated_at: row.updated_at,
	}
}

function safeChapter(row: StoreChapterRow) {
	return {
		id: row.id,
		title: row.title,
		sort_order: row.sort_order,
		published_revision_id: row.revision_id,
		updated_at: row.updated_at,
		rating: row.rating,
		content_hint: row.content_hint,
	}
}

async function getPublishedWork(db: D1Database, workId: string) {
	return db.prepare(`
		SELECT n.id, n.title, n.description, n.category, n.created_at, n.updated_at, u.username,
			COUNT(c.id) AS published_chapter_count, MAX(r.updated_at) AS published_at
		FROM novels n
		JOIN users u ON u.id = n.author_id
		JOIN novel_volumes v ON v.novel_id = n.id AND v.deleted_at IS NULL
		JOIN novel_chapters c ON c.novel_id = n.id AND c.volume_id = v.id AND c.deleted_at IS NULL
		JOIN chapter_revisions r ON r.chapter_id = c.id AND r.owner_id = n.author_id AND r.status = 'published'
		WHERE n.id = ? AND n.deleted_at IS NULL
		GROUP BY n.id, n.title, n.description, n.category, n.created_at, n.updated_at, u.username
	`).bind(workId).first<StoreWorkRow>()
}

novelStore.get('/works', async c => {
	try {
		const cursor = decodeCursor(c.req.query('cursor'))
		if (cursor === null) return c.json({ error: 'Invalid cursor', code: 'invalid_cursor' }, 400)
		const limitValue = c.req.query('limit') ?? '20'
		if (!/^\d+$/.test(limitValue) || Number(limitValue) < 1 || Number(limitValue) > 50) return c.json({ error: 'Invalid limit', code: 'invalid_limit' }, 400)
		const limit = Number(limitValue)
		const snapshot = cursor?.[0] ?? Number((await c.env.abdl_space_db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM novel_review_audit WHERE action = 'publish'`).bind().first<{ id: number }>())?.id ?? 0)
		const cursorPredicate = cursor ? `AND (p.publication_seq < ? OR (p.publication_seq = ? AND n.id < ?))` : ''
		const result = await c.env.abdl_space_db.prepare(`
			SELECT n.id, n.title, n.description, n.category, n.created_at, n.updated_at, u.username,
				COUNT(c.id) AS published_chapter_count, p.published_at, p.publication_seq
			FROM novels n
			JOIN users u ON u.id = n.author_id
			JOIN (
				SELECT c.novel_id, MAX(a.id) AS publication_seq, MAX(a.created_at) AS published_at
				FROM novel_review_audit a
				JOIN chapter_revisions ar ON ar.id = a.revision_id AND ar.owner_id = a.owner_id
				JOIN novel_chapters c ON c.id = ar.chapter_id
				WHERE a.action = 'publish' AND a.id <= ?
				GROUP BY c.novel_id
			) p ON p.novel_id = n.id
			JOIN novel_volumes v ON v.novel_id = n.id AND v.deleted_at IS NULL
			JOIN novel_chapters c ON c.novel_id = n.id AND c.volume_id = v.id AND c.deleted_at IS NULL
			JOIN chapter_revisions r ON r.chapter_id = c.id AND r.owner_id = n.author_id AND r.status = 'published'
			WHERE n.deleted_at IS NULL
			${cursorPredicate}
			GROUP BY n.id, n.title, n.description, n.category, n.created_at, n.updated_at, u.username, p.published_at, p.publication_seq
			ORDER BY p.publication_seq DESC, n.id DESC
			LIMIT ?
		`).bind(...(cursor ? [snapshot, cursor[1], cursor[1], cursor[2], limit + 1] : [snapshot, limit + 1])).all<StoreWorkRow>()
		if (!result.success) throw new Error('Database query failed')
		const page = result.results.slice(0, limit)
		const last = page.at(-1)
		return c.json({ items: page.map(safeWork), next_cursor: result.results.length > limit && last ? encodeCursor([snapshot, last.publication_seq, last.id]) : null })
	} catch {
		return c.json({ error: 'Public works query failed', code: 'store_query_failed' }, 500)
	}
})

novelStore.get('/works/:workId', async c => {
	try {
		const db = c.env.abdl_space_db
		const work = await getPublishedWork(db, c.req.param('workId'))
		if (!work) return c.json({ error: 'Public work not found', code: 'work_not_found' }, 404)
		const volumes = await db.prepare(`
			SELECT DISTINCT v.id, v.title, v.sort_order
			FROM novel_volumes v
			JOIN novels n ON n.id = v.novel_id AND n.deleted_at IS NULL
			JOIN novel_chapters c ON c.volume_id = v.id AND c.novel_id = v.novel_id AND c.deleted_at IS NULL
			JOIN chapter_revisions r ON r.chapter_id = c.id AND r.owner_id = n.author_id AND r.status = 'published'
			WHERE v.novel_id = ? AND v.deleted_at IS NULL
			ORDER BY v.sort_order, v.id
		`).bind(work.id).all<StoreVolumeRow>()
		const chapters = await db.prepare(`
			SELECT c.id, c.volume_id, c.title, c.sort_order, r.id AS revision_id, r.updated_at,
				(SELECT rating FROM novel_review_results WHERE revision_id = r.id ORDER BY decided_at DESC, id DESC LIMIT 1) AS rating,
				(SELECT content_hint FROM novel_review_results WHERE revision_id = r.id ORDER BY decided_at DESC, id DESC LIMIT 1) AS content_hint
			FROM novel_chapters c
			JOIN novels n ON n.id = c.novel_id AND n.deleted_at IS NULL
			JOIN novel_volumes v ON v.id = c.volume_id AND v.novel_id = c.novel_id AND v.deleted_at IS NULL
			JOIN chapter_revisions r ON r.chapter_id = c.id AND r.owner_id = n.author_id AND r.status = 'published'
			WHERE c.novel_id = ? AND c.deleted_at IS NULL
			ORDER BY v.sort_order, v.id, c.sort_order, c.id
		`).bind(work.id).all<StoreChapterRow>()
		if (!volumes.success || !chapters.success) throw new Error('Database query failed')
		return c.json({
			...safeWork(work),
			volumes: volumes.results.map(volume => ({
				id: volume.id,
				title: volume.title,
				sort_order: volume.sort_order,
				chapters: chapters.results.filter(chapter => chapter.volume_id === volume.id).map(safeChapter),
			})),
		})
	} catch {
		return c.json({ error: 'Public work query failed', code: 'work_query_failed' }, 500)
	}
})

novelStore.get('/works/:workId/chapters/:chapterId', async c => {
	try {
		const revisionId = c.req.query('revision_id')
		if (!revisionId) return c.json({ error: 'Published revision is required', code: 'missing_published_revision' }, 400)
		const row = await c.env.abdl_space_db.prepare(`
			SELECT r.id AS revision_id, r.chapter_id, r.body, r.version, r.updated_at,
				(SELECT rating FROM novel_review_results WHERE revision_id = r.id ORDER BY decided_at DESC, id DESC LIMIT 1) AS rating,
				(SELECT content_hint FROM novel_review_results WHERE revision_id = r.id ORDER BY decided_at DESC, id DESC LIMIT 1) AS content_hint
			FROM novels n
			JOIN novel_volumes v ON v.novel_id = n.id AND v.deleted_at IS NULL
			JOIN novel_chapters c ON c.id = ? AND c.novel_id = n.id AND c.volume_id = v.id AND c.deleted_at IS NULL
			JOIN chapter_revisions r ON r.id = ? AND r.chapter_id = c.id AND r.owner_id = n.author_id AND r.status = 'published'
			WHERE n.id = ? AND n.deleted_at IS NULL
		`).bind(c.req.param('chapterId'), revisionId, c.req.param('workId')).first<{
			revision_id: string
			chapter_id: string
			body: string
			version: number
			updated_at: number
			rating: string | null
			content_hint: string | null
		}>()
		if (!row) {
			const current = await c.env.abdl_space_db.prepare(`SELECT 1 FROM novels n JOIN novel_chapters c ON c.id = ? AND c.novel_id = n.id AND c.deleted_at IS NULL JOIN chapter_revisions r ON r.chapter_id = c.id AND r.owner_id = n.author_id AND r.status = 'published' WHERE n.id = ? AND n.deleted_at IS NULL`)
				.bind(c.req.param('chapterId'), c.req.param('workId')).first()
			return c.json({ error: current ? 'Published revision changed' : 'Published chapter not found', code: current ? 'published_revision_changed' : 'chapter_not_found' }, current ? 409 : 404)
		}
		return c.json({
			revision_id: row.revision_id,
			chapter_id: row.chapter_id,
			body: row.body,
			status: 'published',
			version: row.version,
			updated_at: row.updated_at,
			rating: row.rating,
			content_hint: row.content_hint,
		})
	} catch {
		return c.json({ error: 'Published chapter query failed', code: 'chapter_query_failed' }, 500)
	}
})

export default novelStore
