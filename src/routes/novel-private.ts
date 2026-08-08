import { Hono } from 'hono'
import type { Context } from 'hono'
import { cors } from 'hono/cors'

import { CosHttpError, createCosGetAuthorization, createCosPutAuthorization, deleteObjectFromCos, getPrivateObjectFromCos, headPrivateObjectFromCos, putObjectToCos } from '../lib/tencent-cos.ts'
import { mastodonAuthDetails } from '../mastodon/shared.ts'
import { assertSessionNotStale } from '../middleware/auth.ts'
import type { Env } from '../types/index.ts'

type AppType = { Bindings: Env }
type AuthDetails = NonNullable<Awaited<ReturnType<typeof mastodonAuthDetails>>>

interface PrivateBookRow {
	snapshot_at?: number
	id: string
	owner_id: number
	title: string
	author: string
	format: 'txt' | 'epub'
	object_key: string
	content_hash: string
	declared_size: number
	verified_size: number | null
	parse_status: 'pending' | 'parsing' | 'ready' | 'failed'
	upload_expires_at: number
	verification_started_at: number | null
	cleanup_status: 'pending' | 'deleting' | 'done' | 'failed'
	cleanup_attempted_at: number | null
	created_at: number
	updated_at: number
	deleted_at: number | null
}

interface NovelSyncItemRow {
	seq?: number
	book_id: string
	item_type: 'progress' | 'bookmark' | 'note'
	item_id: string
	payload_json: string
	client_updated_at: number
	server_updated_at?: number
	deleted_at: number | null
}

interface PrivateBookUsage {
	book_count: number
	total_size: number
}

const MIME_FORMATS = {
	'text/plain': { format: 'txt', extension: 'txt' },
	'application/epub+zip': { format: 'epub', extension: 'epub' },
} as const

export const MAX_PRIVATE_BOOK_SIZE = 50 * 1024 * 1024
const MAX_PRIVATE_BOOK_COUNT = 500
const MAX_PRIVATE_BOOK_TOTAL_SIZE = 2 * 1024 * 1024 * 1024
const VERIFICATION_LEASE_MICROSECONDS = 5 * 60 * 1_000_000
const CLEANUP_LEASE_MICROSECONDS = 5 * 60 * 1_000_000
const MAX_PASTE_SIZE = 5 * 1024 * 1024
const MAX_PASTE_LINE_LENGTH = 100_000
const MAX_SYNC_PAYLOAD_SIZE = 64 * 1024
const MAX_SMALL_JSON_SIZE = 64 * 1024
const MAX_PASTE_JSON_SIZE = 6 * 1024 * 1024
const MAX_SYNC_JSON_SIZE = 96 * 1024

export const PRIVATE_BOOK_INSERT_SQL = `
	INSERT INTO private_books (
		id, owner_id, title, author, format, object_key, content_hash,
		declared_size, verified_size, parse_status, upload_expires_at, verification_started_at
	)
	SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, 'pending', ?9, NULL
	WHERE (SELECT COUNT(*) FROM private_books WHERE owner_id = ?2 AND deleted_at IS NULL) < ${MAX_PRIVATE_BOOK_COUNT}
		AND (SELECT COALESCE(SUM(declared_size), 0) FROM private_books WHERE owner_id = ?2 AND deleted_at IS NULL) + ?8 <= ${MAX_PRIVATE_BOOK_TOTAL_SIZE}
		AND NOT EXISTS (
			SELECT 1 FROM private_books WHERE owner_id = ?2 AND content_hash = ?7 AND deleted_at IS NULL
		)
`

const novelPrivate = new Hono<AppType>()

novelPrivate.use('*', cors({
	origin: '*',
	allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
	allowHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
}))

function unauthorized(c: Context<AppType>) {
	return c.json({ error: 'The access token is invalid', code: 'unauthorized' }, 401)
}

function forbidden(c: Context<AppType>) {
	return c.json({ error: 'Insufficient OAuth scope', code: 'insufficient_scope' }, 403)
}

async function authenticate(c: Context<AppType>, scope: 'read' | 'write'): Promise<AuthDetails | Response> {
	const auth = await mastodonAuthDetails(c)
	if (!auth) return unauthorized(c)
	if (auth.tokenType === 'oauth' && !auth.scopes.includes(scope)) return forbidden(c)
	if (auth.tokenType === 'jwt' && await assertSessionNotStale(auth.user, c.env.abdl_space_db)) return unauthorized(c)
	return auth
}

async function readJsonObjectLimited(c: Context<AppType>, maximumBytes: number): Promise<Record<string, unknown> | null | 'too_large'> {
	const contentLength = c.req.header('Content-Length')
	if (contentLength !== undefined) {
		const declaredLength = Number(contentLength)
		if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) return null
		if (declaredLength > maximumBytes) return 'too_large'
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

function matchesContentType(value: string | null, expected: string): boolean {
	return value !== null && value.trim().toLowerCase() === expected
}

function toHex(bytes: ArrayBuffer): string {
	return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}

function encodeCursor(parts: Array<string | number>): string {
	const bytes = new TextEncoder().encode(JSON.stringify(parts))
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeCursor(value: string | undefined, length: number): Array<string | number> | null | undefined {
	if (value === undefined || value === '') return undefined
	try {
		const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
		const binary = atob(base64 + '='.repeat((4 - base64.length % 4) % 4))
		const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
		const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes))
		if (!Array.isArray(decoded) || decoded.length !== length || decoded.some(part => typeof part !== 'string' && typeof part !== 'number')) return null
		return decoded
	} catch {
		return null
	}
}

function parseLimit(value: string | undefined, fallback: number, maximum: number): number | null {
	if (value === undefined || value === '') return fallback
	if (!/^\d+$/.test(value)) return null
	const limit = Number(value)
	return Number.isSafeInteger(limit) && limit >= 1 && limit <= maximum ? limit : null
}

function safeBookResponse(book: PrivateBookRow) {
	return {
		id: book.id,
		title: book.title,
		author: book.author,
		format: book.format,
		content_hash: book.content_hash,
		verified_size: book.verified_size,
		parse_status: book.parse_status,
		created_at: book.created_at,
		updated_at: book.updated_at,
	}
}

function syncItemResponse(item: NovelSyncItemRow) {
	return {
		...(item.seq === undefined ? {} : { seq: item.seq }),
		book_id: item.book_id,
		item_type: item.item_type,
		item_id: item.item_id,
		payload: JSON.parse(item.payload_json) as Record<string, unknown>,
		client_updated_at: item.client_updated_at,
		...(item.server_updated_at === undefined ? {} : { server_updated_at: item.server_updated_at }),
		deleted_at: item.deleted_at,
	}
}

function bookResponse(book: PrivateBookRow) {
	return { id: book.id, format: book.format, verified_size: book.verified_size, parse_status: book.parse_status }
}

async function getOwnedBook(db: D1Database, id: string, ownerId: number): Promise<PrivateBookRow | null> {
	const result = await db.prepare(`
		SELECT id, owner_id, title, author, format, object_key, content_hash,
			declared_size, verified_size, parse_status, upload_expires_at, verification_started_at,
			cleanup_status, cleanup_attempted_at, created_at, updated_at, deleted_at
		FROM private_books WHERE id = ? AND owner_id = ?
	`).bind(id, ownerId).all<PrivateBookRow>()
	if (!result.success) throw new Error('Database query failed')
	return result.results[0] ?? null
}

async function getActiveBookByHash(db: D1Database, ownerId: number, contentHash: string): Promise<PrivateBookRow | null> {
	const result = await db.prepare(`
		SELECT id, owner_id, title, author, format, object_key, content_hash,
			declared_size, verified_size, parse_status, upload_expires_at, verification_started_at,
			cleanup_status, cleanup_attempted_at, created_at, updated_at, deleted_at
		FROM private_books
		WHERE owner_id = ? AND content_hash = ? AND deleted_at IS NULL
		LIMIT 1
	`).bind(ownerId, contentHash).all<PrivateBookRow>()
	if (!result.success) throw new Error('Database query failed')
	return result.results[0] ?? null
}

function privateCosOptions(env: Env) {
	const secretId = env.NOVEL_COS_SECRET_ID?.trim()
	const secretKey = env.NOVEL_COS_SECRET_KEY?.trim()
	const bucket = env.NOVEL_PRIVATE_COS_BUCKET?.trim()
	const region = env.NOVEL_PRIVATE_COS_REGION?.trim()
	if (!secretId || !secretKey || !bucket || !region || bucket === env.COS_BUCKET?.trim()
		|| secretId === env.COS_SECRET_ID?.trim() || secretKey === env.COS_SECRET_KEY?.trim()) return null
	return { secretId, secretKey, bucket, region }
}

async function restorePending(db: D1Database, book: PrivateBookRow, verificationStartedAt: number): Promise<void> {
	try {
		await db.prepare(`
			UPDATE private_books
			SET parse_status = 'pending', verification_started_at = NULL, updated_at = unixepoch()
			WHERE id = ? AND owner_id = ? AND parse_status = 'parsing'
				AND verification_started_at = ? AND deleted_at IS NULL
		`).bind(book.id, book.owner_id, verificationStartedAt).run()
	} catch {
		// Recovery is best-effort; a stale lease remains reclaimable after five minutes.
	}
}

function newCleanupToken(now = Date.now()): number {
	return now * 1000 + crypto.getRandomValues(new Uint16Array(1))[0] % 1000
}

async function failAndDeleteBook(db: D1Database, book: PrivateBookRow, verificationStartedAt: number, cleanupToken: number): Promise<boolean> {
	const result = await db.prepare(`
		UPDATE private_books
		SET parse_status = 'failed', deleted_at = unixepoch(), verification_started_at = NULL,
			cleanup_status = 'deleting', cleanup_attempted_at = ?, updated_at = unixepoch()
		WHERE id = ? AND owner_id = ? AND parse_status = 'parsing'
			AND verification_started_at = ? AND deleted_at IS NULL
	`).bind(cleanupToken, book.id, book.owner_id, verificationStartedAt).run()
	return result.success && result.meta.changes === 1
}

async function cleanupPrivateObject(db: D1Database, book: PrivateBookRow, cos: NonNullable<ReturnType<typeof privateCosOptions>>, cleanupToken: number, now = Math.floor(Date.now() / 1000)): Promise<void> {
	let cleanupStatus: PrivateBookRow['cleanup_status'] = 'done'
	try {
		await deleteObjectFromCos({ ...cos, objectKey: book.object_key, contentType: book.format === 'txt' ? 'text/plain' : 'application/epub+zip' })
	} catch (error) {
		if (!(error instanceof CosHttpError && error.status === 404 && now >= book.upload_expires_at)) cleanupStatus = 'failed'
	}
	const result = await db.prepare(`
		UPDATE private_books SET cleanup_status = ?, updated_at = unixepoch()
		WHERE id = ? AND owner_id = ? AND deleted_at IS NOT NULL AND cleanup_status = 'deleting'
			AND cleanup_attempted_at = ?
	`).bind(cleanupStatus, book.id, book.owner_id, cleanupToken).run()
	if (!result.success || result.meta.changes !== 1) throw new Error('Database operation failed')
}

export async function cleanupPrivateNovelObjects(env: Env, now: number, limit: number): Promise<number> {
	const cos = privateCosOptions(env)
	if (!cos || !Number.isSafeInteger(now) || !Number.isSafeInteger(limit) || limit <= 0) return 0
	const staleCleanupBefore = (now * 1_000_000) - CLEANUP_LEASE_MICROSECONDS
	const result = await env.abdl_space_db.prepare(`
		SELECT id, owner_id, title, author, format, object_key, content_hash,
			declared_size, verified_size, parse_status, upload_expires_at, verification_started_at,
			cleanup_status, cleanup_attempted_at, created_at, updated_at, deleted_at
		FROM private_books
		WHERE (deleted_at IS NULL AND parse_status = 'pending' AND upload_expires_at <= ?)
			OR (deleted_at IS NOT NULL AND upload_expires_at <= ? AND cleanup_status IN ('failed', 'pending'))
			OR (deleted_at IS NOT NULL AND cleanup_status = 'deleting'
				AND upload_expires_at <= ? AND (cleanup_attempted_at IS NULL OR cleanup_attempted_at <= ?))
		ORDER BY upload_expires_at ASC
		LIMIT ?
	`).bind(now, now, now, staleCleanupBefore, limit).all<PrivateBookRow>()
	if (!result.success) throw new Error('Database query failed')

	let claimed = 0
	for (const book of result.results) {
		const cleanupToken = newCleanupToken()
		let claim
		if (book.deleted_at === null) {
			claim = await env.abdl_space_db.prepare(`
				UPDATE private_books
				SET parse_status = 'failed', deleted_at = ?, verification_started_at = NULL,
					cleanup_status = 'deleting', cleanup_attempted_at = ?, updated_at = unixepoch()
				WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND parse_status = 'pending'
					AND upload_expires_at = ? AND upload_expires_at <= ?
			`).bind(now, cleanupToken, book.id, book.owner_id, book.upload_expires_at, now).run()
		} else {
			claim = await env.abdl_space_db.prepare(`
				UPDATE private_books
				SET cleanup_status = 'deleting', cleanup_attempted_at = ?, updated_at = unixepoch()
				WHERE id = ? AND owner_id = ? AND deleted_at IS NOT NULL
					AND cleanup_status = ?
					AND (cleanup_attempted_at = ? OR (cleanup_attempted_at IS NULL AND ? IS NULL))
			`).bind(cleanupToken, book.id, book.owner_id, book.cleanup_status, book.cleanup_attempted_at, book.cleanup_attempted_at).run()
		}
		if (!claim.success) throw new Error('Database operation failed')
		if (claim.meta.changes !== 1) continue
		claimed++
		await cleanupPrivateObject(env.abdl_space_db, book, cos, cleanupToken, now)
	}
	return claimed
}

function pendingMetadataMatches(book: PrivateBookRow, title: string, author: string, format: 'txt' | 'epub', declaredSize: number): boolean {
	return book.title === title && book.author === author && book.format === format && book.declared_size === declaredSize
}

novelPrivate.get('/books', async c => {
	const auth = await authenticate(c, 'read')
	if (auth instanceof Response) return auth
	const limit = parseLimit(c.req.query('limit'), 20, 50)
	const cursor = decodeCursor(c.req.query('cursor'), 3)
	if (limit === null || cursor === null || (cursor && (!Number.isSafeInteger(cursor[0]) || Number(cursor[0]) < 0
		|| !Number.isSafeInteger(cursor[1]) || Number(cursor[1]) < 0 || typeof cursor[2] !== 'string' || !cursor[2]))) {
		return c.json({ error: 'Invalid pagination request', code: 'invalid_pagination' }, 400)
	}
	try {
		const result = cursor
			? await c.env.abdl_space_db.prepare(`
				SELECT id, owner_id, title, author, format, object_key, content_hash, declared_size,
					verified_size, parse_status, upload_expires_at, verification_started_at,
					cleanup_status, cleanup_attempted_at, created_at, updated_at, deleted_at
				FROM private_books
				WHERE owner_id = ? AND deleted_at IS NULL AND updated_at <= ?
					AND (updated_at < ? OR (updated_at = ? AND id < ?))
				ORDER BY updated_at DESC, id DESC LIMIT ?
			`).bind(auth.user.sub, cursor[0], cursor[1], cursor[1], cursor[2], limit + 1).all<PrivateBookRow>()
			: await c.env.abdl_space_db.prepare(`
				WITH snapshot(value) AS (SELECT unixepoch())
				SELECT id, owner_id, title, author, format, object_key, content_hash, declared_size,
					verified_size, parse_status, upload_expires_at, verification_started_at,
					cleanup_status, cleanup_attempted_at, created_at, updated_at, deleted_at, snapshot.value AS snapshot_at
				FROM private_books, snapshot WHERE owner_id = ? AND deleted_at IS NULL AND updated_at <= snapshot.value
				ORDER BY updated_at DESC, id DESC LIMIT ?
			`).bind(auth.user.sub, limit + 1).all<PrivateBookRow>()
		if (!result.success) throw new Error('Database query failed')
		const hasMore = result.results.length > limit
		const page = result.results.slice(0, limit)
		const last = page.at(-1)
		const snapshotAt = cursor ? Number(cursor[0]) : (page[0]?.snapshot_at ?? Math.floor(Date.now() / 1000))
		return c.json({ items: page.map(safeBookResponse), next_cursor: hasMore && last ? encodeCursor([snapshotAt, last.updated_at, last.id]) : null })
	} catch {
		return c.json({ error: 'Private books query failed', code: 'books_query_failed' }, 500)
	}
})

novelPrivate.get('/books/:id', async c => {
	const auth = await authenticate(c, 'read')
	if (auth instanceof Response) return auth
	try {
		const book = await getOwnedBook(c.env.abdl_space_db, c.req.param('id'), auth.user.sub)
		if (!book || book.deleted_at !== null) return c.json({ error: 'Private book not found', code: 'book_not_found' }, 404)
		return c.json(safeBookResponse(book))
	} catch {
		return c.json({ error: 'Private book query failed', code: 'book_query_failed' }, 500)
	}
})

novelPrivate.delete('/books/:id', async c => {
	const auth = await authenticate(c, 'write')
	if (auth instanceof Response) return auth
	const cos = privateCosOptions(c.env)
	if (!cos) return c.json({ error: 'Private storage is unavailable', code: 'private_storage_unavailable' }, 503)
	try {
		const book = await getOwnedBook(c.env.abdl_space_db, c.req.param('id'), auth.user.sub)
		if (!book) return c.json({ error: 'Private book not found', code: 'book_not_found' }, 404)
		if (book.deleted_at !== null) return c.json({ id: book.id, deleted: true })
		const cleanupToken = newCleanupToken()
		const result = await c.env.abdl_space_db.prepare(`
			UPDATE private_books
			SET deleted_at = unixepoch(), parse_status = CASE WHEN parse_status = 'ready' THEN parse_status ELSE 'failed' END,
				verification_started_at = NULL, cleanup_status = 'deleting', cleanup_attempted_at = ?, updated_at = unixepoch()
			WHERE owner_id = ? AND id = ? AND deleted_at IS NULL
		`).bind(cleanupToken, auth.user.sub, book.id).run()
		if (!result.success) throw new Error('Database operation failed')
		if (result.meta.changes === 1) await cleanupPrivateObject(c.env.abdl_space_db, book, cos, cleanupToken)
		return c.json({ id: book.id, deleted: true })
	} catch {
		return c.json({ error: 'Private book deletion failed', code: 'delete_failed' }, 500)
	}
})

novelPrivate.post('/paste', async c => {
	const auth = await authenticate(c, 'write')
	if (auth instanceof Response) return auth
	const cos = privateCosOptions(c.env)
	if (!cos) return c.json({ error: 'Private storage is unavailable', code: 'private_storage_unavailable' }, 503)
	const input = await readJsonObjectLimited(c, MAX_PASTE_JSON_SIZE)
	if (input === 'too_large') return c.json({ error: 'Paste request is too large', code: 'request_too_large' }, 413)
	if (!input) return c.json({ error: 'Invalid paste request', code: 'invalid_paste' }, 400)
	const title = typeof input.title === 'string' ? input.title.trim() : ''
	const author = typeof input.author === 'string' ? input.author.trim() : ''
	const rawText = typeof input.text === 'string' ? input.text : ''
	const normalizedText = rawText.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n*$/, '\n')
	let containsControlCharacter = false
	let longestLine = 0
	let currentLine = 0
	for (let index = 0; index < normalizedText.length; index++) {
		const code = normalizedText.charCodeAt(index)
		if ((code < 0x20 && code !== 0x0A && code !== 0x09) || code === 0x7F) containsControlCharacter = true
		if (code === 0x0A) {
			longestLine = Math.max(longestLine, currentLine)
			currentLine = 0
		} else currentLine++
	}
	longestLine = Math.max(longestLine, currentLine)
	const bytes = new TextEncoder().encode(normalizedText)
	if (!title || title.length > 500 || !author || author.length > 500 || !normalizedText.trim() || containsControlCharacter
		|| bytes.byteLength > MAX_PASTE_SIZE || longestLine > MAX_PASTE_LINE_LENGTH) {
		return c.json({ error: 'Invalid paste request', code: 'invalid_paste' }, 400)
	}
	const contentHash = toHex(await crypto.subtle.digest('SHA-256', bytes))
	let book: PrivateBookRow | null = null
	try {
		book = await getActiveBookByHash(c.env.abdl_space_db, auth.user.sub, contentHash)
		if (book?.parse_status === 'ready') return c.json(safeBookResponse(book))
		if (book) return c.json({ error: 'Private book is being processed', code: 'invalid_book_status' }, 409)
		const id = crypto.randomUUID()
		const objectKey = `novels/private/${auth.user.sub}/${id}.txt`
		const expiresAt = Math.floor(Date.now() / 1000) + 300
		const insert = await c.env.abdl_space_db.prepare(PRIVATE_BOOK_INSERT_SQL)
			.bind(id, auth.user.sub, title, author, 'txt', objectKey, contentHash, bytes.byteLength, expiresAt).run()
		if (!insert.success) throw new Error('Database operation failed')
		if (insert.meta.changes !== 1) {
			const concurrent = await getActiveBookByHash(c.env.abdl_space_db, auth.user.sub, contentHash)
			if (concurrent?.parse_status === 'ready') return c.json(safeBookResponse(concurrent))
			return c.json({ error: 'Private book state changed', code: 'book_conflict' }, 409)
		}
		book = await getOwnedBook(c.env.abdl_space_db, id, auth.user.sub)
		if (!book) throw new Error('Database query failed')
		await putObjectToCos({ ...cos, objectKey, contentType: 'text/plain', metadataSha256: contentHash, body: normalizedText })
		const head = await headPrivateObjectFromCos({ ...cos, objectKey, contentType: 'text/plain' })
		const verifiedSize = Number(head.headers.get('Content-Length'))
		if (verifiedSize !== bytes.byteLength || !matchesContentType(head.headers.get('Content-Type'), 'text/plain')) throw new Error('Verification mismatch')
		const objectResponse = await getPrivateObjectFromCos({ ...cos, objectKey, contentType: 'text/plain' })
		const storedBytes = await objectResponse.arrayBuffer()
		if (storedBytes.byteLength !== bytes.byteLength || toHex(await crypto.subtle.digest('SHA-256', storedBytes)) !== contentHash) throw new Error('Verification mismatch')
		const ready = await c.env.abdl_space_db.prepare(`
			UPDATE private_books SET verified_size = ?, parse_status = 'ready', updated_at = unixepoch()
			WHERE owner_id = ? AND id = ? AND deleted_at IS NULL AND parse_status = 'pending'
		`).bind(bytes.byteLength, auth.user.sub, id).run()
		if (!ready.success || ready.meta.changes !== 1) throw new Error('Database operation failed')
		const current = await getOwnedBook(c.env.abdl_space_db, id, auth.user.sub)
		if (!current) throw new Error('Database query failed')
		return c.json(safeBookResponse(current))
	} catch {
		if (book) {
			const cleanupToken = newCleanupToken()
			const failed = await c.env.abdl_space_db.prepare(`
				UPDATE private_books SET parse_status = 'failed', deleted_at = unixepoch(), cleanup_status = 'deleting',
					cleanup_attempted_at = ?, updated_at = unixepoch()
				WHERE owner_id = ? AND id = ? AND deleted_at IS NULL
			`).bind(cleanupToken, auth.user.sub, book.id).run()
			if (failed.success && failed.meta.changes === 1) await cleanupPrivateObject(c.env.abdl_space_db, book, cos, cleanupToken)
		}
		return c.json({ error: 'Private paste failed', code: 'paste_failed' }, 502)
	}
})

novelPrivate.get('/sync', async c => {
	const auth = await authenticate(c, 'read')
	if (auth instanceof Response) return auth
	const limit = parseLimit(c.req.query('limit'), 100, 200)
	const cursor = decodeCursor(c.req.query('cursor'), 1)
	if (limit === null || cursor === null || (cursor && (!Number.isSafeInteger(cursor[0]) || Number(cursor[0]) < 0))) {
		return c.json({ error: 'Invalid pagination request', code: 'invalid_pagination' }, 400)
	}
	try {
		const result = await c.env.abdl_space_db.prepare(`
			SELECT seq, book_id, item_type, item_id, payload_json, client_updated_at, deleted_at
			FROM novel_sync_changes WHERE owner_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?
		`).bind(auth.user.sub, cursor ? cursor[0] : 0, limit + 1).all<NovelSyncItemRow>()
		if (!result.success) throw new Error('Database query failed')
		const hasMore = result.results.length > limit
		const page = result.results.slice(0, limit)
		const last = page.at(-1)
		return c.json({ items: page.map(syncItemResponse), next_cursor: hasMore && last?.seq !== undefined ? encodeCursor([last.seq]) : null })
	} catch {
		return c.json({ error: 'Novel sync query failed', code: 'sync_query_failed' }, 500)
	}
})

novelPrivate.put('/sync/items/:id', async c => {
	const auth = await authenticate(c, 'write')
	if (auth instanceof Response) return auth
	const input = await readJsonObjectLimited(c, MAX_SYNC_JSON_SIZE)
	if (input === 'too_large') return c.json({ error: 'Sync request is too large', code: 'request_too_large' }, 413)
	if (!input) return c.json({ error: 'Invalid sync item', code: 'invalid_sync_item' }, 400)
	const itemId = c.req.param('id')
	const bookId = typeof input.book_id === 'string' ? input.book_id : ''
	const itemType = typeof input.item_type === 'string' ? input.item_type : ''
	const incomingItemId = input.item_id
	const clientUpdatedAt = input.client_updated_at ?? input.updated_at
	const deletedAt = input.deleted_at === undefined || input.deleted_at === null ? null : input.deleted_at
	let payload: unknown = input.payload
	if (payload === undefined && typeof input.payload_json === 'string') {
		try { payload = JSON.parse(input.payload_json) } catch { payload = null }
	}
	if (!itemId || (incomingItemId !== undefined && incomingItemId !== itemId) || !bookId || !['progress', 'bookmark', 'note'].includes(itemType)
		|| !Number.isSafeInteger(clientUpdatedAt) || Number(clientUpdatedAt) < 0 || Number(clientUpdatedAt) > Date.now() + 5 * 60 * 1000
		|| (deletedAt !== null && (!Number.isSafeInteger(deletedAt) || Number(deletedAt) < 0))
		|| payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
		return c.json({ error: 'Invalid sync item', code: 'invalid_sync_item' }, 400)
	}
	const payloadJson = JSON.stringify(payload)
	if (new TextEncoder().encode(payloadJson).byteLength > MAX_SYNC_PAYLOAD_SIZE) return c.json({ error: 'Invalid sync item', code: 'invalid_sync_item' }, 400)
	try {
		const serverUpdatedAt = Date.now()
		const result = await c.env.abdl_space_db.prepare(`
			INSERT INTO novel_sync_items (book_id, owner_id, item_type, item_id, payload_json, client_updated_at, server_updated_at, deleted_at)
			SELECT ?, ?, ?, ?, ?, ?, ?, ? FROM private_books
			WHERE owner_id = ? AND id = ? AND deleted_at IS NULL
			ON CONFLICT(owner_id, item_type, item_id) DO UPDATE SET
				book_id = excluded.book_id, payload_json = excluded.payload_json,
				client_updated_at = excluded.client_updated_at, server_updated_at = excluded.server_updated_at,
				deleted_at = excluded.deleted_at
			WHERE EXISTS (SELECT 1 FROM private_books WHERE owner_id = excluded.owner_id AND id = excluded.book_id AND deleted_at IS NULL)
				AND ((novel_sync_items.deleted_at IS NULL AND excluded.client_updated_at > novel_sync_items.client_updated_at)
					OR (novel_sync_items.deleted_at IS NULL AND excluded.client_updated_at = novel_sync_items.client_updated_at AND excluded.deleted_at IS NOT NULL)
					OR (novel_sync_items.deleted_at IS NOT NULL AND excluded.deleted_at IS NOT NULL AND excluded.client_updated_at > novel_sync_items.client_updated_at))
		`).bind(bookId, auth.user.sub, itemType, itemId, payloadJson, clientUpdatedAt, serverUpdatedAt, deletedAt, auth.user.sub, bookId).run()
		if (!result.success) throw new Error('Database operation failed')
		if (result.meta.changes === 0) {
			const activeBook = await c.env.abdl_space_db.prepare('SELECT id FROM private_books WHERE owner_id = ? AND id = ? AND deleted_at IS NULL').bind(auth.user.sub, bookId).all<{ id: string }>()
			if (!activeBook.success) throw new Error('Database query failed')
			if (!activeBook.results[0]) return c.json({ error: 'Private book not found', code: 'book_not_found' }, 404)
		}
		const stored = await c.env.abdl_space_db.prepare(`
			SELECT book_id, item_type, item_id, payload_json, client_updated_at, server_updated_at, deleted_at
			FROM novel_sync_items WHERE owner_id = ? AND item_type = ? AND item_id = ?
		`).bind(auth.user.sub, itemType, itemId).all<NovelSyncItemRow>()
		if (!stored.success || !stored.results[0]) throw new Error('Database query failed')
		return c.json(syncItemResponse(stored.results[0]))
	} catch {
		return c.json({ error: 'Novel sync update failed', code: 'sync_update_failed' }, 500)
	}
})

novelPrivate.post('/authorize', async c => {
	const auth = await authenticate(c, 'write')
	if (auth instanceof Response) return auth
	const cos = privateCosOptions(c.env)
	if (!cos) return c.json({ error: 'Private storage is unavailable', code: 'private_storage_unavailable' }, 503)

	const input = await readJsonObjectLimited(c, MAX_SMALL_JSON_SIZE)
	if (input === 'too_large') return c.json({ error: 'Private book request is too large', code: 'request_too_large' }, 413)
	if (!input) return c.json({ error: 'Invalid private book request', code: 'invalid_book' }, 400)
	if (Object.hasOwn(input, 'object_key')) return c.json({ error: 'Client object keys are not allowed', code: 'invalid_book' }, 400)

	const mimeType = typeof input.mime_type === 'string' ? input.mime_type.trim().toLowerCase() : ''
	const mime = MIME_FORMATS[mimeType as keyof typeof MIME_FORMATS]
	const declaredSize = input.declared_size
	const title = typeof input.title === 'string' ? input.title.trim() : ''
	const author = typeof input.author === 'string' ? input.author.trim() : ''
	const contentHash = typeof input.content_hash === 'string' ? input.content_hash.trim().toLowerCase() : ''
	if (!mime || !Number.isSafeInteger(declaredSize) || Number(declaredSize) <= 0 || Number(declaredSize) > MAX_PRIVATE_BOOK_SIZE
		|| !title || title.length > 500 || !author || author.length > 500 || !/^[a-f0-9]{64}$/.test(contentHash)) {
		return c.json({ error: 'Invalid private book request', code: 'invalid_book' }, 400)
	}

	try {
		const existing = await getActiveBookByHash(c.env.abdl_space_db, auth.user.sub, contentHash)
		if (existing?.parse_status === 'ready') {
			return c.json({ upload_id: existing.id, already_uploaded: true, parse_status: 'ready' })
		}
		if (existing?.parse_status === 'pending' && !pendingMetadataMatches(existing, title, author, mime.format, Number(declaredSize))) {
			return c.json({ error: 'Private book metadata conflicts with an active upload', code: 'book_conflict' }, 409)
		}
		if (existing && existing.parse_status !== 'pending') {
			return c.json({ error: 'Private book is being processed', code: 'invalid_book_status' }, 409)
		}
		let id: string
		let objectKey: string
		if (existing) {
			id = existing.id
			objectKey = existing.object_key
		} else {
			id = crypto.randomUUID()
			objectKey = `novels/private/${auth.user.sub}/${id}.${mime.extension}`
		}

		const authorization = await createCosPutAuthorization({ ...cos, objectKey, contentType: mimeType, metadataSha256: contentHash })
		if (existing) {
			const result = await c.env.abdl_space_db.prepare(`
				UPDATE private_books SET upload_expires_at = ?, updated_at = unixepoch()
				WHERE id = ? AND owner_id = ? AND parse_status = 'pending'
					AND upload_expires_at = ? AND deleted_at IS NULL
			`).bind(authorization.expiresAt, id, auth.user.sub, existing.upload_expires_at).run()
			if (!result.success) throw new Error('Database operation failed')
			if (result.meta.changes !== 1) {
				const current = await getOwnedBook(c.env.abdl_space_db, id, auth.user.sub)
				if (current?.parse_status === 'ready') {
					return c.json({ upload_id: current.id, already_uploaded: true, parse_status: 'ready' })
				}
				return c.json({ error: 'Private book state changed', code: 'book_conflict' }, 409)
			}
		} else {
			const result = await c.env.abdl_space_db.prepare(PRIVATE_BOOK_INSERT_SQL)
				.bind(id, auth.user.sub, title, author, mime.format, objectKey, contentHash, declaredSize, authorization.expiresAt).run()
			if (!result.success) throw new Error('Database operation failed')
			if (result.meta.changes !== 1) {
				const concurrent = await getActiveBookByHash(c.env.abdl_space_db, auth.user.sub, contentHash)
				if (concurrent?.parse_status === 'ready') {
					return c.json({ upload_id: concurrent.id, already_uploaded: true, parse_status: 'ready' })
				}
				if (concurrent?.parse_status === 'pending') {
					if (!pendingMetadataMatches(concurrent, title, author, mime.format, Number(declaredSize))) {
						return c.json({ error: 'Private book metadata conflicts with an active upload', code: 'book_conflict' }, 409)
					}
					const concurrentAuthorization = await createCosPutAuthorization({ ...cos, objectKey: concurrent.object_key, contentType: mimeType, metadataSha256: concurrent.content_hash })
					const refreshed = await c.env.abdl_space_db.prepare(`
						UPDATE private_books SET upload_expires_at = ?, updated_at = unixepoch()
						WHERE id = ? AND owner_id = ? AND parse_status = 'pending'
							AND upload_expires_at = ? AND deleted_at IS NULL
					`).bind(concurrentAuthorization.expiresAt, concurrent.id, auth.user.sub, concurrent.upload_expires_at).run()
					if (!refreshed.success) throw new Error('Database operation failed')
					if (refreshed.meta.changes !== 1) {
						const current = await getOwnedBook(c.env.abdl_space_db, concurrent.id, auth.user.sub)
						if (current?.parse_status === 'ready' && current.verified_size !== null) {
							return c.json({ upload_id: current.id, already_uploaded: true, parse_status: 'ready' })
						}
						return c.json({ error: 'Private book state changed', code: 'book_conflict' }, 409)
					}
					return c.json({ upload_id: concurrent.id, upload_url: concurrentAuthorization.url, expires_at: concurrentAuthorization.expiresAt, required_headers: concurrentAuthorization.headers })
				}
				const usageResult = await c.env.abdl_space_db.prepare(`
					SELECT COUNT(*) AS book_count, COALESCE(SUM(declared_size), 0) AS total_size
					FROM private_books WHERE owner_id = ? AND deleted_at IS NULL
				`).bind(auth.user.sub).all<PrivateBookUsage>()
				if (!usageResult.success) throw new Error('Database query failed')
				const usage = usageResult.results[0] ?? { book_count: 0, total_size: 0 }
				if (usage.book_count >= MAX_PRIVATE_BOOK_COUNT || usage.total_size + Number(declaredSize) > MAX_PRIVATE_BOOK_TOTAL_SIZE) {
					return c.json({ error: 'Private library quota exceeded', code: 'private_library_quota' }, 429)
				}
				return c.json({ error: 'Private book state changed', code: 'book_conflict' }, 409)
			}
		}

		return c.json({ upload_id: id, upload_url: authorization.url, expires_at: authorization.expiresAt, required_headers: authorization.headers })
	} catch {
		return c.json({ error: 'Private book authorization failed', code: 'authorize_failed' }, 500)
	}
})

novelPrivate.post('/:id/complete', async c => {
	const auth = await authenticate(c, 'write')
	if (auth instanceof Response) return auth
	const cos = privateCosOptions(c.env)
	if (!cos) return c.json({ error: 'Private storage is unavailable', code: 'private_storage_unavailable' }, 503)
	const input = await readJsonObjectLimited(c, MAX_SMALL_JSON_SIZE)
	if (input === 'too_large') return c.json({ error: 'Completion request is too large', code: 'request_too_large' }, 413)
	if (!input) return c.json({ error: 'Invalid completion request', code: 'invalid_completion' }, 400)

	let claimedBook: PrivateBookRow | null = null
	let verificationStartedAt: number | null = null
	let shouldRestore = false
	try {
		const book = await getOwnedBook(c.env.abdl_space_db, c.req.param('id'), auth.user.sub)
		if (!book || book.deleted_at !== null) return c.json({ error: 'Private book not found', code: 'book_not_found' }, 404)
		if (book.parse_status === 'ready' && book.verified_size !== null) return c.json(bookResponse(book))
		const now = Math.floor(Date.now() / 1000)
		const verificationNow = Date.now() * 1000 + crypto.getRandomValues(new Uint16Array(1))[0] % 1000
		const staleBefore = verificationNow - VERIFICATION_LEASE_MICROSECONDS
		if (book.parse_status === 'parsing' && book.verification_started_at !== null && book.verification_started_at > staleBefore) {
			return c.json(bookResponse(book), 202)
		}
		if (book.parse_status !== 'pending' && book.parse_status !== 'parsing') return c.json({ error: 'Private book is not pending', code: 'invalid_book_status' }, 409)
		const previousToken = book.parse_status === 'pending' ? book.upload_expires_at : book.verification_started_at
		if (previousToken === null) return c.json({ error: 'Private book state changed', code: 'book_conflict' }, 409)

		const claim = await c.env.abdl_space_db.prepare(`
			UPDATE private_books
			SET parse_status = 'parsing', verification_started_at = ?, updated_at = unixepoch()
			WHERE id = ? AND owner_id = ? AND parse_status = ? AND deleted_at IS NULL
				AND ((parse_status = 'pending' AND upload_expires_at = ?)
					OR (parse_status = 'parsing' AND verification_started_at = ? AND verification_started_at <= ?))
		`).bind(verificationNow, book.id, auth.user.sub, book.parse_status, previousToken, previousToken, staleBefore).run()
		if (!claim.success) throw new Error('Database operation failed')
		if (claim.meta.changes !== 1) {
			const current = await getOwnedBook(c.env.abdl_space_db, book.id, auth.user.sub)
			if (current?.parse_status === 'ready' && current.verified_size !== null) return c.json(bookResponse(current))
			if (current?.parse_status === 'parsing') return c.json(bookResponse(current), 202)
			return c.json({ error: 'Private book state changed', code: 'book_conflict' }, 409)
		}
		claimedBook = book
		verificationStartedAt = verificationNow
		shouldRestore = true
		if (book.upload_expires_at <= now) {
			const cleanupToken = newCleanupToken()
			if (!await failAndDeleteBook(c.env.abdl_space_db, book, verificationNow, cleanupToken)) {
				const current = await getOwnedBook(c.env.abdl_space_db, book.id, auth.user.sub)
				if (current?.parse_status === 'ready' && current.verified_size !== null) return c.json(bookResponse(current))
				if (current?.parse_status === 'parsing') return c.json(bookResponse(current), 202)
				return c.json({ error: 'Private book state changed', code: 'book_conflict' }, 409)
			}
			shouldRestore = false
			await cleanupPrivateObject(c.env.abdl_space_db, book, cos, cleanupToken)
			return c.json({ error: 'Private book upload expired', code: 'upload_expired' }, 410)
		}

		let head: Response
		try {
			head = await headPrivateObjectFromCos({ ...cos, objectKey: book.object_key, contentType: book.format === 'txt' ? 'text/plain' : 'application/epub+zip' })
		} catch (error) {
			if (error instanceof CosHttpError && error.status === 404) return c.json({ error: 'Private object not found', code: 'verification_failed' }, 422)
			return c.json({ error: 'Private storage verification unavailable', code: 'verification_unavailable' }, 502)
		}

		const contentLength = head.headers.get('Content-Length')
		const verifiedSize = contentLength === null ? Number.NaN : Number(contentLength)
		const expectedMime = book.format === 'txt' ? 'text/plain' : 'application/epub+zip'
		if (!Number.isSafeInteger(verifiedSize) || verifiedSize !== book.declared_size || !matchesContentType(head.headers.get('Content-Type'), expectedMime)) {
			const cleanupToken = newCleanupToken()
			if (!await failAndDeleteBook(c.env.abdl_space_db, book, verificationNow, cleanupToken)) {
				const current = await getOwnedBook(c.env.abdl_space_db, book.id, auth.user.sub)
				if (current?.parse_status === 'ready' && current.verified_size !== null) return c.json(bookResponse(current))
				if (current?.parse_status === 'parsing') return c.json(bookResponse(current), 202)
				return c.json({ error: 'Private book state changed', code: 'book_conflict' }, 409)
			}
			shouldRestore = false
			await cleanupPrivateObject(c.env.abdl_space_db, book, cos, cleanupToken)
			return c.json({ error: 'Private object metadata mismatch', code: 'verification_mismatch' }, 422)
		}

		let objectResponse: Response
		try {
			objectResponse = await getPrivateObjectFromCos({ ...cos, objectKey: book.object_key, contentType: expectedMime })
		} catch (error) {
			if (error instanceof CosHttpError && error.status === 404) return c.json({ error: 'Private object not found', code: 'verification_failed' }, 422)
			return c.json({ error: 'Private storage verification unavailable', code: 'verification_unavailable' }, 502)
		}

		const getContentLength = objectResponse.headers.get('Content-Length')
		const declaredGetSize = getContentLength === null ? null : Number(getContentLength)
		if (declaredGetSize !== null && (!Number.isSafeInteger(declaredGetSize) || declaredGetSize !== book.declared_size)) {
			const cleanupToken = newCleanupToken()
			if (!await failAndDeleteBook(c.env.abdl_space_db, book, verificationNow, cleanupToken)) {
				const current = await getOwnedBook(c.env.abdl_space_db, book.id, auth.user.sub)
				if (current?.parse_status === 'ready' && current.verified_size !== null) return c.json(bookResponse(current))
				if (current?.parse_status === 'parsing') return c.json(bookResponse(current), 202)
				return c.json({ error: 'Private book state changed', code: 'book_conflict' }, 409)
			}
			shouldRestore = false
			await cleanupPrivateObject(c.env.abdl_space_db, book, cos, cleanupToken)
			return c.json({ error: 'Private object content mismatch', code: 'verification_mismatch' }, 422)
		}

		// WebCrypto has no streaming digest; the full read is bounded by MAX_PRIVATE_BOOK_SIZE (50 MiB).
		let objectBytes: ArrayBuffer
		try {
			objectBytes = await objectResponse.arrayBuffer()
		} catch {
			return c.json({ error: 'Private storage verification unavailable', code: 'verification_unavailable' }, 502)
		}
		const actualHash = toHex(await crypto.subtle.digest('SHA-256', objectBytes))
		if (objectBytes.byteLength !== book.declared_size || actualHash !== book.content_hash) {
			const cleanupToken = newCleanupToken()
			if (!await failAndDeleteBook(c.env.abdl_space_db, book, verificationNow, cleanupToken)) {
				const current = await getOwnedBook(c.env.abdl_space_db, book.id, auth.user.sub)
				if (current?.parse_status === 'ready' && current.verified_size !== null) return c.json(bookResponse(current))
				if (current?.parse_status === 'parsing') return c.json(bookResponse(current), 202)
				return c.json({ error: 'Private book state changed', code: 'book_conflict' }, 409)
			}
			shouldRestore = false
			await cleanupPrivateObject(c.env.abdl_space_db, book, cos, cleanupToken)
			return c.json({ error: 'Private object content mismatch', code: 'verification_mismatch' }, 422)
		}

		const result = await c.env.abdl_space_db.prepare(`
			UPDATE private_books
			SET verified_size = ?, parse_status = 'ready', verification_started_at = NULL, updated_at = unixepoch()
			WHERE id = ? AND owner_id = ? AND parse_status = 'parsing'
				AND verification_started_at = ? AND deleted_at IS NULL
		`).bind(verifiedSize, book.id, auth.user.sub, verificationNow).run()
		if (!result.success) throw new Error('Database operation failed')
		if (result.meta.changes !== 1) {
			const current = await getOwnedBook(c.env.abdl_space_db, book.id, auth.user.sub)
			if (current?.parse_status === 'ready' && current.verified_size !== null) return c.json(bookResponse(current))
			if (current?.parse_status === 'parsing') return c.json(bookResponse(current), 202)
			return c.json({ error: 'Private book state changed', code: 'book_conflict' }, 409)
		}
		shouldRestore = false
		return c.json(bookResponse({ ...book, verified_size: verifiedSize, parse_status: 'ready' }))
	} catch {
		return c.json({ error: 'Private book completion failed', code: 'complete_failed' }, 500)
	} finally {
		if (shouldRestore && claimedBook && verificationStartedAt !== null) {
			await restorePending(c.env.abdl_space_db, claimedBook, verificationStartedAt)
		}
	}
})

novelPrivate.post('/:id/download/authorize', async c => {
	const auth = await authenticate(c, 'read')
	if (auth instanceof Response) return auth
	const cos = privateCosOptions(c.env)
	if (!cos) return c.json({ error: 'Private storage is unavailable', code: 'private_storage_unavailable' }, 503)
	const input = await readJsonObjectLimited(c, MAX_SMALL_JSON_SIZE)
	if (input === 'too_large') return c.json({ error: 'Download request is too large', code: 'request_too_large' }, 413)
	if (!input) return c.json({ error: 'Invalid download request', code: 'invalid_download' }, 400)

	try {
		const book = await getOwnedBook(c.env.abdl_space_db, c.req.param('id'), auth.user.sub)
		if (!book || book.deleted_at !== null || book.parse_status !== 'ready' || book.verified_size === null) {
			return c.json({ error: 'Private book not found', code: 'book_not_found' }, 404)
		}
		const authorization = await createCosGetAuthorization({ ...cos, objectKey: book.object_key, contentType: book.format === 'txt' ? 'text/plain' : 'application/epub+zip' })
		return c.json({ download_url: authorization.url, expires_at: authorization.expiresAt })
	} catch {
		return c.json({ error: 'Download authorization failed', code: 'download_authorize_failed' }, 500)
	}
})

export default novelPrivate
