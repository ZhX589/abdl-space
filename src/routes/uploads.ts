import { Hono } from 'hono'
import { cors } from 'hono/cors'

import { buildMediaObjectKey, validateMediaUpload } from '../lib/media-upload.ts'
import { buildCosObjectUrl, createCosPutAuthorization, headObjectFromCos } from '../lib/tencent-cos.ts'
import { mastodonAuth } from '../mastodon/shared.ts'
import type { Env } from '../types/index.ts'

type AppType = { Bindings: Env }

const uploads = new Hono<AppType>()

interface MediaUploadRow {
	id: string
	user_id: number
	purpose: string
	object_key: string
	public_url: string
	preview_upload_id: string | null
	preview_object_key: string | null
	preview_url: string | null
	mime_type: string
	declared_size: number
	verified_size: number | null
	width: number | null
	height: number | null
	blurhash: string | null
	storage_provider: string
	status: string
	expires_at: number
}

uploads.use('*', cors({
	origin: '*',
	allowMethods: ['POST', 'OPTIONS'],
	allowHeaders: ['Content-Type', 'Authorization'],
}))

uploads.post('/authorize', async (c) => {
	const user = await mastodonAuth(c)
	if (!user) return c.json({ error: 'The access token is invalid', code: 'unauthorized' }, 401)

	try {
		const input = await c.req.json()
		if (!input || typeof input !== 'object' || Array.isArray(input)) {
			return c.json({ error: 'Invalid upload request', code: 'invalid_upload' }, 400)
		}
		const validated = validateMediaUpload(input)
		if (validated.purpose === 'release' && user.role !== 'admin') {
			return c.json({ error: 'Admin access required', code: 'release_forbidden' }, 403)
		}

		const now = new Date()
		const id = crypto.randomUUID()
		const objectKey = buildMediaObjectKey({
			purpose: validated.purpose,
			userId: user.sub,
			mimeType: validated.mimeType,
			now,
		})
		const cosOptions = {
			bucket: c.env.COS_BUCKET,
			region: c.env.COS_REGION,
		}
		const authorization = await createCosPutAuthorization({
			secretId: c.env.COS_SECRET_ID,
			secretKey: c.env.COS_SECRET_KEY,
			objectKey,
			contentType: validated.mimeType,
			now,
			...cosOptions,
		})
		const publicUrl = buildCosObjectUrl(objectKey, {
			...cosOptions,
			publicOrigin: c.env.COS_PUBLIC_ORIGIN,
		})
		const createdAt = Math.floor(now.getTime() / 1000)

		const result = await c.env.abdl_space_db.prepare(`
			INSERT INTO media_uploads (
				id, user_id, purpose, object_key, public_url, mime_type,
				declared_size, width, height, storage_provider, status, created_at, expires_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'cos', 'pending', ?, ?)
		`).bind(
			id,
			user.sub,
			validated.purpose,
			objectKey,
			publicUrl,
			validated.mimeType,
			validated.declaredSize,
			validated.width ?? null,
			validated.height ?? null,
			createdAt,
			authorization.expiresAt,
		).run()
		if (!result.success) throw new Error('Database operation failed')

		return c.json({
			id,
			uploadUrl: authorization.url,
			publicUrl,
			expiresAt: authorization.expiresAt,
			requiredHeaders: authorization.headers,
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Invalid upload request'
		if (/purpose|MIME|size|metadata|540|object key|JSON/i.test(message)) {
			return c.json({ error: message, code: 'invalid_upload' }, 400)
		}
		return c.json({ error: 'Upload authorization failed', code: 'authorize_failed' }, 500)
	}
})

function normalizeContentType(contentType: string | null): string {
	return (contentType ?? '').split(';', 1)[0].trim().toLowerCase()
}

function mediaType(mimeType: string): string {
	return mimeType.startsWith('image/') ? 'image' : 'unknown'
}

function imageMetadata(row: MediaUploadRow): Record<string, number | string> | null {
	if (row.width === null || row.height === null) return null
	return { width: row.width, height: row.height, size: `${row.width}x${row.height}` }
}

function attachment(row: MediaUploadRow, preview?: MediaUploadRow) {
	const original = imageMetadata(row)
	const small = preview ? imageMetadata(preview) : null
	return {
		id: row.id,
		url: row.public_url,
		preview_url: preview?.public_url ?? row.preview_url ?? row.public_url,
		type: mediaType(row.mime_type),
		blurhash: row.blurhash,
		metadata: {
			...(original ? { original } : {}),
			...(small ? { small } : {}),
		},
	}
}

async function getUpload(db: D1Database, id: string): Promise<MediaUploadRow | null> {
	const result = await db.prepare(`
		SELECT id, user_id, purpose, object_key, public_url,
			preview_upload_id, preview_object_key, preview_url,
			mime_type, declared_size, verified_size, width, height,
			blurhash, storage_provider, status, expires_at
		FROM media_uploads WHERE id = ?
	`).bind(id).all<MediaUploadRow>()
	if (!result.success) throw new Error('Database query failed')
	return result.results[0] ?? null
}

uploads.post('/:id/complete', async (c) => {
	const user = await mastodonAuth(c)
	if (!user) return c.json({ error: 'The access token is invalid', code: 'unauthorized' }, 401)

	try {
		const upload = await getUpload(c.env.abdl_space_db, c.req.param('id'))
		if (!upload) return c.json({ error: 'Upload not found', code: 'upload_not_found' }, 404)
		if (upload.user_id !== user.sub) return c.json({ error: 'Upload owner mismatch', code: 'wrong_owner' }, 403)
		if (upload.purpose === 'release' && user.role !== 'admin') {
			return c.json({ error: 'Admin access required', code: 'release_forbidden' }, 403)
		}

		let body: { previewUploadId?: unknown } = {}
		try {
			body = await c.req.json()
		} catch {
			body = {}
		}
		const previewUploadId = typeof body.previewUploadId === 'string' ? body.previewUploadId : undefined

		if (upload.status === 'complete') {
			if (upload.purpose === 'status_original' && previewUploadId !== upload.preview_upload_id) {
				return c.json({ error: 'Upload was completed with a different preview', code: 'upload_conflict' }, 409)
			}
			if (upload.purpose !== 'status_original' && previewUploadId !== undefined) {
				return c.json({ error: 'Preview upload is not allowed', code: 'preview_not_allowed' }, 400)
			}
			const linkedPreview = upload.preview_upload_id ? await getUpload(c.env.abdl_space_db, upload.preview_upload_id) : undefined
			return c.json(attachment(upload, linkedPreview ?? undefined))
		}
		if (upload.status !== 'pending') return c.json({ error: 'Upload is not pending', code: 'invalid_upload_status' }, 409)

		const nowSeconds = Math.floor(Date.now() / 1000)
		if (upload.expires_at < nowSeconds) return c.json({ error: 'Upload authorization expired', code: 'upload_expired' }, 409)

		let preview: MediaUploadRow | undefined
		if (upload.purpose === 'status_original') {
			if (!previewUploadId) return c.json({ error: 'Preview upload is required', code: 'preview_required' }, 400)
			if (previewUploadId === upload.id) return c.json({ error: 'Upload cannot reference itself', code: 'invalid_preview' }, 400)
			preview = await getUpload(c.env.abdl_space_db, previewUploadId) ?? undefined
			if (!preview
				|| preview.user_id !== user.sub
				|| preview.purpose !== 'status_preview'
				|| preview.status !== 'complete'
				|| preview.verified_size === null
				|| preview.expires_at < nowSeconds) {
				return c.json({ error: 'Preview upload is not complete', code: 'invalid_preview' }, 409)
			}
		} else if (previewUploadId !== undefined) {
			return c.json({ error: 'Preview upload is not allowed', code: 'preview_not_allowed' }, 400)
		}

		let headResponse: Response
		try {
			headResponse = await headObjectFromCos({
				secretId: c.env.COS_SECRET_ID,
				secretKey: c.env.COS_SECRET_KEY,
				bucket: c.env.COS_BUCKET,
				region: c.env.COS_REGION,
				objectKey: upload.object_key,
				contentType: upload.mime_type,
			})
		} catch {
			return c.json({ error: 'COS object verification failed', code: 'cos_head_failed' }, 502)
		}

		const verifiedSize = Number(headResponse.headers.get('Content-Length'))
		if (!Number.isSafeInteger(verifiedSize) || verifiedSize !== upload.declared_size) {
			return c.json({ error: 'Uploaded object size mismatch', code: 'size_mismatch' }, 422)
		}
		if (normalizeContentType(headResponse.headers.get('Content-Type')) !== normalizeContentType(upload.mime_type)) {
			return c.json({ error: 'Uploaded object type mismatch', code: 'type_mismatch' }, 422)
		}

		const completeResult = preview
			? await c.env.abdl_space_db.prepare(`
				UPDATE media_uploads
				SET status = 'complete', verified_size = ?, preview_upload_id = ?, preview_object_key = ?, preview_url = ?
				WHERE id = ? AND user_id = ? AND status = 'pending' AND expires_at >= ?
					AND EXISTS (
						SELECT 1 FROM media_uploads AS preview
						WHERE preview.id = ? AND preview.user_id = ?
							AND preview.purpose = 'status_preview'
							AND preview.status = 'complete'
							AND preview.verified_size IS NOT NULL
							AND preview.expires_at >= ?
					)
			`).bind(
				verifiedSize,
				preview.id,
				preview.object_key,
				preview.public_url,
				upload.id,
				user.sub,
				nowSeconds,
				preview.id,
				user.sub,
				nowSeconds,
			).run()
			: await c.env.abdl_space_db.prepare(`
				UPDATE media_uploads SET status = 'complete', verified_size = ?
				WHERE id = ? AND user_id = ? AND status = 'pending' AND expires_at >= ?
			`).bind(verifiedSize, upload.id, user.sub, nowSeconds).run()
		if (!completeResult.success) throw new Error('Database operation failed')
		if (completeResult.meta.changes !== 1) {
			const current = await getUpload(c.env.abdl_space_db, upload.id)
			if (current?.user_id === user.sub && current.status === 'complete') {
				const linkedPreview = current.preview_upload_id ? await getUpload(c.env.abdl_space_db, current.preview_upload_id) : undefined
				return c.json(attachment(current, linkedPreview ?? undefined))
			}
			return c.json({ error: 'Upload state changed', code: 'upload_conflict' }, 409)
		}

		upload.status = 'complete'
		upload.verified_size = verifiedSize
		if (preview) {
			upload.preview_upload_id = preview.id
			upload.preview_object_key = preview.object_key
			upload.preview_url = preview.public_url
		}
		return c.json(attachment(upload, preview))
	} catch {
		return c.json({ error: 'Upload completion failed', code: 'complete_failed' }, 500)
	}
})

export default uploads
