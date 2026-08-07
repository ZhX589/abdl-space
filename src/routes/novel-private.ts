import { Hono } from 'hono'
import type { Context } from 'hono'
import { cors } from 'hono/cors'

import { CosHttpError, createCosGetAuthorization, createCosPutAuthorization, deleteObjectFromCos, headPrivateObjectFromCos } from '../lib/tencent-cos.ts'
import { mastodonAuthDetails } from '../mastodon/shared.ts'
import { assertSessionNotStale } from '../middleware/auth.ts'
import type { Env } from '../types/index.ts'

type AppType = { Bindings: Env }
type AuthDetails = NonNullable<Awaited<ReturnType<typeof mastodonAuthDetails>>>

interface PrivateBookRow {
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
	allowMethods: ['POST', 'OPTIONS'],
	allowHeaders: ['Content-Type', 'Authorization'],
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

async function parseJsonObject(c: Context<AppType>): Promise<Record<string, unknown> | null> {
	try {
		const text = await c.req.text()
		const value: unknown = text.trim() ? JSON.parse(text) : {}
		return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
	} catch {
		return null
	}
}

function matchesContentType(value: string | null, expected: string): boolean {
	return value !== null && value.trim().toLowerCase() === expected
}

function bookResponse(book: PrivateBookRow) {
	return { id: book.id, format: book.format, verified_size: book.verified_size, parse_status: book.parse_status }
}

async function getOwnedBook(db: D1Database, id: string, ownerId: number): Promise<PrivateBookRow | null> {
	const result = await db.prepare(`
		SELECT id, owner_id, title, author, format, object_key, content_hash,
			declared_size, verified_size, parse_status, upload_expires_at, verification_started_at,
			cleanup_status, cleanup_attempted_at, deleted_at
		FROM private_books WHERE id = ? AND owner_id = ?
	`).bind(id, ownerId).all<PrivateBookRow>()
	if (!result.success) throw new Error('Database query failed')
	return result.results[0] ?? null
}

async function getActiveBookByHash(db: D1Database, ownerId: number, contentHash: string): Promise<PrivateBookRow | null> {
	const result = await db.prepare(`
		SELECT id, owner_id, title, author, format, object_key, content_hash,
			declared_size, verified_size, parse_status, upload_expires_at, verification_started_at,
			cleanup_status, cleanup_attempted_at, deleted_at
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

async function failAndDeleteBook(db: D1Database, book: PrivateBookRow, verificationStartedAt: number): Promise<boolean> {
	const result = await db.prepare(`
		UPDATE private_books
		SET parse_status = 'failed', deleted_at = unixepoch(), verification_started_at = NULL,
			cleanup_status = 'deleting', cleanup_attempted_at = unixepoch(), updated_at = unixepoch()
		WHERE id = ? AND owner_id = ? AND parse_status = 'parsing'
			AND verification_started_at = ? AND deleted_at IS NULL
	`).bind(book.id, book.owner_id, verificationStartedAt).run()
	return result.success && result.meta.changes === 1
}

async function cleanupPrivateObject(db: D1Database, book: PrivateBookRow, cos: NonNullable<ReturnType<typeof privateCosOptions>>): Promise<void> {
	let cleanupStatus: PrivateBookRow['cleanup_status'] = 'done'
	try {
		await deleteObjectFromCos({ ...cos, objectKey: book.object_key, contentType: book.format === 'txt' ? 'text/plain' : 'application/epub+zip' })
	} catch (error) {
		if (!(error instanceof CosHttpError && error.status === 404)) cleanupStatus = 'failed'
	}
	const result = await db.prepare(`
		UPDATE private_books SET cleanup_status = ?, updated_at = unixepoch()
		WHERE id = ? AND owner_id = ? AND deleted_at IS NOT NULL AND cleanup_status = 'deleting'
	`).bind(cleanupStatus, book.id, book.owner_id).run()
	if (!result.success || result.meta.changes !== 1) throw new Error('Database operation failed')
}

function pendingMetadataMatches(book: PrivateBookRow, title: string, author: string, format: 'txt' | 'epub', declaredSize: number): boolean {
	return book.title === title && book.author === author && book.format === format && book.declared_size === declaredSize
}

novelPrivate.post('/authorize', async c => {
	const auth = await authenticate(c, 'write')
	if (auth instanceof Response) return auth
	const cos = privateCosOptions(c.env)
	if (!cos) return c.json({ error: 'Private storage is unavailable', code: 'private_storage_unavailable' }, 503)

	const input = await parseJsonObject(c)
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

		const authorization = await createCosPutAuthorization({ ...cos, objectKey, contentType: mimeType })
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
					const concurrentAuthorization = await createCosPutAuthorization({ ...cos, objectKey: concurrent.object_key, contentType: mimeType })
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
			if (!await failAndDeleteBook(c.env.abdl_space_db, book, verificationNow)) {
				const current = await getOwnedBook(c.env.abdl_space_db, book.id, auth.user.sub)
				if (current?.parse_status === 'ready' && current.verified_size !== null) return c.json(bookResponse(current))
				if (current?.parse_status === 'parsing') return c.json(bookResponse(current), 202)
				return c.json({ error: 'Private book state changed', code: 'book_conflict' }, 409)
			}
			shouldRestore = false
			await cleanupPrivateObject(c.env.abdl_space_db, book, cos)
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
			if (!await failAndDeleteBook(c.env.abdl_space_db, book, verificationNow)) {
				const current = await getOwnedBook(c.env.abdl_space_db, book.id, auth.user.sub)
				if (current?.parse_status === 'ready' && current.verified_size !== null) return c.json(bookResponse(current))
				if (current?.parse_status === 'parsing') return c.json(bookResponse(current), 202)
				return c.json({ error: 'Private book state changed', code: 'book_conflict' }, 409)
			}
			shouldRestore = false
			await cleanupPrivateObject(c.env.abdl_space_db, book, cos)
			return c.json({ error: 'Private object metadata mismatch', code: 'verification_mismatch' }, 422)
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
