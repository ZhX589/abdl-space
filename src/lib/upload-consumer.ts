import { queryOne, run } from './db.ts'
import { buildMediaObjectKey, validateMediaUpload, type MediaUploadPurpose } from './media-upload.ts'
import { buildCosObjectUrl, deleteObjectFromCos, putObjectToCos } from './tencent-cos.ts'
import type { Env } from '../types/index.ts'

const IMGBED_HOST = 'https://img.abdl-space.top'

export interface CompletedUpload {
	id: string
	user_id: number
	purpose: MediaUploadPurpose
	object_key: string
	public_url: string
	mime_type: string
	declared_size: number
	verified_size: number | null
	width: number | null
	height: number | null
	storage_provider: 'cos' | 'imgbed'
	status: string
}

export async function getCompletedUpload(db: D1Database, id: string, userId: number, purpose: MediaUploadPurpose): Promise<CompletedUpload> {
	const upload = await queryOne<CompletedUpload>(db, `SELECT id, user_id, purpose, object_key, public_url,
		mime_type, declared_size, verified_size, width, height, storage_provider, status
		FROM media_uploads WHERE id = ?`, [id])
	if (!upload || upload.user_id !== userId || upload.purpose !== purpose || upload.status !== 'complete' || upload.verified_size === null) {
		throw new Error('Invalid completed upload')
	}
	return upload
}

export async function getCompletedUploadReference(db: D1Database, reference: string, userId: number, purpose: MediaUploadPurpose): Promise<CompletedUpload> {
	const upload = await queryOne<CompletedUpload>(db, `SELECT id, user_id, purpose, object_key, public_url,
		mime_type, declared_size, verified_size, width, height, storage_provider, status
		FROM media_uploads WHERE (id = ? OR public_url = ?) AND user_id = ? AND purpose = ? AND status = 'complete'
		AND verified_size IS NOT NULL`, [reference, reference, userId, purpose])
	if (!upload) {
		throw new Error('Invalid completed upload')
	}
	return upload
}

export async function uploadLegacyObject(
	env: Env,
	userId: number,
	purpose: MediaUploadPurpose,
	file: File,
	useImgbedFallback: boolean,
	metadata: { width?: number; height?: number } = {},
): Promise<CompletedUpload> {
	const mimeType = file.type.split(';', 1)[0].trim().toLowerCase()
	const bytes = new Uint8Array(await file.arrayBuffer())
	const validated = validateMediaUpload({
		purpose,
		mimeType,
		declaredSize: bytes.byteLength,
		width: metadata.width,
		height: metadata.height,
	})
	const id = crypto.randomUUID()
	const createdAt = Math.floor(Date.now() / 1000)
	const expiresAt = createdAt + 300
	let objectKey: string
	let publicUrl: string
	let storageProvider: 'cos' | 'imgbed'

	if (useImgbedFallback) {
		const form = new FormData()
		form.append('file', file)
		let response = await fetch(`${IMGBED_HOST}/upload?returnFormat=full`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${env.IMGBED_UPLOAD_KEY}` },
			body: form,
		})
		if (!response.ok && env.IMGBED_UPLOAD_KEY) {
			const retryForm = new FormData()
			retryForm.append('file', file)
			response = await fetch(`${IMGBED_HOST}/upload?returnFormat=full&authCode=${encodeURIComponent(env.IMGBED_UPLOAD_KEY)}`, {
				method: 'POST',
				body: retryForm,
			})
		}
		if (!response.ok) throw new Error('Imgbed upload failed')
		const data = await response.json() as { src?: string }[]
		publicUrl = data[0]?.src ?? ''
		if (!publicUrl || new URL(publicUrl).origin !== IMGBED_HOST) throw new Error('Imgbed upload failed')
		objectKey = `legacy/imgbed/${id}`
		storageProvider = 'imgbed'
	} else {
		objectKey = buildMediaObjectKey({ purpose, userId, mimeType })
		await putObjectToCos({
			secretId: env.COS_SECRET_ID,
			secretKey: env.COS_SECRET_KEY,
			bucket: env.COS_BUCKET,
			region: env.COS_REGION,
			objectKey,
			contentType: mimeType,
			body: bytes,
		})
		publicUrl = buildCosObjectUrl(objectKey, {
			bucket: env.COS_BUCKET,
			region: env.COS_REGION,
			publicOrigin: env.COS_PUBLIC_ORIGIN,
		})
		storageProvider = 'cos'
	}

	await run(env.abdl_space_db, `INSERT INTO media_uploads (
		id, user_id, purpose, object_key, public_url, mime_type, declared_size,
		verified_size, width, height, storage_provider, status, created_at, expires_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete', ?, ?)`, [
		id, userId, purpose, objectKey, publicUrl, mimeType, bytes.byteLength, bytes.byteLength,
		validated.width ?? null, validated.height ?? null, storageProvider, createdAt, expiresAt,
	])

	return {
		id,
		user_id: userId,
		purpose,
		object_key: objectKey,
		public_url: publicUrl,
		mime_type: mimeType,
		declared_size: bytes.byteLength,
		verified_size: bytes.byteLength,
		width: validated.width ?? null,
		height: validated.height ?? null,
		storage_provider: storageProvider,
		status: 'complete',
	}
}

export async function deleteCompletedUpload(options: {
	db: D1Database
	id: string
	userId: number
	purpose: MediaUploadPurpose
	cos: { secretId: string; secretKey: string; bucket?: string; region?: string }
}): Promise<void> {
	const upload = await getCompletedUpload(options.db, options.id, options.userId, options.purpose)
	if (upload.storage_provider !== 'cos') throw new Error('Upload is not stored in COS')
	await deleteObjectFromCos({
		...options.cos,
		objectKey: upload.object_key,
		contentType: upload.mime_type,
	})
	await run(options.db, 'DELETE FROM media_uploads WHERE id = ? AND user_id = ?', [upload.id, options.userId])
}
