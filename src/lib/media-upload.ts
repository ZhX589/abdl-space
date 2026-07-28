export const MEDIA_UPLOAD_AUTHORIZATION_TTL_SECONDS = 5 * 60

const MIB = 1024 * 1024
const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const

export type MediaUploadPurpose = 'status_original' | 'status_preview' | 'avatar' | 'header' | 'generic' | 'release'
export type MediaUploadStatus = 'pending' | 'complete' | 'failed'

export interface MediaUploadPolicy {
	mimeTypes: readonly string[]
	maxBytes: number
	requiresImageMetadata: boolean
}

export interface MediaUploadInput {
	purpose: string
	mimeType: string
	declaredSize: number
	width?: number
	height?: number
	objectKey?: string
}

export interface ValidatedMediaUpload {
	purpose: MediaUploadPurpose
	mimeType: string
	declaredSize: number
	width?: number
	height?: number
}

interface MediaObjectKeyOptions {
	purpose: MediaUploadPurpose
	userId: number
	mimeType: string
	now?: Date
	makeUuid?: () => string
}

interface OwnedUpload {
	userId: number
}

interface CompletableUpload extends OwnedUpload {
	status: MediaUploadStatus
	expiresAt: number
}

const policies: Record<MediaUploadPurpose, MediaUploadPolicy> = {
	status_original: { mimeTypes: IMAGE_MIME_TYPES, maxBytes: 10 * MIB, requiresImageMetadata: true },
	status_preview: { mimeTypes: ['image/jpeg', 'image/webp'], maxBytes: 2 * MIB, requiresImageMetadata: true },
	avatar: { mimeTypes: IMAGE_MIME_TYPES, maxBytes: 10 * MIB, requiresImageMetadata: true },
	header: { mimeTypes: IMAGE_MIME_TYPES, maxBytes: 10 * MIB, requiresImageMetadata: true },
	generic: { mimeTypes: IMAGE_MIME_TYPES, maxBytes: 10 * MIB, requiresImageMetadata: true },
	release: { mimeTypes: ['application/vnd.android.package-archive'], maxBytes: 200 * MIB, requiresImageMetadata: false },
}

const keyPrefixes: Record<MediaUploadPurpose, string> = {
	status_original: 'media/original',
	status_preview: 'media/preview',
	avatar: 'profile/avatar',
	header: 'profile/header',
	generic: 'generic',
	release: 'releases',
}

const mimeExtensions: Record<string, string> = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/gif': 'gif',
	'image/webp': 'webp',
	'application/vnd.android.package-archive': 'apk',
}

export function getMediaUploadPolicy(purpose: string): MediaUploadPolicy {
	const policy = policies[purpose as MediaUploadPurpose]
	if (!policy) throw new Error('Unsupported upload purpose')
	return policy
}

export function validateMediaUpload(input: MediaUploadInput): ValidatedMediaUpload {
	if (input.objectKey !== undefined) throw new Error('Client object key is not accepted')
	const policy = getMediaUploadPolicy(input.purpose)
	if (!policy.mimeTypes.includes(input.mimeType)) throw new Error('Unsupported upload MIME type')
	if (!Number.isSafeInteger(input.declaredSize) || input.declaredSize <= 0 || input.declaredSize > policy.maxBytes) {
		throw new Error('Invalid upload size')
	}

	if (policy.requiresImageMetadata) {
		if (!Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height) || input.width! <= 0 || input.height! <= 0) {
			throw new Error('Valid image metadata is required')
		}
		if (input.purpose === 'status_preview' && Math.max(input.width!, input.height!) > 540) {
			throw new Error('Status preview longest edge must not exceed 540px')
		}
	}

	return {
		purpose: input.purpose as MediaUploadPurpose,
		mimeType: input.mimeType,
		declaredSize: input.declaredSize,
		...(input.width === undefined ? {} : { width: input.width }),
		...(input.height === undefined ? {} : { height: input.height }),
	}
}

export function buildMediaObjectKey(options: MediaObjectKeyOptions): string {
	if (!Number.isSafeInteger(options.userId) || options.userId <= 0) throw new Error('Invalid upload user ID')
	const policy = getMediaUploadPolicy(options.purpose)
	if (!policy.mimeTypes.includes(options.mimeType)) throw new Error('Unsupported upload MIME type')
	const extension = mimeExtensions[options.mimeType]
	const date = (options.now ?? new Date()).toISOString().slice(0, 10)
	const uuid = options.makeUuid ? options.makeUuid() : crypto.randomUUID()
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) {
		throw new Error('Invalid generated upload UUID')
	}
	return `${keyPrefixes[options.purpose]}/${options.userId}/${date}/${uuid}.${extension}`
}

export function getUploadExpiresAt(now = new Date()): number {
	return Math.floor(now.getTime() / 1000) + MEDIA_UPLOAD_AUTHORIZATION_TTL_SECONDS
}

export function assertUploadOwner(upload: OwnedUpload, userId: number): void {
	if (upload.userId !== userId) throw new Error('Upload owner mismatch')
}

export function canCompleteUpload(upload: CompletableUpload, userId: number, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
	return upload.userId === userId && upload.status === 'pending' && upload.expiresAt >= nowSeconds
}
