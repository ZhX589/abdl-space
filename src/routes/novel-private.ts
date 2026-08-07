import { Hono } from 'hono'
import type { Context } from 'hono'
import { cors } from 'hono/cors'

import { createCosGetAuthorization, createCosPutAuthorization, headPrivateObjectFromCos } from '../lib/tencent-cos.ts'
import { mastodonAuth } from '../mastodon/shared.ts'
import type { Env } from '../types/index.ts'

type AppType = { Bindings: Env }

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
	deleted_at: number | null
}

const MIME_FORMATS = {
	'text/plain': { format: 'txt', extension: 'txt' },
	'application/epub+zip': { format: 'epub', extension: 'epub' },
} as const

export const MAX_PRIVATE_BOOK_SIZE = 50 * 1024 * 1024

const novelPrivate = new Hono<AppType>()

novelPrivate.use('*', cors({
	origin: '*',
	allowMethods: ['POST', 'OPTIONS'],
	allowHeaders: ['Content-Type', 'Authorization'],
}))

function unauthorized(c: Context<AppType>) {
	return c.json({ error: 'The access token is invalid', code: 'unauthorized' }, 401)
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

function normalizeContentType(value: string | null): string {
	return (value ?? '').split(';', 1)[0].trim().toLowerCase()
}

function bookResponse(book: PrivateBookRow) {
	return {
		id: book.id,
		format: book.format,
		verified_size: book.verified_size,
		parse_status: book.parse_status,
	}
}

async function getOwnedBook(db: D1Database, id: string, ownerId: number): Promise<PrivateBookRow | null> {
	const result = await db.prepare(`
		SELECT id, owner_id, title, author, format, object_key, content_hash,
			declared_size, verified_size, parse_status, deleted_at
		FROM private_books WHERE id = ? AND owner_id = ?
	`).bind(id, ownerId).all<PrivateBookRow>()
	if (!result.success) throw new Error('Database query failed')
	return result.results[0] ?? null
}

function cosOptions(env: Env) {
	return {
		secretId: env.COS_SECRET_ID,
		secretKey: env.COS_SECRET_KEY,
		bucket: env.NOVEL_PRIVATE_COS_BUCKET,
		region: env.NOVEL_PRIVATE_COS_REGION,
	}
}

novelPrivate.post('/authorize', async c => {
	const user = await mastodonAuth(c)
	if (!user) return unauthorized(c)

	const input = await parseJsonObject(c)
	if (!input) return c.json({ error: 'Invalid private book request', code: 'invalid_book' }, 400)
	if (Object.hasOwn(input, 'object_key')) return c.json({ error: 'Client object keys are not allowed', code: 'invalid_book' }, 400)

	const mimeType = typeof input.mime_type === 'string' ? input.mime_type.trim().toLowerCase() : ''
	const mime = MIME_FORMATS[mimeType as keyof typeof MIME_FORMATS]
	const declaredSize = input.declared_size
	const title = typeof input.title === 'string' ? input.title.trim() : ''
	const author = typeof input.author === 'string' ? input.author.trim() : ''
	const contentHash = typeof input.content_hash === 'string' ? input.content_hash.trim().toLowerCase() : ''
	if (!mime
		|| !Number.isSafeInteger(declaredSize)
		|| Number(declaredSize) <= 0
		|| Number(declaredSize) > MAX_PRIVATE_BOOK_SIZE
		|| !title || title.length > 500
		|| !author || author.length > 500
		|| !/^[a-f0-9]{64}$/.test(contentHash)) {
		return c.json({ error: 'Invalid private book request', code: 'invalid_book' }, 400)
	}

	try {
		const id = crypto.randomUUID()
		const objectKey = `novels/private/${user.sub}/${id}.${mime.extension}`
		const authorization = await createCosPutAuthorization({
			...cosOptions(c.env),
			objectKey,
			contentType: mimeType,
		})
		const result = await c.env.abdl_space_db.prepare(`
			INSERT INTO private_books (
				id, owner_id, title, author, format, object_key, content_hash,
				declared_size, verified_size, parse_status
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending')
		`).bind(id, user.sub, title, author, mime.format, objectKey, contentHash, declaredSize).run()
		if (!result.success) throw new Error('Database operation failed')

		return c.json({
			upload_id: id,
			upload_url: authorization.url,
			expires_at: authorization.expiresAt,
			required_headers: authorization.headers,
		})
	} catch {
		return c.json({ error: 'Private book authorization failed', code: 'authorize_failed' }, 500)
	}
})

novelPrivate.post('/:id/complete', async c => {
	const user = await mastodonAuth(c)
	if (!user) return unauthorized(c)

	try {
		const book = await getOwnedBook(c.env.abdl_space_db, c.req.param('id'), user.sub)
		if (!book || book.deleted_at !== null) return c.json({ error: 'Private book not found', code: 'book_not_found' }, 404)
		if (book.parse_status === 'ready' && book.verified_size !== null) return c.json(bookResponse(book))
		if (book.parse_status !== 'pending') return c.json({ error: 'Private book is not pending', code: 'invalid_book_status' }, 409)

		let head: Response
		try {
			head = await headPrivateObjectFromCos({
				...cosOptions(c.env),
				objectKey: book.object_key,
				contentType: book.format === 'txt' ? 'text/plain' : 'application/epub+zip',
			})
		} catch {
			return c.json({ error: 'Private object verification failed', code: 'verification_failed' }, 422)
		}

		const contentLength = head.headers.get('Content-Length')
		const verifiedSize = contentLength === null ? Number.NaN : Number(contentLength)
		const expectedMime = book.format === 'txt' ? 'text/plain' : 'application/epub+zip'
		if (!Number.isSafeInteger(verifiedSize)
			|| verifiedSize !== book.declared_size
			|| normalizeContentType(head.headers.get('Content-Type')) !== expectedMime) {
			return c.json({ error: 'Private object metadata mismatch', code: 'verification_mismatch' }, 422)
		}

		const result = await c.env.abdl_space_db.prepare(`
			UPDATE private_books
			SET verified_size = ?, parse_status = 'ready', updated_at = unixepoch()
			WHERE id = ? AND owner_id = ? AND parse_status = 'pending' AND deleted_at IS NULL
		`).bind(verifiedSize, book.id, user.sub).run()
		if (!result.success) throw new Error('Database operation failed')
		if (result.meta.changes !== 1) {
			const current = await getOwnedBook(c.env.abdl_space_db, book.id, user.sub)
			if (current?.parse_status === 'ready' && current.verified_size !== null) return c.json(bookResponse(current))
			return c.json({ error: 'Private book state changed', code: 'book_conflict' }, 409)
		}

		return c.json(bookResponse({ ...book, verified_size: verifiedSize, parse_status: 'ready' }))
	} catch {
		return c.json({ error: 'Private book completion failed', code: 'complete_failed' }, 500)
	}
})

novelPrivate.post('/:id/download/authorize', async c => {
	const user = await mastodonAuth(c)
	if (!user) return unauthorized(c)

	try {
		const book = await getOwnedBook(c.env.abdl_space_db, c.req.param('id'), user.sub)
		if (!book || book.deleted_at !== null || book.parse_status !== 'ready' || book.verified_size === null) {
			return c.json({ error: 'Private book not found', code: 'book_not_found' }, 404)
		}
		const authorization = await createCosGetAuthorization({
			...cosOptions(c.env),
			objectKey: book.object_key,
			contentType: book.format === 'txt' ? 'text/plain' : 'application/epub+zip',
		})
		return c.json({ download_url: authorization.url, expires_at: authorization.expiresAt })
	} catch {
		return c.json({ error: 'Download authorization failed', code: 'download_authorize_failed' }, 500)
	}
})

export default novelPrivate
