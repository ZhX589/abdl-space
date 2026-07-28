const DEFAULT_BUCKET = 'abdl-1339643562'
const DEFAULT_REGION = 'ap-shanghai'
const AUTHORIZATION_TTL_SECONDS = 5 * 60

const encoder = new TextEncoder()

export interface CosObjectOptions {
	bucket?: string
	region?: string
	publicOrigin?: string
}

interface CosAuthorizationOptions extends CosObjectOptions {
	secretId: string
	secretKey: string
	objectKey: string
	contentType: string
	now?: Date
}

export interface CosAuthorization {
	url: string
	host: string
	expiresAt: number
	headers: {
		Authorization: string
		'Content-Type': string
		Host: string
	}
}

interface PutObjectToCosOptions extends CosAuthorizationOptions {
	body: BodyInit
}

function toHex(bytes: ArrayBuffer): string {
	return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}

async function sha1(value: string): Promise<string> {
	return toHex(await crypto.subtle.digest('SHA-1', encoder.encode(value)))
}

async function hmacSha1(key: string, value: string): Promise<string> {
	const cryptoKey = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
	return toHex(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(value)))
}

function encodeRfc3986(value: string): string {
	return encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

function encodeObjectKey(objectKey: string): string {
	const containsControlCharacter = Array.from(objectKey).some(character => {
		const codePoint = character.codePointAt(0)!
		return codePoint <= 0x1F || codePoint === 0x7F
	})
	if (!objectKey || objectKey.startsWith('/') || objectKey.endsWith('/') || /[\\?#]/.test(objectKey) || containsControlCharacter) {
		throw new Error('Invalid COS object key')
	}

	const segments = objectKey.split('/')
	if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
		throw new Error('Invalid COS object key')
	}

	try {
		return segments.map(encodeRfc3986).join('/')
	} catch {
		throw new Error('Invalid COS object key')
	}
}

function getCosHost(bucket = DEFAULT_BUCKET, region = DEFAULT_REGION): string {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(bucket) || !/^[a-z0-9][a-z0-9-]*$/.test(region)) {
		throw new Error('Invalid COS bucket or region')
	}
	return `${bucket}.cos.${region}.myqcloud.com`
}

export function buildCosObjectUrl(objectKey: string, options: CosObjectOptions = {}): string {
	const encodedKey = encodeObjectKey(objectKey)
	const origin = options.publicOrigin?.replace(/\/+$/, '') || `https://${getCosHost(options.bucket, options.region)}`
	return `${origin}/${encodedKey}`
}

async function createCosAuthorization(method: 'put' | 'head', options: CosAuthorizationOptions): Promise<CosAuthorization> {
	const encodedKey = encodeObjectKey(options.objectKey)
	const host = getCosHost(options.bucket, options.region)
	const start = Math.floor((options.now ?? new Date()).getTime() / 1000)
	const expiresAt = start + AUTHORIZATION_TTL_SECONDS
	const signTime = `${start};${expiresAt}`
	const headerList = 'content-type;host'
	const canonicalHeaders = `content-type=${encodeRfc3986(options.contentType)}&host=${encodeRfc3986(host)}`
	const httpString = `${method}\n/${options.objectKey}\n\n${canonicalHeaders}\n`
	const stringToSign = `sha1\n${signTime}\n${await sha1(httpString)}\n`
	const signKey = await hmacSha1(options.secretKey, signTime)
	const signature = await hmacSha1(signKey, stringToSign)
	const authorization = [
		'q-sign-algorithm=sha1',
		`q-ak=${encodeRfc3986(options.secretId)}`,
		`q-sign-time=${signTime}`,
		`q-key-time=${signTime}`,
		`q-header-list=${headerList}`,
		'q-url-param-list=',
		`q-signature=${signature}`,
	].join('&')

	return {
		url: `https://${host}/${encodedKey}`,
		host,
		expiresAt,
		headers: {
			Authorization: authorization,
			'Content-Type': options.contentType,
			Host: host,
		},
	}
}

export function createCosPutAuthorization(options: CosAuthorizationOptions): Promise<CosAuthorization> {
	return createCosAuthorization('put', options)
}

export function createCosHeadAuthorization(options: CosAuthorizationOptions): Promise<CosAuthorization> {
	return createCosAuthorization('head', options)
}

export async function putObjectToCos(options: PutObjectToCosOptions): Promise<Response> {
	const signed = await createCosPutAuthorization(options)
	const response = await fetch(signed.url, {
		method: 'PUT',
		headers: signed.headers,
		body: options.body,
	})
	if (!response.ok) {
		throw new Error(`COS PUT failed: ${response.status}`)
	}
	return response
}

export async function headObjectFromCos(options: CosAuthorizationOptions): Promise<Response> {
	const signed = await createCosHeadAuthorization(options)
	const response = await fetch(signed.url, {
		method: 'HEAD',
		headers: signed.headers,
		redirect: 'manual',
	})
	if (!response.ok) {
		const requestId = response.headers.get('x-cos-request-id')
		throw new Error(`COS HEAD failed: ${response.status}${requestId ? ` (request ${requestId})` : ''}`)
	}
	return response
}
