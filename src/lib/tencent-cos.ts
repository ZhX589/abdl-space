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
	metadataSha256?: string
	contentLength?: number
	contentMd5?: string
	now?: Date
}

export interface CosAuthorization {
	url: string
	host: string
	expiresAt: number
	headers: {
		Authorization: string
		'Content-Length'?: string
		'Content-MD5'?: string
		'Content-Type'?: string
		'x-cos-forbid-overwrite'?: 'true'
		'x-cos-meta-sha256'?: string
	}
}

export class CosHttpError extends Error {
	readonly status: number

	constructor(status: number, operation?: string) {
		super(operation ? `COS ${operation} failed: ${status}` : `COS request failed: ${status}`)
		this.name = 'CosHttpError'
		this.status = status
	}
}

interface PutObjectToCosOptions extends CosAuthorizationOptions {
	body: BodyInit
}

export function md5Base64(input: Uint8Array): string {
	const paddedLength = Math.ceil((input.byteLength + 9) / 64) * 64
	const padded = new Uint8Array(paddedLength)
	padded.set(input)
	padded[input.byteLength] = 0x80
	const bitLength = BigInt(input.byteLength) * 8n
	for (let index = 0; index < 8; index++) padded[paddedLength - 8 + index] = Number((bitLength >> BigInt(index * 8)) & 0xFFn)
	const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]
	const constants = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0)
	let a0 = 0x67452301
	let b0 = 0xefcdab89
	let c0 = 0x98badcfe
	let d0 = 0x10325476
	for (let offset = 0; offset < paddedLength; offset += 64) {
		const words = new Uint32Array(16)
		for (let index = 0; index < 16; index++) {
			const wordOffset = offset + index * 4
			words[index] = padded[wordOffset] | (padded[wordOffset + 1] << 8) | (padded[wordOffset + 2] << 16) | (padded[wordOffset + 3] << 24)
		}
		let a = a0
		let b = b0
		let c = c0
		let d = d0
		for (let index = 0; index < 64; index++) {
			let f: number
			let wordIndex: number
			if (index < 16) { f = (b & c) | (~b & d); wordIndex = index }
			else if (index < 32) { f = (d & b) | (~d & c); wordIndex = (5 * index + 1) % 16 }
			else if (index < 48) { f = b ^ c ^ d; wordIndex = (3 * index + 5) % 16 }
			else { f = c ^ (b | ~d); wordIndex = (7 * index) % 16 }
			const shift = shifts[Math.floor(index / 16) * 4 + index % 4]
			const sum = (a + f + constants[index] + words[wordIndex]) >>> 0
			const rotated = ((sum << shift) | (sum >>> (32 - shift))) >>> 0
			const previousD = d
			d = c
			c = b
			b = (b + rotated) >>> 0
			a = previousD
		}
		a0 = (a0 + a) >>> 0
		b0 = (b0 + b) >>> 0
		c0 = (c0 + c) >>> 0
		d0 = (d0 + d) >>> 0
	}
	let binary = ''
	for (const word of [a0, b0, c0, d0]) {
		for (let index = 0; index < 4; index++) binary += String.fromCharCode((word >>> (index * 8)) & 0xFF)
	}
	return btoa(binary)
}

export function isCanonicalContentMd5(value: string): boolean {
	if (!/^(?:[A-Za-z0-9+/]{4}){5}[A-Za-z0-9+/]{2}==$/.test(value)) return false
	try {
		const binary = atob(value)
		return binary.length === 16 && btoa(binary) === value
	} catch {
		return false
	}
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

async function createCosAuthorization(method: 'put' | 'head' | 'get' | 'delete', options: CosAuthorizationOptions): Promise<CosAuthorization> {
	const encodedKey = encodeObjectKey(options.objectKey)
	const host = getCosHost(options.bucket, options.region)
	const start = Math.floor((options.now ?? new Date()).getTime() / 1000)
	const expiresAt = start + AUTHORIZATION_TTL_SECONDS
	const signTime = `${start};${expiresAt}`
	const forbidOverwrite = method === 'put'
	const bindsContentIntegrity = forbidOverwrite && (options.contentLength !== undefined || options.contentMd5 !== undefined)
	if (bindsContentIntegrity && (!Number.isSafeInteger(options.contentLength) || Number(options.contentLength) <= 0
		|| typeof options.contentMd5 !== 'string' || !isCanonicalContentMd5(options.contentMd5))) {
		throw new Error('Invalid PUT content integrity headers')
	}
	const metadataSha256 = forbidOverwrite ? options.metadataSha256 : undefined
	const headerList = forbidOverwrite
		? `${bindsContentIntegrity ? 'content-length;content-md5;' : ''}content-type;host;x-cos-forbid-overwrite${metadataSha256 === undefined ? '' : ';x-cos-meta-sha256'}`
		: 'host'
	const canonicalHeaders = forbidOverwrite
		? `${bindsContentIntegrity ? `content-length=${options.contentLength}&content-md5=${encodeRfc3986(options.contentMd5!)}` + '&' : ''}content-type=${encodeRfc3986(options.contentType)}&host=${encodeRfc3986(host)}&x-cos-forbid-overwrite=true${metadataSha256 === undefined ? '' : `&x-cos-meta-sha256=${encodeRfc3986(metadataSha256)}`}`
		: `host=${encodeRfc3986(host)}`
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
			...(bindsContentIntegrity ? { 'Content-Length': String(options.contentLength), 'Content-MD5': options.contentMd5! } : {}),
			...(method === 'put' ? { 'Content-Type': options.contentType } : {}),
			...(forbidOverwrite ? { 'x-cos-forbid-overwrite': 'true' as const } : {}),
			...(metadataSha256 === undefined ? {} : { 'x-cos-meta-sha256': metadataSha256 }),
		},
	}
}

export function createCosPutAuthorization(options: CosAuthorizationOptions): Promise<CosAuthorization> {
	return createCosAuthorization('put', options)
}

export function createCosHeadAuthorization(options: CosAuthorizationOptions): Promise<CosAuthorization> {
	return createCosAuthorization('head', options)
}

export async function createCosGetAuthorization(options: CosAuthorizationOptions): Promise<CosAuthorization> {
	const authorization = await createCosAuthorization('get', options)
	return {
		...authorization,
		url: `${authorization.url}?${authorization.headers.Authorization}`,
		headers: { Authorization: authorization.headers.Authorization },
	}
}

export function createCosDeleteAuthorization(options: CosAuthorizationOptions): Promise<CosAuthorization> {
	return createCosAuthorization('delete', options)
}

export async function putObjectToCos(options: PutObjectToCosOptions): Promise<Response> {
	let bytes: Uint8Array | null = null
	if (typeof options.body === 'string') bytes = encoder.encode(options.body)
	else if (options.body instanceof Uint8Array) bytes = options.body
	else if (options.body instanceof ArrayBuffer) bytes = new Uint8Array(options.body)
	const signed = await createCosPutAuthorization({
		...options,
		contentLength: options.contentLength ?? bytes?.byteLength,
		contentMd5: options.contentMd5 ?? (bytes ? md5Base64(bytes) : undefined),
	})
	const response = await fetch(signed.url, {
		method: 'PUT',
		headers: signed.headers,
		body: options.body,
		redirect: 'manual',
	})
	if (!response.ok) {
		throw new Error(`COS PUT failed: ${response.status}`)
	}
	return response
}

export async function headObjectFromCos(options: CosAuthorizationOptions): Promise<Response> {
	const response = await fetch(buildCosObjectUrl(options.objectKey, options), {
		method: 'HEAD',
		redirect: 'manual',
	})
	if (!response.ok) {
		const requestId = response.headers.get('x-cos-request-id')
		throw new Error(`COS HEAD failed: ${response.status}${requestId ? ` (request ${requestId})` : ''}`)
	}
	return response
}

export async function headPrivateObjectFromCos(options: CosAuthorizationOptions): Promise<Response> {
	const signed = await createCosHeadAuthorization(options)
	const response = await fetch(signed.url, {
		method: 'HEAD',
		headers: signed.headers,
		redirect: 'manual',
	})
	if (!response.ok) {
		throw new CosHttpError(response.status >= 300 && response.status < 400 ? 502 : response.status)
	}
	return response
}

export async function getPrivateObjectFromCos(options: CosAuthorizationOptions): Promise<Response> {
	const signed = await createCosAuthorization('get', options)
	const response = await fetch(signed.url, {
		method: 'GET',
		headers: signed.headers,
		redirect: 'manual',
	})
	if (!response.ok) {
		throw new CosHttpError(response.status >= 300 && response.status < 400 ? 502 : response.status)
	}
	return response
}

export async function deleteObjectFromCos(options: CosAuthorizationOptions): Promise<Response> {
	const signed = await createCosDeleteAuthorization(options)
	const response = await fetch(signed.url, {
		method: 'DELETE',
		headers: signed.headers,
		redirect: 'manual',
	})
	if (!response.ok) {
		throw new CosHttpError(response.status >= 300 && response.status < 400 ? 502 : response.status, 'DELETE')
	}
	return response
}
