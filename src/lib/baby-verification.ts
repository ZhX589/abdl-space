import type { Context, Next } from 'hono'
import { assertSessionNotStale } from '../middleware/auth.ts'
import { mastodonAuthDetails } from '../mastodon/shared.ts'
import { createCosGetAuthorization, createCosPutAuthorization, getPrivateObjectFromCos, headPrivateObjectFromCos, isCanonicalContentMd5 } from './tencent-cos.ts'
import type { BabyVerificationConfig, BabyVerificationMe, Env, JWTPayload } from '../types/index.ts'

export type BabyVerificationAppType = { Bindings: Env; Variables: { user: JWTPayload } }
type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 502 | 503

/** A stable client-safe baby-verification error. */
export class BabyVerificationError extends Error {
	readonly code: string
	readonly status: ErrorStatus
	readonly details: Record<string, unknown>
	constructor(code: string, message: string, status: ErrorStatus = 422, details: Record<string, unknown> = {}) {
		super(message)
		this.code = code
		this.status = status
		this.details = details
	}
}

/** Convert an unknown failure to the public error envelope without leaking private data. */
export function babyVerificationErrorResponse(error: unknown, c: Context<BabyVerificationAppType>): Response {
	const safe = error instanceof BabyVerificationError ? error : new BabyVerificationError('service_unavailable', '宝宝认证服务暂不可用', 503)
	c.header('Cache-Control', 'private, no-store')
	return c.json({ error: safe.message, code: safe.code, ...safe.details }, safe.status)
}

/** Require a bounded JSON object. */
export function babyObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BabyVerificationError('invalid_request', '请求格式不正确', 400)
	return value as Record<string, unknown>
}

/** Validate bounded text without control characters. */
export function babyText(value: unknown, label: string, maximum = 500, allowEmpty = false): string {
	// eslint-disable-next-line no-control-regex -- private form fields must reject controls
	if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && !value.trim()) || /[\u0000-\u001f\u007f]/.test(value)) throw new BabyVerificationError('invalid_request', `${label}格式不正确`, 400)
	return value.trim()
}

/** Validate a UUID idempotency operation identifier. */
export function babyOperationId(value: unknown): string {
	const text = babyText(value, 'operation_id', 64)
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) throw new BabyVerificationError('invalid_operation_id', 'operation_id 必须为 UUID', 400)
	return text.toLowerCase()
}

/** Parse a request JSON body with a strict byte limit. */
export async function readBabyJson(request: Request, maximumBytes = 64 * 1024): Promise<unknown> {
	const length = request.headers.get('content-length')
	if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximumBytes)) throw new BabyVerificationError('request_too_large', '请求内容过大', 413)
	const reader = request.body?.getReader()
	if (!reader) return {}
	const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
	let bytes = 0
	let text = ''
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			bytes += value.byteLength
			if (bytes > maximumBytes) { await reader.cancel(); throw new BabyVerificationError('request_too_large', '请求内容过大', 413) }
			text += decoder.decode(value, { stream: true })
		}
		return JSON.parse(text + decoder.decode()) as unknown
	} catch (error) {
		if (error instanceof BabyVerificationError) throw error
		throw new BabyVerificationError('invalid_request', 'JSON 请求格式不正确', 400)
	}
}

function toHex(value: ArrayBuffer): string { return Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join('') }
function encode64Url(bytes: Uint8Array): string {
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function decode64(value: string): Uint8Array { return Uint8Array.from(atob(value), character => character.charCodeAt(0)) }

/** Domain-separated SHA-256 used for operations and public credential lookup. */
export async function babyHash(domain: string, value: string): Promise<string> {
	return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`abdl-space:baby-verification:${domain}\0${value}`)))
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new BabyVerificationError('invalid_request', `${label}超出范围`, 400)
	return value
}

/** Validate the versioned server configuration. */
export function validateBabyVerificationConfig(value: unknown): BabyVerificationConfig {
	const input = babyObject(value)
	const free = integer(input.free_monthly_limit, 0, 20, '普通用户月额度')
	const sponsor = integer(input.sponsor_monthly_limit, free, 20, '赞助者月额度')
	if (typeof input.enabled !== 'boolean') throw new BabyVerificationError('invalid_request', 'enabled 必须为布尔值', 400)
	return {
		version: integer(input.version, 1, 2147483647, '配置版本'), enabled: input.enabled,
		declaration_version: babyText(input.declaration_version, '声明版本', 64), free_monthly_limit: free,
		sponsor_monthly_limit: sponsor, capture_ttl_seconds: integer(input.capture_ttl_seconds, 300, 3600, '拍摄会话时限'),
		upload_ttl_seconds: integer(input.upload_ttl_seconds, 60, 900, '上传授权时限'), max_evidence_size: integer(input.max_evidence_size, 1024, 8 * 1024 * 1024, '照片大小'),
	}
}

/** Read the singleton feature configuration and fail closed when migration is absent. */
export async function getBabyVerificationConfig(env: Pick<Env, 'abdl_space_db'>): Promise<BabyVerificationConfig> {
	const row = await env.abdl_space_db.prepare(`SELECT version,enabled,declaration_version,free_monthly_limit,sponsor_monthly_limit,capture_ttl_seconds,upload_ttl_seconds,max_evidence_size FROM baby_verification_settings WHERE id=1`).first<Record<string, unknown>>()
	if (!row) throw new BabyVerificationError('service_unavailable', '宝宝认证配置不可用', 503)
	return validateBabyVerificationConfig({ ...row, enabled: row.enabled === 1 })
}

function cosOptions(env: Env) {
	const secretId = env.COS_SECRET_ID?.trim()
	const secretKey = env.COS_SECRET_KEY?.trim()
	const bucket = env.COS_BUCKET?.trim()
	const region = env.COS_REGION?.trim()
	if (!secretId || !secretKey || !bucket || !region) throw new BabyVerificationError('private_storage_unavailable', '宝宝认证私有存储暂不可用', 503)
	return { secretId, secretKey, bucket, region }
}

async function dataKey(env: Env): Promise<CryptoKey> {
	try {
		if (!env.BABY_VERIFICATION_DATA_KEY) throw new Error('missing')
		const raw = decode64(env.BABY_VERIFICATION_DATA_KEY)
		if (raw.byteLength !== 32) throw new Error('length')
		return await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
	} catch { throw new BabyVerificationError('private_data_key_unavailable', '宝宝认证私密数据密钥不可用', 503) }
}

async function encryptPrivateText(env: Env, value: string, applicationId: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12))
	const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`qq:${applicationId}`) }, await dataKey(env), new TextEncoder().encode(value))
	return `${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...new Uint8Array(encrypted)))}`
}

/** Decrypt QQ only for the owner/admin private detail response. */
export async function decryptBabyQq(env: Env, encrypted: string, applicationId: string): Promise<string> {
	try {
		const [ivText, bodyText] = encrypted.split('.')
		const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode64(ivText), additionalData: new TextEncoder().encode(`qq:${applicationId}`) }, await dataKey(env), decode64(bodyText))
		return new TextDecoder().decode(clear)
	} catch (error) {
		if (error instanceof BabyVerificationError) throw error
		throw new BabyVerificationError('private_data_unavailable', '私密资料暂不可读取', 503)
	}
}

async function tokenKey(env: Env): Promise<CryptoKey> {
	if (!env.BABY_VERIFICATION_TOKEN_KEY) throw new BabyVerificationError('token_key_unavailable', '证书密钥不可用', 503)
	return crypto.subtle.importKey('raw', new TextEncoder().encode(env.BABY_VERIFICATION_TOKEN_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

/** Derive a 256-bit opaque credential token; only its domain-separated hash is persisted. */
export async function deriveBabyCredentialToken(env: Env, credentialId: string): Promise<string> {
	const bytes = await crypto.subtle.sign('HMAC', await tokenKey(env), new TextEncoder().encode(`abdl-space:baby-verification:credential:v1\0${credentialId}`))
	return encode64Url(new Uint8Array(bytes))
}

async function authenticate(c: Context<BabyVerificationAppType>, admin: boolean): Promise<void> {
	const cookie = c.req.header('cookie')?.match(/(?:^|;\s*)token=([^;]+)/)?.[1]
	const authorization = c.req.header('authorization') ?? (cookie ? `Bearer ${cookie}` : undefined)
	const auth = await mastodonAuthDetails({ env: c.env, req: { header: name => name.toLowerCase() === 'authorization' ? authorization : c.req.header(name) } })
	if (!auth || (auth.tokenType === 'jwt' && await assertSessionNotStale(auth.user, c.env.abdl_space_db))) throw new BabyVerificationError('unauthenticated', '请先登录', 401)
	const required = ['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) ? 'read' : 'write'
	if (auth.tokenType === 'oauth' && (!auth.scopes.includes(required) || (admin && !auth.scopes.includes('admin')))) throw new BabyVerificationError('insufficient_scope', '授权范围不足', 403)
	const current = await c.env.abdl_space_db.prepare('SELECT role FROM users WHERE id=?').bind(auth.user.sub).first<{ role: string }>()
	if (!current) throw new BabyVerificationError('unauthenticated', '请先登录', 401)
	if (admin && current.role !== 'admin') throw new BabyVerificationError('admin_required', '需要管理员权限', 403)
	c.set('user', { ...auth.user, role: current.role })
}

async function rateLimit(env: Env, bucket: string, limit: number, seconds = 60): Promise<void> {
	const row = await env.abdl_space_db.prepare(`INSERT INTO baby_verification_rate_limits(bucket,window_start,count) VALUES(?,unixepoch(),1)
		ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN window_start<=unixepoch()-? THEN 1 ELSE count+1 END,window_start=CASE WHEN window_start<=unixepoch()-? THEN unixepoch() ELSE window_start END RETURNING count`).bind(bucket, seconds, seconds).first<{ count: number }>()
	if (!row || row.count > limit) throw new BabyVerificationError('rate_limited', '操作过于频繁，请稍后重试', 429)
}

function assertWriteOrigin(c: Context<BabyVerificationAppType>): void {
	if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return
	if (c.req.header('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new BabyVerificationError('invalid_request', '写入请求必须使用 application/json', 400)
	const origin = c.req.header('origin')
	const hasCookie = !!c.req.header('cookie')
	const hasBearer = c.req.header('authorization')?.startsWith('Bearer ') === true
	const trusted = origin === new URL(c.req.url).origin || origin === c.env.FRONTEND_ORIGIN || ['https://abdl-space.top','https://www.abdl-space.top','https://m.abdl-space.top','https://abdl-space-mobile.pages.dev','http://localhost:5173','http://localhost:5174'].includes(origin ?? '')
	if (c.req.header('sec-fetch-site') === 'cross-site' || (origin ? !trusted : hasCookie || !hasBearer)) throw new BabyVerificationError('origin_forbidden', '请求来源验证失败', 403)
}

/** Authentication, CSRF checks, no-store and persistent rate limits for user APIs. */
export async function babyAuthMiddleware(c: Context<BabyVerificationAppType>, next: Next): Promise<Response | void> {
	try { c.header('Cache-Control', 'private, no-store'); await authenticate(c, false); assertWriteOrigin(c); await rateLimit(c.env, `user:${c.get('user').sub}`, 180); await next() }
	catch (error) { return babyVerificationErrorResponse(error, c) }
}

/** Authentication, current-role checks and persistent rate limits for admin APIs. */
export async function babyAdminMiddleware(c: Context<BabyVerificationAppType>, next: Next): Promise<Response | void> {
	try { c.header('Cache-Control', 'private, no-store'); await authenticate(c, true); assertWriteOrigin(c); await rateLimit(c.env, `admin:${c.get('user').sub}`, c.req.method === 'GET' ? 240 : 90); await next() }
	catch (error) { return babyVerificationErrorResponse(error, c) }
}

interface ApplicationRow { id: string; user_id: number; capture_session_id: string; status: string; qq: string; adult_declaration: number; declaration_version: string; declared_at: number; submitted_at: number | null; claimed_by: number | null; claimed_at: number | null; decided_by: number | null; decided_at: number | null; decision_note: string; rejection_acknowledged_at: number | null; cancelled_at: number | null; created_at: number; updated_at: number }

/** Read a private application owned by one user. */
export async function getBabyApplication(env: Env, applicationId: string, ownerId?: number): Promise<ApplicationRow | null> {
	const sql = `SELECT id,user_id,capture_session_id,status,qq,adult_declaration,declaration_version,declared_at,submitted_at,claimed_by,claimed_at,decided_by,decided_at,decision_note,rejection_acknowledged_at,cancelled_at,created_at,updated_at FROM baby_verification_applications WHERE id=?${ownerId === undefined ? '' : ' AND user_id=?'}`
	return env.abdl_space_db.prepare(sql).bind(...(ownerId === undefined ? [applicationId] : [applicationId, ownerId])).first<ApplicationRow>()
}

/** Return the authenticated user's feature state and current sponsor-derived monthly quota. */
export async function getBabyVerificationMe(env: Env, userId: number): Promise<BabyVerificationMe> {
	const config = await getBabyVerificationConfig(env)
	const state = await env.abdl_space_db.prepare(`SELECT EXISTS(SELECT 1 FROM sponsor_user_state WHERE user_id=? AND active=1) AS sponsor_active,
		(SELECT COUNT(*) FROM baby_verification_applications WHERE user_id=? AND submitted_at>=unixepoch('now','start of month')) AS used`).bind(userId, userId).first<{ sponsor_active: number; used: number }>()
	const limit = state?.sponsor_active ? config.sponsor_monthly_limit : config.free_monthly_limit
	const application = await env.abdl_space_db.prepare(`SELECT id,status,submitted_at,decision_note,rejection_acknowledged_at,created_at,updated_at FROM baby_verification_applications WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 1`).bind(userId).first<Record<string, unknown>>()
	return { config, quota: { limit, used: state?.used ?? 0, remaining: Math.max(0, limit - (state?.used ?? 0)), sponsor_active: !!state?.sponsor_active }, application: application ?? null }
}

/** Create a short-lived certification capture session. */
export async function createBabyCaptureSession(env: Env, userId: number): Promise<Record<string, unknown>> {
	const config = await getBabyVerificationConfig(env)
	if (!config.enabled) throw new BabyVerificationError('feature_disabled', '宝宝认证暂未开放', 503)
	const id = crypto.randomUUID()
	const nonce = encode64Url(crypto.getRandomValues(new Uint8Array(18)))
	const choose = <T>(items: readonly T[]): T => items[crypto.getRandomValues(new Uint32Array(1))[0] % items.length]
	const paperShape = choose(['正方形','三角形','圆形','长方形'] as const)
	const paperColor = choose(['白色纸张','浅黄色纸张','浅蓝色纸张','浅粉色纸张'] as const)
	const foldInstruction = choose(['无需折角','折起左上角','折起右上角'] as const)
	const placementInstruction = choose(['纸条压住纸尿裤左上角','纸条放在纸尿裤正中间','纸条紧贴纸尿裤右侧'] as const)
	const words = ['今日认证','真实拍摄','宝宝同行','安心相伴','星光作证','此刻留证'] as const
	const randomText = `${choose(words)}-${encode64Url(crypto.getRandomValues(new Uint8Array(4))).slice(0,6)}`
	const expiresAt = Math.floor(Date.now() / 1000) + config.capture_ttl_seconds
	await env.abdl_space_db.prepare(`INSERT INTO baby_verification_capture_sessions(id,user_id,status,nonce,instructions_version,paper_shape,paper_color,fold_instruction,placement_instruction,random_text,expires_at) VALUES(?,?,'active',?,1,?,?,?,?,?,?)`).bind(id, userId, nonce, paperShape, paperColor, foldInstruction, placementInstruction, randomText, expiresAt).run()
	return { id, status: 'active', nonce, instructions_version: 1, paper_shape: paperShape, paper_color: paperColor, fold_instruction: foldInstruction, placement_instruction: placementInstruction, random_text: randomText, expires_at: expiresAt }
}

/** Complete or cancel a capture session with a conditional state transition. */
export async function transitionBabyCaptureSession(env: Env, userId: number, id: string, action: 'complete' | 'cancel'): Promise<Record<string, unknown>> {
	const next = action === 'complete' ? 'completed' : 'cancelled'
	await env.abdl_space_db.prepare(`UPDATE baby_verification_capture_sessions SET status='expired',cancelled_at=unixepoch() WHERE id=? AND user_id=? AND status='active' AND expires_at<=unixepoch()`).bind(id,userId).run()
	const result = await env.abdl_space_db.prepare(`UPDATE baby_verification_capture_sessions SET status=?,completed_at=CASE WHEN ?='completed' THEN unixepoch() ELSE NULL END,cancelled_at=CASE WHEN ?='cancelled' THEN unixepoch() ELSE NULL END WHERE id=? AND user_id=? AND status='active' AND expires_at>unixepoch()`).bind(next, next, next, id, userId).run()
	const row = await env.abdl_space_db.prepare('SELECT id,status,nonce,instructions_version,paper_shape,paper_color,fold_instruction,placement_instruction,random_text,expires_at,completed_at,cancelled_at FROM baby_verification_capture_sessions WHERE id=? AND user_id=?').bind(id, userId).first<Record<string, unknown>>()
	if (!row) throw new BabyVerificationError('capture_session_not_found', '认证拍摄会话不存在', 404)
	if (result.meta.changes !== 1 && row.status !== next) throw new BabyVerificationError(row.expires_at && Number(row.expires_at) <= Math.floor(Date.now() / 1000) ? 'capture_session_expired' : 'capture_session_conflict', '认证拍摄会话不可用', 409)
	return row
}

/** Create a private draft from a completed capture session and an explicit adult declaration. */
export async function createBabyApplication(env: Env, userId: number, value: unknown): Promise<Record<string, unknown>> {
	const input = babyObject(value)
	if (input.adult_declaration !== true) throw new BabyVerificationError('adult_declaration_required', '必须确认成年声明', 422)
	const config = await getBabyVerificationConfig(env)
	if (!config.enabled) throw new BabyVerificationError('feature_disabled', '宝宝认证暂未开放', 503)
	if (input.declaration_version !== config.declaration_version) throw new BabyVerificationError('declaration_version_changed', '声明版本已更新，请重新确认', 409, { declaration_version: config.declaration_version })
	const sessionId = babyText(input.capture_session_id, '认证拍摄会话', 64)
	const qq = babyText(input.qq, 'QQ', 20)
	if (!/^\d{5,20}$/.test(qq)) throw new BabyVerificationError('invalid_qq', 'QQ 格式不正确', 422)
	const id = crypto.randomUUID()
	const encryptedQq = await encryptPrivateText(env, qq, id)
	const now = Math.floor(Date.now() / 1000)
	const result = await env.abdl_space_db.prepare(`INSERT INTO baby_verification_applications(id,user_id,capture_session_id,status,qq,adult_declaration,declaration_version,declared_at,created_at,updated_at)
		SELECT ?,?,s.id,'draft',?,1,?,?,?,? FROM baby_verification_capture_sessions s WHERE s.id=? AND s.user_id=? AND s.status='completed' AND s.expires_at>?
		AND NOT EXISTS(SELECT 1 FROM baby_verification_applications WHERE user_id=? AND status IN ('submitted','reviewing')) ON CONFLICT(capture_session_id) DO NOTHING`).bind(id,userId,encryptedQq,config.declaration_version,now,now,now,sessionId,userId,now,userId).run()
	if (result.meta.changes !== 1) {
		const existing = await env.abdl_space_db.prepare('SELECT id,status FROM baby_verification_applications WHERE capture_session_id=? AND user_id=?').bind(sessionId,userId).first<Record<string, unknown>>()
		if (existing) return existing
		throw new BabyVerificationError('application_conflict', '认证拍摄会话不可用或已有待审核申请', 409)
	}
	return { id, status: 'draft', adult_declaration: true, declaration_version: config.declaration_version, declared_at: now }
}

/** Cancel a user's draft or submitted application idempotently. */
export async function cancelBabyApplication(env: Env, userId: number, id: string): Promise<Record<string, unknown>> {
	await env.abdl_space_db.prepare(`UPDATE baby_verification_applications SET status='cancelled',cancelled_at=unixepoch(),updated_at=unixepoch() WHERE id=? AND user_id=? AND status IN ('draft','submitted')`).bind(id,userId).run()
	const row = await getBabyApplication(env,id,userId)
	if (!row) throw new BabyVerificationError('application_not_found','申请不存在',404)
	if (row.status !== 'cancelled') throw new BabyVerificationError('application_conflict','当前申请无法取消',409)
	return { id, status: row.status, cancelled_at: row.cancelled_at }
}

const EVIDENCE_MIMES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const

/** Bind a private no-overwrite COS PUT authorization to an owned draft and exact integrity metadata. */
export async function authorizeBabyEvidence(env: Env, userId: number, applicationId: string, value: unknown): Promise<Record<string, unknown>> {
	const input = babyObject(value)
	if (Object.hasOwn(input,'object_key')) throw new BabyVerificationError('invalid_request','客户端不能指定 object key',400)
	const config = await getBabyVerificationConfig(env)
	const kind = input.kind
	if (kind !== 'capture_photo' && kind !== 'supporting_photo') throw new BabyVerificationError('invalid_evidence_kind','照片类型不正确',422)
	const mimeType = typeof input.mime_type === 'string' ? input.mime_type.trim().toLowerCase() : ''
	const extension = EVIDENCE_MIMES[mimeType as keyof typeof EVIDENCE_MIMES]
	const size = integer(input.declared_size,1,config.max_evidence_size,'照片大小')
	const sha256 = babyText(input.content_sha256,'SHA-256',64).toLowerCase()
	const md5 = babyText(input.content_md5,'MD5',64)
	if (!extension || !/^[a-f0-9]{64}$/.test(sha256) || !isCanonicalContentMd5(md5)) throw new BabyVerificationError('invalid_evidence','照片元数据不正确',422)
	const application = await getBabyApplication(env,applicationId,userId)
	if (!application) throw new BabyVerificationError('application_not_found','申请不存在',404)
	if (application.status !== 'draft') throw new BabyVerificationError('application_conflict','仅草稿申请可上传照片',409)
	const existing = await env.abdl_space_db.prepare('SELECT id,kind,mime_type,declared_size,content_sha256,content_md5,status,object_key FROM baby_verification_evidence WHERE application_id=? AND kind=?').bind(applicationId,kind).first<Record<string, unknown>>()
	if (existing && (existing.mime_type !== mimeType || existing.declared_size !== size || existing.content_sha256 !== sha256 || existing.content_md5 !== md5)) throw new BabyVerificationError('evidence_conflict','照片元数据与现有上传不一致',409)
	if (existing?.status === 'ready') return { evidence_id: existing.id, status: 'ready', already_uploaded: true }
	const id = existing ? String(existing.id) : crypto.randomUUID()
	const objectKey = existing ? String(existing.object_key) : `baby-verification/private/${userId}/${applicationId}/${id}.${extension}`
	const authorization = await createCosPutAuthorization({ ...cosOptions(env), objectKey, contentType: mimeType, metadataSha256: sha256, contentLength: size, contentMd5: md5, expiresInSeconds: config.upload_ttl_seconds })
	if (existing) await env.abdl_space_db.prepare(`UPDATE baby_verification_evidence SET upload_expires_at=? WHERE id=? AND user_id=? AND status='pending'`).bind(authorization.expiresAt,id,userId).run()
	else {
		const result = await env.abdl_space_db.prepare(`INSERT INTO baby_verification_evidence(id,application_id,user_id,kind,mime_type,object_key,declared_size,content_sha256,content_md5,status,upload_expires_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',?) ON CONFLICT(application_id,kind) DO NOTHING`).bind(id,applicationId,userId,kind,mimeType,objectKey,size,sha256,md5,authorization.expiresAt).run()
		if (result.meta.changes !== 1) throw new BabyVerificationError('evidence_conflict','照片上传并发冲突，请重试',409)
	}
	return { evidence_id:id,status:'pending',upload_url:authorization.url,expires_at:authorization.expiresAt,required_headers:authorization.headers }
}

/** Verify the private COS object MIME, length, SHA-256 and MD5-bound upload before marking it ready. */
export async function completeBabyEvidence(env: Env, userId: number, evidenceId: string): Promise<Record<string, unknown>> {
	const row = await env.abdl_space_db.prepare(`SELECT id,application_id,user_id,mime_type,object_key,declared_size,content_sha256,status,upload_expires_at,verification_token,verification_started_at,verified_size FROM baby_verification_evidence WHERE id=? AND user_id=?`).bind(evidenceId,userId).first<Record<string, unknown>>()
	if (!row) throw new BabyVerificationError('evidence_not_found','照片不存在',404)
	if (row.status === 'ready') return { id:evidenceId,status:'ready',verified_size:row.verified_size }
	if (Number(row.upload_expires_at) <= Math.floor(Date.now()/1000)) throw new BabyVerificationError('upload_expired','上传授权已过期',410)
	const token = encode64Url(crypto.getRandomValues(new Uint8Array(18)))
	const staleBefore = Math.floor(Date.now()/1000)-120
	const claim = await env.abdl_space_db.prepare(`UPDATE baby_verification_evidence SET status='verifying',verification_token=?,verification_started_at=unixepoch() WHERE id=? AND user_id=? AND (status='pending' OR (status='verifying' AND verification_started_at<=?))`).bind(token,evidenceId,userId,staleBefore).run()
	if (claim.meta.changes !== 1) throw new BabyVerificationError('evidence_verifying','照片正在校验',409)
	try {
		const options = { ...cosOptions(env), objectKey:String(row.object_key), contentType:String(row.mime_type) }
		const head = await headPrivateObjectFromCos(options)
		const headSize = Number(head.headers.get('content-length'))
		if (!Number.isSafeInteger(headSize) || headSize !== Number(row.declared_size) || head.headers.get('content-type')?.trim().toLowerCase() !== row.mime_type) throw new BabyVerificationError('evidence_mismatch','照片元数据校验失败',422)
		const object = await getPrivateObjectFromCos(options)
		const bytes = await object.arrayBuffer()
		if (bytes.byteLength !== Number(row.declared_size) || toHex(await crypto.subtle.digest('SHA-256',bytes)) !== row.content_sha256) throw new BabyVerificationError('evidence_mismatch','照片内容校验失败',422)
		const updated = await env.abdl_space_db.prepare(`UPDATE baby_verification_evidence SET status='ready',verified_size=?,completed_at=unixepoch(),verification_token=NULL,verification_started_at=NULL WHERE id=? AND user_id=? AND status='verifying' AND verification_token=?`).bind(bytes.byteLength,evidenceId,userId,token).run()
		if (updated.meta.changes !== 1) throw new BabyVerificationError('evidence_conflict','照片状态已变化',409)
		return { id:evidenceId,status:'ready',verified_size:bytes.byteLength }
	} catch (error) {
		await env.abdl_space_db.prepare(`UPDATE baby_verification_evidence SET status='pending',verification_token=NULL,verification_started_at=NULL WHERE id=? AND user_id=? AND status='verifying' AND verification_token=?`).bind(evidenceId,userId,token).run().catch(()=>undefined)
		if (error instanceof BabyVerificationError) throw error
		throw new BabyVerificationError('verification_unavailable','私有照片校验暂不可用',502)
	}
}

/** Submit exactly once and consume monthly quota only when the conditional transition succeeds. */
export async function submitBabyApplication(env: Env, userId: number, applicationId: string): Promise<Record<string, unknown>> {
	const config = await getBabyVerificationConfig(env)
	const state = await env.abdl_space_db.prepare('SELECT EXISTS(SELECT 1 FROM sponsor_user_state WHERE user_id=? AND active=1) AS active').bind(userId).first<{active:number}>()
	const limit = state?.active ? config.sponsor_monthly_limit : config.free_monthly_limit
	const now = Math.floor(Date.now()/1000)
	const result = await env.abdl_space_db.prepare(`UPDATE baby_verification_applications SET status='submitted',submitted_at=?,updated_at=? WHERE id=? AND user_id=? AND status='draft'
		AND EXISTS(SELECT 1 FROM baby_verification_evidence WHERE application_id=? AND kind='capture_photo' AND status='ready')
		AND NOT EXISTS(SELECT 1 FROM baby_verification_applications WHERE user_id=? AND status IN ('submitted','reviewing'))
		AND (SELECT COUNT(*) FROM baby_verification_applications WHERE user_id=? AND submitted_at>=unixepoch('now','start of month'))<?`).bind(now,now,applicationId,userId,applicationId,userId,userId,limit).run()
	const row = await getBabyApplication(env,applicationId,userId)
	if (!row) throw new BabyVerificationError('application_not_found','申请不存在',404)
	if (result.meta.changes !== 1) {
		if (row.status === 'submitted' || row.status === 'reviewing') return { id:row.id,status:row.status,submitted_at:row.submitted_at,replayed:true }
		const me = await getBabyVerificationMe(env,userId)
		if (me.quota.remaining === 0) throw new BabyVerificationError('quota_exhausted','本月宝宝认证申请额度已用完',429,{quota:me.quota})
		throw new BabyVerificationError('application_incomplete','请先完成认证拍摄照片上传，或已有待审核申请',409)
	}
	return { id:applicationId,status:'submitted',submitted_at:now,replayed:false }
}

/** Persist rejection acknowledgement without changing review history. */
export async function acknowledgeBabyRejection(env: Env, userId: number, applicationId: string): Promise<Record<string, unknown>> {
	await env.abdl_space_db.prepare(`UPDATE baby_verification_applications SET rejection_acknowledged_at=COALESCE(rejection_acknowledged_at,unixepoch()),updated_at=unixepoch() WHERE id=? AND user_id=? AND status='rejected'`).bind(applicationId,userId).run()
	const row = await getBabyApplication(env,applicationId,userId)
	if (!row) throw new BabyVerificationError('application_not_found','申请不存在',404)
	if (row.status !== 'rejected') throw new BabyVerificationError('application_conflict','申请尚未被拒绝',409)
	return { id:applicationId,status:row.status,rejection_acknowledged_at:row.rejection_acknowledged_at }
}

/** Return a private certificate and reproducible current QR token to its owner. */
export async function getBabyCertificateMe(env: Env, userId: number): Promise<Record<string, unknown> | null> {
	const row = await env.abdl_space_db.prepare(`SELECT c.id,c.status,c.issued_at,c.revoked_at,c.current_credential_id,g.generation FROM baby_verification_certificates c LEFT JOIN baby_verification_credentials g ON g.id=c.current_credential_id WHERE c.user_id=? ORDER BY c.created_at DESC LIMIT 1`).bind(userId).first<Record<string, unknown>>()
	if (!row) return null
	const token = row.current_credential_id ? await deriveBabyCredentialToken(env,String(row.current_credential_id)) : null
	return { ...row, verification_token:token, verify_path:token ? `/api/v1/baby-verification/verify/${token}` : null }
}

/** Return the minimal public certificate projection used by profile account entities. */
export async function getPublicBabyVerification(env: Env, userId: number): Promise<{verified:boolean;certificate_url:string|null}|null> {
	const row=await env.abdl_space_db.prepare(`SELECT c.current_credential_id FROM baby_verification_certificates c WHERE c.user_id=? AND c.status='active' ORDER BY c.issued_at DESC LIMIT 1`).bind(userId).first<{current_credential_id:string|null}>()
	if(!row?.current_credential_id)return null
	const token=await deriveBabyCredentialToken(env,row.current_credential_id)
	return {verified:true,certificate_url:`https://abdl-space.top/c/${token}`}
}

/** Verify a public token while distinguishing active, superseded, revoked and unknown credentials. */
export async function verifyBabyCredential(env: Env, token: string): Promise<Record<string, unknown>> {
	if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { valid:false,status:'unknown' }
	const hash = await babyHash('public-credential:v1',token)
	const row = await env.abdl_space_db.prepare(`SELECT g.status AS credential_status,g.generation,g.issued_at,c.status AS certificate_status,c.issued_at AS certificate_issued_at,u.username FROM baby_verification_credentials g JOIN baby_verification_certificates c ON c.id=g.certificate_id JOIN users u ON u.id=c.user_id WHERE g.token_hash=?`).bind(hash).first<Record<string, unknown>>()
	if (!row) return { valid:false,status:'unknown' }
	if (row.credential_status === 'superseded') return { valid:false,status:'superseded',superseded:true }
	if (row.credential_status === 'revoked' || row.certificate_status === 'revoked') return { valid:false,status:'revoked' }
	return { valid:true,status:'active',username:row.username,issued_at:row.certificate_issued_at,generation:row.generation }
}

interface OperationReplay { status: number; body: string }
/** Read or reject reuse of an admin idempotency operation. */
export async function replayBabyOperation(env: Env, actorId: number, operationId: string, action: string, targetId: string, requestHash: string): Promise<OperationReplay | null> {
	const row = await env.abdl_space_db.prepare('SELECT action,target_id,request_hash,response_status,response_body FROM baby_verification_operations WHERE actor_id=? AND operation_id=?').bind(actorId,operationId).first<{action:string;target_id:string;request_hash:string;response_status:number;response_body:string}>()
	if (!row) return null
	if (row.action!==action || row.target_id!==targetId || row.request_hash!==requestHash) throw new BabyVerificationError('idempotency_conflict','operation_id 已用于不同请求',409)
	return {status:row.response_status,body:row.response_body}
}

/** Atomically claim an unclaimed submitted application. */
export async function claimBabyApplication(env: Env, adminId: number, applicationId: string): Promise<Record<string, unknown>> {
	const now=Math.floor(Date.now()/1000)
	const result=await env.abdl_space_db.prepare(`UPDATE baby_verification_applications SET status='reviewing',claimed_by=?,claimed_at=?,updated_at=? WHERE id=? AND status='submitted' AND claimed_by IS NULL`).bind(adminId,now,now,applicationId).run()
	const row=await getBabyApplication(env,applicationId)
	if(!row) throw new BabyVerificationError('application_not_found','申请不存在',404)
	if(result.meta.changes!==1 && !(row.status==='reviewing'&&row.claimed_by===adminId)) throw new BabyVerificationError('application_claimed','申请已被领取或处理',409)
	return {id:applicationId,status:'reviewing',claimed_by:row.claimed_by,claimed_at:row.claimed_at}
}

/** Release only an application currently claimed by this administrator. */
export async function releaseBabyApplication(env: Env, adminId: number, applicationId: string): Promise<Record<string, unknown>> {
	const result=await env.abdl_space_db.prepare(`UPDATE baby_verification_applications SET status='submitted',claimed_by=NULL,claimed_at=NULL,updated_at=unixepoch() WHERE id=? AND status='reviewing' AND claimed_by=?`).bind(applicationId,adminId).run()
	if(result.meta.changes!==1) throw new BabyVerificationError('application_not_claimed','申请未由当前管理员领取',409)
	return {id:applicationId,status:'submitted'}
}

/** Decide a claimed application; approval atomically issues certificate, credential, verified badge, notification and audit. */
export async function decideBabyApplication(env: Env, adminId: number, applicationId: string, value: unknown): Promise<{body:Record<string,unknown>;notification:Promise<void>|null}> {
	const input=babyObject(value)
	const decision=input.decision
	if(decision!=='approve'&&decision!=='reject') throw new BabyVerificationError('invalid_decision','审核决定不正确',422)
	const note=babyText(input.note??'', '审核备注',1000,true)
	if(decision==='reject'&&!note) throw new BabyVerificationError('invalid_decision','拒绝时必须填写原因',422)
	const operationId=babyOperationId(input.operation_id)
	const requestHash=await babyHash('operation',JSON.stringify([decision,note]))
	const replay=await replayBabyOperation(env,adminId,operationId,`decision:${decision}`,applicationId,requestHash)
	if(replay) {
		const stored=JSON.parse(replay.body) as Record<string,unknown>
		const replayCredentialId=typeof stored.credential_id==='string'?stored.credential_id:null
		const replayToken=replayCredentialId?await deriveBabyCredentialToken(env,replayCredentialId):null
		delete stored.credential_id
		return {body:{...stored,...(replayToken?{verification_token:replayToken,verify_path:`/api/v1/baby-verification/verify/${replayToken}`}:{})},notification:null}
	}
	const application=await getBabyApplication(env,applicationId)
	if(!application) throw new BabyVerificationError('application_not_found','申请不存在',404)
	if(application.status!=='reviewing'||application.claimed_by!==adminId) throw new BabyVerificationError('application_not_claimed','申请必须由当前管理员领取',409)
	const now=Math.floor(Date.now()/1000)
	const status=decision==='approve'?'approved':'rejected'
	const certificateId=crypto.randomUUID(); const credentialId=encode64Url(crypto.getRandomValues(new Uint8Array(32)))
	const token=decision==='approve'?await deriveBabyCredentialToken(env,credentialId):null
	const tokenHash=token?await babyHash('public-credential:v1',token):null
	const body:Record<string,unknown>={id:applicationId,status,decided_at:now,...(token?{certificate_id:certificateId,verification_token:token,verify_path:`/api/v1/baby-verification/verify/${token}`}:{})}
	const replayBody={id:applicationId,status,decided_at:now,...(token?{certificate_id:certificateId,credential_id:credentialId}:{})}
	const bodyText=JSON.stringify(replayBody)
		const statements:D1PreparedStatement[]=[
			env.abdl_space_db.prepare(`UPDATE baby_verification_applications SET status=?,decided_by=?,decided_at=?,decision_note=?,updated_at=? WHERE id=? AND status='reviewing' AND claimed_by=?`).bind(status,adminId,now,note,now,applicationId,adminId),
			env.abdl_space_db.prepare(`INSERT INTO baby_verification_transaction_guards(id) SELECT CASE WHEN changes()=1 THEN 1 ELSE 0 END ON CONFLICT(id) DO UPDATE SET id=excluded.id`),
		]
	if(decision==='approve') statements.push(
		env.abdl_space_db.prepare(`INSERT INTO baby_verification_certificates(id,user_id,application_id,status,issued_at,current_credential_id,credential_generation) SELECT ?,user_id,id,'active',?,?,1 FROM baby_verification_applications WHERE id=? AND status='approved' AND decided_by=? AND decided_at=?`).bind(certificateId,now,credentialId,applicationId,adminId,now),
		env.abdl_space_db.prepare(`INSERT INTO baby_verification_credentials(id,certificate_id,generation,token_hash,status,issued_at) SELECT ?,?,1,?,'active',? WHERE EXISTS(SELECT 1 FROM baby_verification_certificates WHERE id=?)`).bind(credentialId,certificateId,tokenHash,now,certificateId),
			env.abdl_space_db.prepare(`INSERT INTO baby_verification_badge_sources(certificate_id,user_id,badge_key,preserved_existing_badge) SELECT ?,user_id,'verified',EXISTS(SELECT 1 FROM user_badges WHERE user_id=baby_verification_applications.user_id AND badge_key='verified') FROM baby_verification_applications WHERE id=?`).bind(certificateId,applicationId),
			env.abdl_space_db.prepare(`INSERT INTO user_badges(user_id,badge_key,unlocked_at,displayed,acknowledged_at) SELECT user_id,'verified',CURRENT_TIMESTAMP,0,NULL FROM baby_verification_applications WHERE id=? ON CONFLICT(user_id,badge_key) DO UPDATE SET acknowledged_at=NULL`).bind(applicationId),
	)
		statements.push(
			env.abdl_space_db.prepare(`INSERT INTO notifications(user_id,type,message,related_id,read) SELECT user_id,'baby_verification',?,NULL,0 FROM baby_verification_applications WHERE id=?`).bind(decision==='approve'?'宝宝认证已通过':'宝宝认证未通过，请查看原因',applicationId),
			env.abdl_space_db.prepare(`INSERT INTO baby_verification_notification_details(notification_id,application_id,target_path,metadata_json) VALUES(last_insert_rowid(),?,'/settings/baby-verification',?)`).bind(applicationId,JSON.stringify({application_id:applicationId,status})),
			env.abdl_space_db.prepare(`INSERT INTO baby_verification_audit(id,actor_id,user_id,application_id,action,reason,metadata_json) SELECT ?,?,user_id,id,?,?,? FROM baby_verification_applications WHERE id=?`).bind(crypto.randomUUID(),adminId,`application_${status}`,note,JSON.stringify({decision}),applicationId),
		env.abdl_space_db.prepare(`INSERT INTO baby_verification_operations(actor_id,operation_id,action,target_id,request_hash,response_status,response_body) VALUES(?,?,?,?,?,200,?)`).bind(adminId,operationId,`decision:${decision}`,applicationId,requestHash,bodyText),
	)
	let results:D1Result[]
	try { results=await env.abdl_space_db.batch(statements) }
	catch { throw new BabyVerificationError('application_changed','申请状态已变化',409) }
	if(results[0].meta.changes!==1) throw new BabyVerificationError('application_changed','申请状态已变化',409)
	const notification=env.JPUSH_APP_KEY&&env.JPUSH_MASTER_SECRET?import('./jpush.ts').then(({sendJPushNotification})=>sendJPushNotification(env,application.user_id,'宝宝认证',decision==='approve'?'宝宝认证已通过':'宝宝认证未通过',{type:'baby_verification',target_path:'/settings/baby-verification',application_id:applicationId})):null
	return {body,notification}
}

/** Authorize a short-lived private evidence GET for the claimed application's administrator. */
export async function authorizeAdminBabyEvidence(env: Env, adminId: number, applicationId: string, evidenceId: string): Promise<Record<string,unknown>> {
	const row=await env.abdl_space_db.prepare(`SELECT e.object_key,e.mime_type,e.status FROM baby_verification_evidence e JOIN baby_verification_applications a ON a.id=e.application_id WHERE e.id=? AND e.application_id=? AND a.status='reviewing' AND a.claimed_by=?`).bind(evidenceId,applicationId,adminId).first<Record<string,unknown>>()
	if(!row||row.status!=='ready') throw new BabyVerificationError('evidence_not_found','照片不存在或不可查看',404)
	const config=await getBabyVerificationConfig(env)
	const authorization=await createCosGetAuthorization({...cosOptions(env),objectKey:String(row.object_key),contentType:String(row.mime_type),expiresInSeconds:config.upload_ttl_seconds})
	return {download_url:authorization.url,expires_at:authorization.expiresAt}
}

/** Revoke or reissue a certificate with immutable old credential status. */
export async function mutateBabyCertificate(env: Env, adminId: number, certificateId: string, action:'revoke'|'reissue', value:unknown): Promise<Record<string,unknown>> {
	const input=babyObject(value); const reason=babyText(input.reason,'原因',500); const operationId=babyOperationId(input.operation_id)
	const requestHash=await babyHash('operation',JSON.stringify([action,reason])); const replay=await replayBabyOperation(env,adminId,operationId,action,certificateId,requestHash)
	if(replay){
		const stored=JSON.parse(replay.body) as Record<string,unknown>
		const replayCredentialId=typeof stored.credential_id==='string'?stored.credential_id:null
		const replayToken=replayCredentialId?await deriveBabyCredentialToken(env,replayCredentialId):null
		delete stored.credential_id
		return {...stored,...(replayToken?{verification_token:replayToken,verify_path:`/api/v1/baby-verification/verify/${replayToken}`}:{})}
	}
	const certificate=await env.abdl_space_db.prepare('SELECT id,user_id,status,current_credential_id FROM baby_verification_certificates WHERE id=?').bind(certificateId).first<{id:string;user_id:number;status:string;current_credential_id:string|null}>()
	if(!certificate)throw new BabyVerificationError('certificate_not_found','证书不存在',404)
	const now=Math.floor(Date.now()/1000)
	if(action==='revoke'){
		if(certificate.status!=='active')throw new BabyVerificationError('certificate_conflict','证书已吊销',409)
		const body={id:certificateId,status:'revoked',revoked_at:now}; const text=JSON.stringify(body)
		let results:D1Result[]
		try { results=await env.abdl_space_db.batch([
			env.abdl_space_db.prepare(`UPDATE baby_verification_certificates SET status='revoked',revoked_at=?,revoked_by=?,revoke_reason=? WHERE id=? AND status='active'`).bind(now,adminId,reason,certificateId),
			env.abdl_space_db.prepare(`INSERT INTO baby_verification_transaction_guards(id) SELECT CASE WHEN changes()=1 THEN 1 ELSE 0 END ON CONFLICT(id) DO UPDATE SET id=excluded.id`),
				env.abdl_space_db.prepare(`UPDATE baby_verification_credentials SET status='revoked',revoked_at=? WHERE certificate_id=? AND status='active'`).bind(now,certificateId),
				env.abdl_space_db.prepare(`UPDATE baby_verification_badge_sources SET revoked_at=? WHERE certificate_id=? AND revoked_at IS NULL`).bind(now,certificateId),
				env.abdl_space_db.prepare(`DELETE FROM user_badges WHERE user_id=? AND badge_key='verified' AND EXISTS(SELECT 1 FROM baby_verification_badge_sources WHERE certificate_id=? AND preserved_existing_badge=0) AND NOT EXISTS(SELECT 1 FROM baby_verification_badge_sources WHERE user_id=? AND badge_key='verified' AND revoked_at IS NULL)`).bind(certificate.user_id,certificateId,certificate.user_id),
				env.abdl_space_db.prepare(`INSERT INTO notifications(user_id,type,message,related_id,read) VALUES(?,'baby_verification','宝宝认证证书已吊销',NULL,0)`).bind(certificate.user_id),
				env.abdl_space_db.prepare(`INSERT INTO baby_verification_notification_details(notification_id,application_id,target_path,metadata_json) SELECT last_insert_rowid(),application_id,'/settings/baby-verification',? FROM baby_verification_certificates WHERE id=?`).bind(JSON.stringify({certificate_id:certificateId,status:'revoked'}),certificateId),
				env.abdl_space_db.prepare(`INSERT INTO baby_verification_audit(id,actor_id,user_id,application_id,action,reason) SELECT ?,?,user_id,application_id,'certificate_revoke',? FROM baby_verification_certificates WHERE id=?`).bind(crypto.randomUUID(),adminId,reason,certificateId),
			env.abdl_space_db.prepare(`INSERT INTO baby_verification_operations(actor_id,operation_id,action,target_id,request_hash,response_status,response_body) VALUES(?,?,?,?,?,200,?)`).bind(adminId,operationId,action,certificateId,requestHash,text),
		]) } catch { throw new BabyVerificationError('certificate_conflict','证书状态已变化',409) }
		if(results[0].meta.changes!==1)throw new BabyVerificationError('certificate_conflict','证书状态已变化',409); return body
	}
	if(certificate.status!=='active'||!certificate.current_credential_id)throw new BabyVerificationError('certificate_conflict','仅有效证书可补发',409)
	const credentialId=encode64Url(crypto.getRandomValues(new Uint8Array(32))); const token=await deriveBabyCredentialToken(env,credentialId); const hash=await babyHash('public-credential:v1',token)
	const generation=(await env.abdl_space_db.prepare(`SELECT credential_generation+1 AS generation FROM baby_verification_certificates WHERE id=? AND status='active' AND current_credential_id=?`).bind(certificateId,certificate.current_credential_id).first<{generation:number}>())?.generation
	if(!generation)throw new BabyVerificationError('certificate_conflict','证书状态已变化',409)
	const body={id:certificateId,status:'active',generation,verification_token:token,verify_path:`/api/v1/baby-verification/verify/${token}`};const text=JSON.stringify({id:certificateId,status:'active',generation,credential_id:credentialId})
	let results:D1Result[]
	try { results=await env.abdl_space_db.batch([
		env.abdl_space_db.prepare(`UPDATE baby_verification_certificates SET current_credential_id=?,credential_generation=credential_generation+1 WHERE id=? AND status='active' AND current_credential_id=? AND credential_generation=?`).bind(credentialId,certificateId,certificate.current_credential_id,generation-1),
		env.abdl_space_db.prepare(`INSERT INTO baby_verification_transaction_guards(id) SELECT CASE WHEN changes()=1 THEN 1 ELSE 0 END ON CONFLICT(id) DO UPDATE SET id=excluded.id`),
		env.abdl_space_db.prepare(`UPDATE baby_verification_credentials SET status='superseded',superseded_at=? WHERE id=? AND certificate_id=? AND status='active'`).bind(now,certificate.current_credential_id,certificateId),
		env.abdl_space_db.prepare(`INSERT INTO baby_verification_credentials(id,certificate_id,generation,token_hash,status,issued_at) VALUES(?,?,?,?,'active',?)`).bind(credentialId,certificateId,generation,hash,now),
		env.abdl_space_db.prepare(`INSERT INTO notifications(user_id,type,message,related_id,read) VALUES(?,'baby_verification','宝宝认证证书已补发，请更新二维码',NULL,0)`).bind(certificate.user_id),
		env.abdl_space_db.prepare(`INSERT INTO baby_verification_notification_details(notification_id,application_id,target_path,metadata_json) SELECT last_insert_rowid(),application_id,'/settings/baby-verification',? FROM baby_verification_certificates WHERE id=?`).bind(JSON.stringify({certificate_id:certificateId,status:'reissued',generation}),certificateId),
		env.abdl_space_db.prepare(`INSERT INTO baby_verification_audit(id,actor_id,user_id,application_id,action,reason) SELECT ?,?,user_id,application_id,'certificate_reissue',? FROM baby_verification_certificates WHERE id=?`).bind(crypto.randomUUID(),adminId,reason,certificateId),
		env.abdl_space_db.prepare(`INSERT INTO baby_verification_operations(actor_id,operation_id,action,target_id,request_hash,response_status,response_body) VALUES(?,?,?,?,?,200,?)`).bind(adminId,operationId,action,certificateId,requestHash,text),
	]) } catch { throw new BabyVerificationError('certificate_conflict','证书状态已变化',409) }
	if(results[0].meta.changes!==1)throw new BabyVerificationError('certificate_conflict','证书状态已变化',409);return body
}

/** Optimistically update the singleton config and audit the reason in one D1 batch. */
export async function updateBabyVerificationConfig(env: Env, adminId:number, value:unknown):Promise<BabyVerificationConfig>{
	const input=babyObject(value);const expected=integer(input.expected_version,1,2147483646,'期望版本');const reason=babyText(input.reason,'原因',500);const config=validateBabyVerificationConfig(input.config)
	if(config.version!==expected)throw new BabyVerificationError('version_conflict','配置版本不匹配',409)
	const updated={...config,version:expected+1};const results=await env.abdl_space_db.batch([
		env.abdl_space_db.prepare(`UPDATE baby_verification_settings SET version=version+1,enabled=?,declaration_version=?,free_monthly_limit=?,sponsor_monthly_limit=?,capture_ttl_seconds=?,upload_ttl_seconds=?,max_evidence_size=?,updated_at=unixepoch() WHERE id=1 AND version=?`).bind(Number(updated.enabled),updated.declaration_version,updated.free_monthly_limit,updated.sponsor_monthly_limit,updated.capture_ttl_seconds,updated.upload_ttl_seconds,updated.max_evidence_size,expected),
		env.abdl_space_db.prepare(`INSERT INTO baby_verification_audit(id,actor_id,action,reason,metadata_json) SELECT ?,?,'config_update',?,? WHERE changes()=1`).bind(crypto.randomUUID(),adminId,reason,JSON.stringify({version:updated.version})),
	]);if(results[0].meta.changes!==1)throw new BabyVerificationError('version_conflict','配置已被修改，请刷新',409);return updated
}
