import type { Context, Next } from 'hono'
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types'
import type { Env, JWTPayload } from '../types/index.ts'
import type { Album, AlbumBatchAuthorization, AlbumComment, AlbumCommentsResponse, AlbumInvite, AlbumListResponse, AlbumMembersResponse, AlbumPhotoAuthorization, AlbumPhotosResponse, AlbumPublishResponse, AlbumStorageTier, AlbumVisibility, Photo, StorageQuota } from '../types/albums.ts'
import { mastodonAuthDetails } from '../mastodon/shared.ts'
import { assertSponsorWriteOrigin, authorizeSponsorOriginal, getSponsorConfig, SponsorError, sponsorHash, sponsorOperationId } from './sponsors.ts'
import { CosHttpError, createCosGetAuthorization, createCosPutAuthorization, deleteObjectFromCos, getPrivateObjectFromCos, headPrivateObjectFromCos, isCanonicalContentMd5, md5Base64 } from './tencent-cos.ts'
import { inspectMediaImageDimensions } from './media-preview.ts'
import { invalidateFeedCount } from './post-count-cache.ts'

export type AlbumEnv = Pick<Env, 'COS_BUCKET' | 'COS_REGION' | 'COS_SECRET_ID' | 'COS_SECRET_KEY' | 'SPONSOR_CODE_KEY'> & { abdl_space_db: D1Database }
export type AlbumAppType = { Bindings: Env; Variables: { user: JWTPayload } }
type ErrorStatus = 400 | 401 | 402 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 502 | 503
const MIB = 1024 * 1024
const UPLOAD_TTL = 300
const BATCH_TTL = 3600
const READ_TTL = 60
const MIMES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'image/heif': 'heif' }
const DB_ERRORS: Record<string, [ErrorStatus, string]> = {
  default_album_immutable: [409, '默认相册不能修改或删除'], album_forbidden: [403, '没有相册操作权限'],
  album_pending_limit: [429, '最多可同时上传五个批次'], album_storage_full: [409, '相册存储空间不足'],
  album_sponsor_required: [403, '上传无损原图需要有效赞助者身份'], album_batch_expired: [409, '上传批次已过期或取消'],
  album_batch_incomplete: [409, '请先完成所有照片上传'], album_batch_invalid: [409, '上传批次无效'],
  album_upload_mismatch: [422, '上传对象校验失败'],
}

/** A stable album business error, never exposing SQL, private keys or signing credentials. */
export class AlbumError extends Error {
  readonly code: string
  readonly status: ErrorStatus
  constructor(code: string, message: string, status: ErrorStatus = 400) { super(message); this.code = code; this.status = status }
}

/** Map known trigger failures and sponsor notices to the common safe error envelope. */
export function albumErrorResponse(error: unknown, c: Context<AlbumAppType>): Response {
  c.header('Cache-Control', 'private, no-store')
  if (error instanceof SponsorError) return c.json({ error: error.message, code: error.code, ...error.details }, error.status)
  const safe = normalizeError(error)
  if (safe.code === 'albums_unavailable') console.error(JSON.stringify({ event: 'album_request_failed', method: c.req.method }))
  return c.json({ error: safe.message, code: safe.code }, safe.status)
}
function normalizeError(error: unknown): AlbumError {
  if (error instanceof AlbumError) return error
  const text = error instanceof Error ? error.message : ''
  const code = Object.keys(DB_ERRORS).find(key => new RegExp(`\\b${key}\\b`).test(text))
  if (code) return new AlbumError(code, DB_ERRORS[code][1], DB_ERRORS[code][0])
  return new AlbumError('albums_unavailable', '相册服务暂不可用，请稍后重试', 503)
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AlbumError('invalid_request', '请求格式不正确')
  return value as Record<string, unknown>
}
function allowedKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new AlbumError('invalid_request', '请求包含不支持的字段')
}
function text(value: unknown, maximum: number, allowEmpty = false): string {
  // eslint-disable-next-line no-control-regex -- album text accepts newlines but not hidden controls
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new AlbumError('invalid_request', '文本格式不正确')
  return value.trim()
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new AlbumError('invalid_request', '数值超出允许范围')
  return value
}
function captured(value: unknown): number | null { return value === null ? null : integer(value, 0, 253402300799) }
function visibility(value: unknown): AlbumVisibility {
  if (value !== 'public' && value !== 'private' && value !== 'shared') throw new AlbumError('invalid_request', '相册可见性不正确')
  return value
}
function id(value: string): string { return text(value, 80) }
function operation(value: unknown): string {
  try { return sponsorOperationId(value) } catch { throw new AlbumError('invalid_request', 'operation_id 必须为 UUID') }
}

/** Consume JSON with a strict byte ceiling before parsing, even without Content-Length. */
export async function readAlbumJson(request: Request): Promise<Record<string, unknown>> {
  const max = 64 * 1024
  const length = request.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > max)) throw new AlbumError('request_too_large', '请求内容过大', 413)
  const reader = request.body?.getReader()
  if (!reader) return {}
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let body = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > max) { await reader.cancel(); throw new AlbumError('request_too_large', '请求内容过大', 413) }
      body += decoder.decode(chunk.value, { stream: true })
    }
    return object(JSON.parse(body + decoder.decode()) as unknown)
  } catch (error) {
    if (error instanceof AlbumError) throw error
    throw new AlbumError('invalid_request', 'JSON 请求格式不正确')
  }
}

/** Selected-session JWT/OAuth auth with explicit method scope, live session and durable rate limits. */
export async function albumAuthMiddleware(c: Context<AlbumAppType>, next: Next): Promise<Response | void> {
  c.header('Cache-Control', 'private, no-store')
  c.header('Referrer-Policy', 'no-referrer')
  try {
    const cookie = c.req.header('cookie')?.match(/(?:^|;\s*)token=([^;]+)/)?.[1]
    const authorization = c.req.header('authorization') ?? (cookie ? `Bearer ${cookie}` : undefined)
    const auth = await mastodonAuthDetails({ env: c.env, req: { header: name => name.toLowerCase() === 'authorization' ? authorization : c.req.header(name) } })
    if (!auth) throw new AlbumError('unauthenticated', '请先登录', 401)
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)
    if (auth.tokenType === 'oauth' && !auth.scopes.includes(write ? 'write' : 'read')) throw new AlbumError('insufficient_scope', '授权范围不足', 403)
    c.set('user', auth.user)
    assertSponsorWriteOrigin(c)
    const sensitive = c.req.path.endsWith('/authorize') || c.req.path.endsWith('/invites') || c.req.path.endsWith('/join')
    const limit = sensitive ? 40 : write ? 120 : 240
    const row = await c.env.abdl_space_db.prepare(`INSERT INTO album_rate_limits(bucket,window_start,count) VALUES(?,unixepoch(),1)
      ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN window_start<=unixepoch()-60 THEN 1 ELSE count+1 END,window_start=CASE WHEN window_start<=unixepoch()-60 THEN unixepoch() ELSE window_start END RETURNING count`).bind(`user:${auth.user.sub}:${sensitive ? 'sensitive' : write ? 'write' : 'read'}`).first<{ count: number }>()
    if (!row || row.count > limit) throw new AlbumError('rate_limited', '操作过于频繁，请稍后重试', 429)
    await next()
  } catch (error) { return albumErrorResponse(error, c) }
}

/** Strict bounded offset pagination; invalid values never silently select another page. */
export function albumPagination(limit: string | undefined, offset: string | undefined, defaultLimit: number, max: number): { limit: number; offset: number } {
  const parse = (value: string | undefined, fallback: number, min: number, ceiling: number) => {
    if (value === undefined) return fallback
    if (!/^\d+$/.test(value)) throw new AlbumError('invalid_request', '分页参数不正确')
    return integer(Number(value), min, ceiling)
  }
  return { limit: parse(limit, defaultLimit, 1, max), offset: parse(offset, 0, 0, 100000) }
}

/** Server-internal album row, not a response projection. */
export interface AlbumRow { id: string; owner_id: number; name: string; visibility: AlbumVisibility; is_default: number; created_at: number; updated_at: number; deleted_at: number | null }
interface PhotoRow {
  id: string; album_id: string; batch_id: string; owner_id: number; client_id: string; description: string; captured_at: number | null
  uploaded_at: number; width: number; height: number; preview_key: string; hd_key: string; original_key: string | null
  preview_bytes: number; hd_bytes: number; original_bytes: number; deleted_at: number | null
}
interface PhotoProjectionRow extends PhotoRow { likes_count: number; comments_count: number; liked: number }
const PHOTO_PROJECTION = `p.*,(SELECT count(*) FROM album_likes WHERE photo_id=p.id) AS likes_count,
  (SELECT count(*) FROM album_comments WHERE photo_id=p.id AND deleted_at IS NULL) AS comments_count,
  EXISTS(SELECT 1 FROM album_likes WHERE photo_id=p.id AND user_id=?) AS liked`
interface BatchRow {
  id: string; album_id: string; owner_id: number; operation_id: string; request_hash: string; description: string; captured_at: number | null
  quality: 'hd' | 'original'; photo_count: number; reserved_bytes: number; status: string; post_id: number | null; expires_at: number
}
interface UploadRow {
  id: string; batch_id: string; album_id: string; owner_id: number; photo_id: string; client_id: string; kind: 'preview' | 'hd' | 'original'
  object_key: string; mime_type: string; declared_size: number; content_md5: string; width: number; height: number
  status: string; verified_size: number | null; expires_at: number; variant_width: number | null; variant_height: number | null
}
const ACL = `(a.owner_id=? OR a.visibility='public' OR (a.visibility='shared' AND EXISTS(SELECT 1 FROM album_members m WHERE m.album_id=a.id AND m.user_id=?)))`

function guard(env: AlbumEnv, sql: string, ...params: Array<string | number | null>): D1PreparedStatement {
  return env.abdl_space_db.prepare(`INSERT INTO album_transaction_guards(id) SELECT CASE WHEN (${sql}) THEN 1 ELSE 0 END ON CONFLICT(id) DO UPDATE SET id=excluded.id`).bind(...params)
}
async function atomic(env: AlbumEnv, statements: D1PreparedStatement[], conflictCode = 'album_conflict'): Promise<void> {
  try {
    const results = await env.abdl_space_db.batch(statements)
    if (results.some(result => !result.success)) throw new AlbumError('albums_unavailable', '数据库操作未成功', 503)
  } catch (error) {
    if (error instanceof SponsorError || error instanceof AlbumError) throw error
    const safe = normalizeError(error)
    if (safe.code !== 'albums_unavailable') throw safe
    if (error instanceof Error && /album_transaction_guards|CHECK constraint failed: id=1/.test(error.message)) throw new AlbumError(conflictCode, '权限或内容状态已变更，请刷新后重试', 409)
    throw error
  }
}
function ownerGuard(env: AlbumEnv, userId: number, albumId: string): D1PreparedStatement {
  return guard(env, `EXISTS(SELECT 1 FROM albums a JOIN users u ON u.id=a.owner_id WHERE a.id=? AND a.owner_id=? AND a.deleted_at IS NULL)`, albumId, userId)
}
function photoGuard(env: AlbumEnv, userId: number, photoId: string, original = false): D1PreparedStatement {
  return guard(env, `EXISTS(SELECT 1 FROM album_photos p JOIN albums a ON a.id=p.album_id JOIN users u ON u.id=? WHERE p.id=? AND p.deleted_at IS NULL AND a.deleted_at IS NULL AND ${original ? 'p.owner_id=? AND p.original_key IS NOT NULL' : ACL})`, ... (original ? [userId, photoId, userId] : [userId, photoId, userId, userId]))
}
function cosOptions(env: AlbumEnv) {
  const { COS_SECRET_ID: secretId, COS_SECRET_KEY: secretKey, COS_BUCKET: bucket, COS_REGION: region } = env
  if (!secretId || !secretKey || !bucket || !region) throw new AlbumError('private_storage_unavailable', '相册私有存储暂不可用', 503)
  return { secretId, secretKey, bucket, region }
}
function privateKey(userId: number, key: string): void {
  // eslint-disable-next-line no-control-regex -- reject control bytes in a server-owned COS path
  if (!key.startsWith(`albums/${userId}/`) || key.includes('..') || /[\\?#\u0000-\u001f]/.test(key) || key.includes('//') || key.endsWith('/')) throw new AlbumError('invalid_private_key', '相册对象不是受管理私有对象', 422)
}
async function signRead(env: AlbumEnv, ownerId: number, key: string): Promise<{ url: string; expires_at: number }> {
  privateKey(ownerId, key)
  const result = await createCosGetAuthorization({ ...cosOptions(env), objectKey: key, contentType: '', expiresInSeconds: READ_TTL })
  return { url: result.url, expires_at: result.expiresAt }
}

/** Read the currently permitted album without exposing existence of inaccessible private albums. */
export async function getAccessibleAlbum(env: AlbumEnv, userId: number, albumId: string): Promise<AlbumRow> {
  const row = await env.abdl_space_db.prepare(`SELECT a.* FROM albums a WHERE a.id=? AND a.deleted_at IS NULL AND ${ACL}`).bind(id(albumId), userId, userId).first<AlbumRow>()
  if (!row) throw new AlbumError('album_not_found', '相册不存在或无访问权限', 404)
  return row
}
async function ownedAlbum(env: AlbumEnv, userId: number, albumId: string): Promise<AlbumRow> {
  const row = await getAccessibleAlbum(env, userId, albumId)
  if (row.owner_id !== userId) throw new AlbumError('album_forbidden', '只有相册所有者可以操作', 403)
  return row
}
async function accessiblePhoto(env: AlbumEnv, userId: number, photoId: string): Promise<PhotoRow> {
  const row = await env.abdl_space_db.prepare(`SELECT p.* FROM album_photos p JOIN albums a ON a.id=p.album_id WHERE p.id=? AND p.deleted_at IS NULL AND a.deleted_at IS NULL AND ${ACL}`).bind(id(photoId), userId, userId).first<PhotoRow>()
  if (!row) throw new AlbumError('photo_not_found', '照片不存在或无访问权限', 404)
  return row
}

/** Create exactly one immutable private default album, safely under concurrent retries. */
export async function ensureDefaultAlbum(env: AlbumEnv, userId: number): Promise<AlbumRow> {
  const albumId = crypto.randomUUID()
  await atomic(env, [
    guard(env, 'EXISTS(SELECT 1 FROM users WHERE id=?)', userId),
    env.abdl_space_db.prepare(`INSERT INTO albums(id,owner_id,name,visibility,is_default) VALUES(?,?,'宝宝相册','private',1) ON CONFLICT DO NOTHING`).bind(albumId, userId),
    env.abdl_space_db.prepare('INSERT INTO album_storage(user_id) VALUES(?) ON CONFLICT(user_id) DO NOTHING').bind(userId),
  ])
  const row = await env.abdl_space_db.prepare('SELECT * FROM albums WHERE owner_id=? AND is_default=1').bind(userId).first<AlbumRow>()
  if (!row) throw new AlbumError('albums_unavailable', '默认相册暂不可用', 503)
  return row
}

/** Live tier uses latest actual plan duration; legacy active memberships safely fall back to week (5 GiB). */
export async function getAlbumStorageQuota(env: { abdl_space_db: D1Database }, userId: number): Promise<StorageQuota> {
  const row = await env.abdl_space_db.prepare('SELECT tier,sponsor_active,limit_bytes,used_bytes,reserved_bytes FROM album_storage_entitlements WHERE user_id=?').bind(userId).first<{ tier: AlbumStorageTier; sponsor_active: number; limit_bytes: number; used_bytes: number; reserved_bytes: number }>()
  if (!row) throw new AlbumError('albums_unavailable', '相册存储额度暂不可用', 503)
  return { tier: row.tier, sponsor_active: !!row.sponsor_active, original_upload_allowed: !!row.sponsor_active, limit_bytes: row.limit_bytes, used_bytes: row.used_bytes, reserved_bytes: row.reserved_bytes, remaining_bytes: Math.max(0, row.limit_bytes - row.used_bytes - row.reserved_bytes) }
}
async function activeSponsor(env: AlbumEnv, userId: number): Promise<boolean> {
  const row = await env.abdl_space_db.prepare('SELECT EXISTS(SELECT 1 FROM sponsor_memberships WHERE user_id=? AND (permanent=1 OR expires_at>unixepoch())) AS active').bind(userId).first<{ active: number }>()
  return row?.active === 1
}

/** Project only DTO fields, with short-lived previews and a final current ACL read. */
export async function albumDto(env: AlbumEnv, userId: number, album: AlbumRow): Promise<Album> {
  const stats = await env.abdl_space_db.prepare(`SELECT (SELECT count(*) FROM album_photos WHERE album_id=? AND deleted_at IS NULL) AS photo_count,(SELECT count(*) FROM album_members WHERE album_id=?) AS member_count`).bind(album.id, album.id).first<{ photo_count: number; member_count: number }>()
  const cover = await env.abdl_space_db.prepare(`SELECT preview_key FROM album_photos WHERE album_id=? AND deleted_at IS NULL ORDER BY coalesce(captured_at,uploaded_at) DESC,uploaded_at DESC,batch_id DESC,sort_order,id DESC LIMIT 1`).bind(album.id).first<{ preview_key: string }>()
  const url = cover ? (await signRead(env, album.owner_id, cover.preview_key)).url : null
  const current = await getAccessibleAlbum(env, userId, album.id)
  return { id: current.id, owner_id: current.owner_id, name: current.name, visibility: current.visibility, is_default: !!current.is_default, photo_count: stats?.photo_count ?? 0, cover_url: url, created_at: current.created_at, can_upload: current.owner_id === userId, is_owner: current.owner_id === userId, member_count: stats?.member_count ?? 0 }
}

/** List public/owned/shared-readable albums; another owner's private default is never created. */
export async function listAlbums(env: AlbumEnv, userId: number, ownerId: number, pagination: { limit: number; offset: number }): Promise<AlbumListResponse> {
  integer(ownerId, 1, Number.MAX_SAFE_INTEGER)
  if (ownerId === userId) await ensureDefaultAlbum(env, userId)
  const rows = await env.abdl_space_db.prepare(`SELECT a.* FROM albums a WHERE a.owner_id=? AND a.deleted_at IS NULL AND ${ACL} ORDER BY a.is_default DESC,a.created_at DESC,a.id DESC LIMIT ? OFFSET ?`).bind(ownerId, userId, userId, pagination.limit + 1, pagination.offset).all<AlbumRow>()
  if (!rows.success) throw new Error('Album query failed')
  return { albums: await Promise.all(rows.results.slice(0, pagination.limit).map(row => albumDto(env, userId, row))), has_more: rows.results.length > pagination.limit }
}

/** Create an album using only the selected session's identity. */
export async function createAlbum(env: AlbumEnv, userId: number, input: unknown): Promise<Album> {
  const value = object(input); allowedKeys(value, ['name', 'visibility'])
  const albumId = crypto.randomUUID(); const name = text(value.name, 80); const mode = visibility(value.visibility)
  await atomic(env, [guard(env, 'EXISTS(SELECT 1 FROM users WHERE id=?)', userId), env.abdl_space_db.prepare('INSERT INTO albums(id,owner_id,name,visibility) VALUES(?,?,?,?)').bind(albumId, userId, name, mode)])
  return albumDto(env, userId, await getAccessibleAlbum(env, userId, albumId))
}

/** Patch owner metadata; defaults are immutable even if the same values are supplied. */
export async function patchAlbum(env: AlbumEnv, userId: number, albumId: string, input: unknown): Promise<Album> {
  const value = object(input); allowedKeys(value, ['name', 'visibility'])
  if (!Object.keys(value).length) throw new AlbumError('invalid_request', '没有需要修改的字段')
  const album = await ownedAlbum(env, userId, albumId)
  if (album.is_default) throw new AlbumError('default_album_immutable', '默认相册不能修改或删除', 409)
  const name = value.name === undefined ? album.name : text(value.name, 80)
  const mode = value.visibility === undefined ? album.visibility : visibility(value.visibility)
  await atomic(env, [ownerGuard(env, userId, albumId), env.abdl_space_db.prepare('UPDATE albums SET name=?,visibility=?,updated_at=unixepoch() WHERE id=? AND owner_id=? AND deleted_at IS NULL AND is_default=0').bind(name, mode, albumId, userId)])
  return albumDto(env, userId, await getAccessibleAlbum(env, userId, albumId))
}

async function photoDto(env: AlbumEnv, userId: number, row: PhotoProjectionRow, sponsor: boolean): Promise<Photo> {
  return {
    id: row.id, album_id: row.album_id, batch_id: row.batch_id, description: row.description,
    captured_at: row.captured_at, uploaded_at: row.uploaded_at, sort_at: row.captured_at ?? row.uploaded_at,
    preview_url: (await signRead(env, row.owner_id, row.preview_key)).url,
    hd_url: userId === row.owner_id && sponsor ? (await signRead(env, row.owner_id, row.hd_key)).url : null,
    original_available: userId === row.owner_id && row.original_key !== null, width: row.width, height: row.height,
    likes_count: row.likes_count, comments_count: row.comments_count, liked: !!row.liked,
    is_owner: userId === row.owner_id, owner_sponsor: sponsor,
  }
}

/** Renew one accessible photo preview without charging quota or returning a lossless original URL. */
export async function getAlbumPhoto(env: AlbumEnv, userId: number, photoId: string): Promise<Photo> {
  const row = await env.abdl_space_db.prepare(`SELECT ${PHOTO_PROJECTION} FROM album_photos p JOIN albums a ON a.id=p.album_id
    WHERE p.id=? AND p.deleted_at IS NULL AND a.deleted_at IS NULL AND ${ACL}`).bind(userId, id(photoId), userId, userId).first<PhotoProjectionRow>()
  if (!row) throw new AlbumError('photo_not_found', '照片不存在或无访问权限', 404)
  const photo = await photoDto(env, userId, row, await activeSponsor(env, row.owner_id))
  // Signing is asynchronous: a removed shared member or deleted photo must not receive the fresh URL.
  await accessiblePhoto(env, userId, photoId)
  const currentSponsor = await activeSponsor(env, row.owner_id)
  photo.owner_sponsor = currentSponsor
  if (!currentSponsor) photo.hd_url = null
  return photo
}

/** Sign accessible preview DTOs; only a CURRENT active sponsor owner receives inline HD. */
export async function listAlbumPhotos(env: AlbumEnv, userId: number, albumId: string, pagination: { limit: number; offset: number }): Promise<AlbumPhotosResponse> {
  const album = await getAccessibleAlbum(env, userId, albumId)
  const rows = await env.abdl_space_db.prepare(`SELECT ${PHOTO_PROJECTION} FROM album_photos p JOIN albums a ON a.id=p.album_id WHERE p.album_id=? AND p.deleted_at IS NULL AND a.deleted_at IS NULL AND ${ACL} ORDER BY coalesce(p.captured_at,p.uploaded_at) DESC,p.uploaded_at DESC,p.id DESC LIMIT ? OFFSET ?`).bind(userId, albumId, userId, userId, pagination.limit + 1, pagination.offset).all<PhotoProjectionRow>()
  if (!rows.success) throw new Error('Photo query failed')
  const sponsor = await activeSponsor(env, album.owner_id)
  const photos = await Promise.all(rows.results.slice(0, pagination.limit).map(row => photoDto(env, userId, row, sponsor)))
  await getAccessibleAlbum(env, userId, albumId)
  const currentSponsor = await activeSponsor(env, album.owner_id)
  for (const photo of photos) { photo.owner_sponsor = currentSponsor; if (!currentSponsor) photo.hd_url = null }
  return { photos, has_more: rows.results.length > pagination.limit }
}

interface ValidVariant { kind: 'preview' | 'hd' | 'original'; mime: string; size: number; md5: string; variantWidth: number | null; variantHeight: number | null }
interface ValidPhoto { clientId: string; width: number; height: number; sortOrder: number; variants: ValidVariant[] }
interface ValidBatch { operationId: string; description: string; capturedAt: number | null; quality: 'hd' | 'original'; photos: ValidPhoto[]; bytes: number }
function validateBatch(input: unknown): ValidBatch {
  const value = object(input); allowedKeys(value, ['operation_id', 'description', 'captured_at', 'quality', 'photos'])
  const quality = value.quality
  if (quality !== 'hd' && quality !== 'original') throw new AlbumError('invalid_request', '照片质量不正确')
  if (!Array.isArray(value.photos) || value.photos.length < 1 || value.photos.length > 20) throw new AlbumError('invalid_request', '每批必须包含一至二十张照片')
  const photos = value.photos.map((item, sortOrder) => {
    const photo = object(item); allowedKeys(photo, ['client_id', 'width', 'height', 'variants'])
    const clientId = text(photo.client_id, 80); const width = integer(photo.width, 1, 100000); const height = integer(photo.height, 1, 100000)
    if (!Array.isArray(photo.variants) || photo.variants.length !== (quality === 'hd' ? 2 : 3)) throw new AlbumError('invalid_request', '每张照片必须提供预览和高清变体，无损质量还需要原图')
    const variants = photo.variants.map(item => {
      const v = object(item); allowedKeys(v, ['kind', 'mime_type', 'size', 'content_md5', 'width', 'height'])
      const kind = v.kind
      if (kind !== 'preview' && kind !== 'hd' && kind !== 'original') throw new AlbumError('invalid_request', '照片变体不正确')
      const mime = text(v.mime_type, 40).toLowerCase()
      const validMimes = kind === 'preview' ? ['image/jpeg', 'image/webp'] : kind === 'hd' ? ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] : Object.keys(MIMES)
      const size = integer(v.size, 1, kind === 'preview' ? 2 * MIB : kind === 'hd' ? 10 * MIB : 20 * MIB - 1)
      const md5 = text(v.content_md5, 32)
      if (!validMimes.includes(mime) || !isCanonicalContentMd5(md5)) throw new AlbumError('invalid_request', '照片类型或 MD5 不正确')
      const variantWidth = v.width === undefined ? null : integer(v.width, 1, kind === 'preview' ? 540 : 100000)
      const variantHeight = v.height === undefined ? null : integer(v.height, 1, kind === 'preview' ? 540 : 100000)
      if ((variantWidth === null) !== (variantHeight === null)) throw new AlbumError('invalid_request', '变体宽高必须同时提供')
      return { kind, mime, size, md5, variantWidth, variantHeight } satisfies ValidVariant
    }).sort((a, b) => a.kind.localeCompare(b.kind))
    if (new Set(variants.map(v => v.kind)).size !== variants.length || !variants.some(v => v.kind === 'preview') || !variants.some(v => v.kind === 'hd') || variants.some(v => v.kind === 'original') !== (quality === 'original')) throw new AlbumError('invalid_request', '照片变体重复或缺失')
    return { clientId, width, height, sortOrder, variants }
  })
  if (new Set(photos.map(p => p.clientId)).size !== photos.length) throw new AlbumError('invalid_request', '照片 client_id 不能重复')
  return { quality, operationId: operation(value.operation_id), description: text(value.description, 3000, true), capturedAt: captured(value.captured_at ?? null), photos, bytes: photos.reduce((sum, p) => sum + p.variants.reduce((n, v) => n + v.size, 0), 0) }
}
async function readBatch(env: AlbumEnv, batchId: string): Promise<BatchRow | null> { return env.abdl_space_db.prepare('SELECT * FROM album_batches WHERE id=?').bind(batchId).first<BatchRow>() }

/** Reserve the entire immutable batch atomically, rejecting quota races, forged ownership and replay conflicts. */
export async function authorizeAlbumBatch(env: AlbumEnv, userId: number, albumId: string, input: unknown): Promise<AlbumBatchAuthorization> {
  const value = validateBatch(input)
  await ownedAlbum(env, userId, albumId)
  cosOptions(env)
  await expireAlbumBatches(env, userId)
  const hash = await sponsorHash(JSON.stringify([albumId, value]))
  const previous = await env.abdl_space_db.prepare('SELECT * FROM album_batches WHERE owner_id=? AND operation_id=?').bind(userId, value.operationId).first<BatchRow>()
  if (previous && previous.request_hash !== hash) throw new AlbumError('idempotency_conflict', '操作编号已用于其他请求', 409)
  if (!previous) {
    const batchId = crypto.randomUUID(); const now = Math.floor(Date.now() / 1000)
    const statements = [ownerGuard(env, userId, albumId), env.abdl_space_db.prepare(`INSERT INTO album_batches(id,album_id,owner_id,operation_id,request_hash,description,captured_at,quality,photo_count,reserved_bytes,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,operation_id) DO NOTHING`).bind(batchId, albumId, userId, value.operationId, hash, value.description, value.capturedAt, value.quality, value.photos.length, value.bytes, now + BATCH_TTL)]
    for (const photo of value.photos) {
      const photoId = crypto.randomUUID()
      for (const v of photo.variants) statements.push(env.abdl_space_db.prepare(`INSERT INTO album_uploads(id,batch_id,album_id,owner_id,photo_id,client_id,sort_order,kind,object_key,mime_type,declared_size,content_md5,width,height,variant_width,variant_height,expires_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM album_batches WHERE id=?)`).bind(crypto.randomUUID(), batchId, albumId, userId, photoId, photo.clientId, photo.sortOrder, v.kind, `albums/${userId}/${batchId}/${photoId}/${v.kind}.${MIMES[v.mime]}`, v.mime, v.size, v.md5, photo.width, photo.height, v.variantWidth, v.variantHeight, now + UPLOAD_TTL, batchId))
    }
    await atomic(env, statements)
  }
  const current = await env.abdl_space_db.prepare('SELECT * FROM album_batches WHERE owner_id=? AND operation_id=?').bind(userId, value.operationId).first<BatchRow>()
  if (!current || current.request_hash !== hash) throw new AlbumError('idempotency_conflict', '操作编号已用于其他请求', 409)
  if (current.status === 'published') {
    await ownedAlbum(env, userId, albumId)
    return { batch_id: current.id, uploads: [], published: true, album_id: current.album_id, post_id: current.post_id }
  }
  if (current.status !== 'pending' || current.expires_at <= Math.floor(Date.now() / 1000)) throw new AlbumError('album_batch_expired', '上传批次已过期或取消', 409)
  // Reauthorization preserves immutable objects and IDs; uncertain PUT retries complete first.
  const now = Math.floor(Date.now() / 1000); const expires = Math.min(now + UPLOAD_TTL, current.expires_at)
  await atomic(env, [ownerGuard(env, userId, albumId), guard(env, `EXISTS(SELECT 1 FROM album_storage_entitlements WHERE user_id=? AND used_bytes+reserved_bytes<=limit_bytes AND (?='hd' OR sponsor_active=1))`, userId, current.quality), env.abdl_space_db.prepare(`UPDATE album_uploads SET expires_at=max(expires_at,?) WHERE batch_id=? AND EXISTS(SELECT 1 FROM album_batches WHERE id=? AND status='pending' AND expires_at>unixepoch())`).bind(expires, current.id, current.id)])
  const rows = await env.abdl_space_db.prepare('SELECT * FROM album_uploads WHERE batch_id=? ORDER BY sort_order,kind').bind(current.id).all<UploadRow>()
  if (!rows.success) throw new Error('Upload query failed')
  const signed = await Promise.all(rows.results.map(async upload => {
    privateKey(userId, upload.object_key)
    const auth = await createCosPutAuthorization({ ...cosOptions(env), objectKey: upload.object_key, contentType: upload.mime_type, contentLength: upload.declared_size, contentMd5: upload.content_md5, objectAcl: 'private', now: new Date(now * 1000), expiresInSeconds: expires - now })
    return { photo_id: upload.photo_id, client_id: upload.client_id, kind: upload.kind, upload_id: upload.id, upload_url: auth.url, required_headers: { ...auth.headers }, expires_at: auth.expiresAt }
  }))
  await atomic(env, [ownerGuard(env, userId, albumId), guard(env, `EXISTS(SELECT 1 FROM album_batches b JOIN album_storage_entitlements s ON s.user_id=b.owner_id WHERE b.id=? AND b.status='pending' AND b.expires_at>unixepoch() AND s.used_bytes+s.reserved_bytes<=s.limit_bytes AND (b.quality='hd' OR s.sponsor_active=1))`, current.id)])
  return { batch_id: current.id, uploads: signed }
}

function previewDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const known = inspectMediaImageDimensions(bytes)
  if (known) return known
  // Android transparent previews can use simple VP8L/VP8, not just extended VP8X.
  if (bytes.length < 25 || new TextDecoder().decode(bytes.subarray(0, 4)) !== 'RIFF' || new TextDecoder().decode(bytes.subarray(8, 12)) !== 'WEBP') return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(4, true) + 8 !== bytes.byteLength) return null
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = new TextDecoder().decode(bytes.subarray(offset, offset + 4))
    const size = view.getUint32(offset + 4, true); const start = offset + 8
    if (size > bytes.length - start) return null
    if (kind === 'VP8L' && size >= 5 && bytes[start] === 0x2f) return { width: 1 + (view.getUint32(start + 1, true) & 0x3fff), height: 1 + ((view.getUint32(start + 1, true) >>> 14) & 0x3fff) }
    if (kind === 'VP8 ' && size >= 10 && (bytes[start] & 1) === 0 && bytes[start + 3] === 0x9d && bytes[start + 4] === 0x01 && bytes[start + 5] === 0x2a) return { width: view.getUint16(start + 6, true) & 0x3fff, height: view.getUint16(start + 8, true) & 0x3fff }
    offset = start + size + (size % 2)
  }
  return null
}
async function verifyPreviewDimensions(env: AlbumEnv, upload: UploadRow): Promise<void> {
  const response = await getPrivateObjectFromCos({ ...cosOptions(env), objectKey: upload.object_key, contentType: upload.mime_type })
  const reader = response.body?.getReader()
  if (!reader) throw new AlbumError('album_upload_mismatch', '照片内容不完整', 422)
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > upload.declared_size || length > 2 * MIB) throw new AlbumError('album_upload_mismatch', '预览图片过大', 422)
      chunks.push(chunk.value)
    }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  const dimensions = previewDimensions(bytes)
  const magicMatches = upload.mime_type === 'image/jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 : new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP'
  if (!magicMatches || dimensions?.width === 0 || dimensions?.height === 0 || length !== upload.declared_size || md5Base64(bytes) !== upload.content_md5 || !dimensions || Math.max(dimensions.width, dimensions.height) > 540
    || (upload.variant_width !== null && dimensions.width !== upload.variant_width) || (upload.variant_height !== null && dimensions.height !== upload.variant_height)) throw new AlbumError('album_preview_dimensions', '预览图片内容或实际尺寸不正确（最长边 540）', 422)
}

/** Verify fixed-host private COS HEAD integrity and bounded actual preview dimensions before transactional completion. */
export async function completeAlbumUpload(env: AlbumEnv, userId: number, uploadId: string): Promise<{ complete: true }> {
  const upload = await env.abdl_space_db.prepare('SELECT * FROM album_uploads WHERE id=? AND owner_id=?').bind(id(uploadId), userId).first<UploadRow>()
  if (!upload) throw new AlbumError('upload_not_found', '上传不存在', 404)
  await ownedAlbum(env, userId, upload.album_id)
  const batch = await readBatch(env, upload.batch_id)
  if (!batch || batch.status === 'cancelled') throw new AlbumError('album_batch_expired', '上传批次已取消', 409)
  if (batch.status === 'published' && upload.status === 'complete') return { complete: true }
  if (batch.expires_at <= Math.floor(Date.now() / 1000)) throw new AlbumError('album_batch_expired', '上传批次已过期', 409)
  const permission = [ownerGuard(env, userId, upload.album_id), guard(env, `EXISTS(SELECT 1 FROM album_batches b JOIN album_storage_entitlements s ON s.user_id=b.owner_id WHERE b.id=? AND b.status='pending' AND b.expires_at>unixepoch() AND s.used_bytes+s.reserved_bytes<=s.limit_bytes AND (b.quality='hd' OR s.sponsor_active=1))`, batch.id)]
  if (upload.status === 'complete') { await atomic(env, permission); return { complete: true } }
  if (upload.expires_at <= Math.floor(Date.now() / 1000)) throw new AlbumError('upload_expired', '上传授权已过期，请重新授权', 409)
  privateKey(userId, upload.object_key)
  let head: Response
  try { head = await headPrivateObjectFromCos({ ...cosOptions(env), objectKey: upload.object_key, contentType: upload.mime_type }) }
  catch (error) { throw new AlbumError(error instanceof CosHttpError && error.status === 404 ? 'upload_object_missing' : 'upload_verification_unavailable', error instanceof CosHttpError && error.status === 404 ? '照片尚未上传' : '照片校验暂不可用', error instanceof CosHttpError && error.status === 404 ? 409 : 502) }
  const length = head.headers.get('content-length')
  const type = head.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
  const etag = head.headers.get('etag')?.replace(/^"|"$/g, '').toLowerCase()
  const md5hex = Array.from(atob(upload.content_md5), ch => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('')
  if (length === null || !/^\d+$/.test(length) || Number(length) !== upload.declared_size || type !== upload.mime_type || etag !== md5hex) throw new AlbumError('album_upload_mismatch', '照片大小、类型或 MD5 不匹配', 422)
  if (upload.kind === 'preview') await verifyPreviewDimensions(env, upload)
  await atomic(env, [...permission, env.abdl_space_db.prepare(`UPDATE album_uploads SET status='complete',verified_size=?,completed_at=unixepoch() WHERE id=? AND owner_id=? AND status='pending' AND expires_at>unixepoch()`).bind(Number(length), upload.id, userId), guard(env, `EXISTS(SELECT 1 FROM album_uploads WHERE id=? AND owner_id=? AND status='complete' AND verified_size=declared_size)`, upload.id, userId)])
  return { complete: true }
}

/** Trigger-driven publication atomically moves bytes, inserts photos and optionally creates exactly one fallback post. */
export async function publishAlbumBatch(env: AlbumEnv, userId: number, batchId: string): Promise<AlbumPublishResponse> {
  const batch = await readBatch(env, id(batchId))
  if (!batch || batch.owner_id !== userId) throw new AlbumError('batch_not_found', '上传批次不存在', 404)
  await ownedAlbum(env, userId, batch.album_id)
  await atomic(env, [ownerGuard(env, userId, batch.album_id), env.abdl_space_db.prepare(`UPDATE album_batches SET status='published' WHERE id=? AND owner_id=? AND status='pending'`).bind(batchId, userId), guard(env, `EXISTS(SELECT 1 FROM album_batches WHERE id=? AND owner_id=? AND status='published')`, batchId, userId)])
  const current = await readBatch(env, batchId)
  if (!current) throw new Error('Published batch disappeared')
  return { album_id: current.album_id, batch_id: current.id, post_id: current.post_id }
}

/** Read owner-only publication state for uncertain network retries, without signing upload objects. */
export async function getAlbumBatch(env: AlbumEnv, userId: number, batchId: string): Promise<AlbumPublishResponse & { status: string }> {
  const batch = await readBatch(env, id(batchId))
  if (!batch || batch.owner_id !== userId) throw new AlbumError('batch_not_found', '上传批次不存在', 404)
  await ownedAlbum(env, userId, batch.album_id)
  return { album_id: batch.album_id, batch_id: batch.id, post_id: batch.post_id, status: batch.status }
}

/** Explicit discard revokes server use immediately; charged reservations stay until safe COS deletion. */
export async function cancelAlbumBatch(env: AlbumEnv, userId: number, batchId: string): Promise<{ cancelled: true }> {
  const batch = await readBatch(env, id(batchId))
  if (!batch || batch.owner_id !== userId) throw new AlbumError('batch_not_found', '上传批次不存在', 404)
  await ownedAlbum(env, userId, batch.album_id)
  if (batch.status === 'published') throw new AlbumError('batch_already_published', '已发布的批次不能取消', 409)
  await atomic(env, [ownerGuard(env, userId, batch.album_id), env.abdl_space_db.prepare(`UPDATE album_batches SET status='cancelled' WHERE id=? AND owner_id=? AND status='pending'`).bind(batchId, userId), guard(env, `EXISTS(SELECT 1 FROM album_batches WHERE id=? AND owner_id=? AND status='cancelled')`, batchId, userId)])
  await cleanupAlbumObjects(env, userId)
  return { cancelled: true }
}

/** Invalidate ordinary feed count only after successful publication, never on a rollback. */
export async function invalidateAlbumFeed(env: Env, postId: number | null): Promise<void> {
  if (postId !== null) await invalidateFeedCount(env).catch(() => { console.error(JSON.stringify({ event: 'album_feed_cache_invalidation_failed' })) })
}

/** Server-only history input; reserve verified sizes BEFORE copying into these independent private keys. */
export interface AlbumHistoryPhotoInput {
  sourcePostImageId: number; sourceUploadId: string | null; previewKey: string; hdKey: string; previewBytes: number; hdBytes: number
  width: number; height: number; description: string; capturedAt: number | null; uploadedAt: number
  previewMimeType: string; hdMimeType: string; previewMd5: string; hdMd5: string
}
/** A live history reservation; created=false means another importer owns copying these keys. */
export interface AlbumHistoryReservation {
  batch_id: string; photo_id: string; album_id: string; created: boolean; published: boolean; preview_key: string; hd_key: string; expires_at: number
}

/** Reserve a proven same-owner history copy before COS PUT; duplicates never create uncharged orphan objects. */
export async function reserveAlbumHistoryPhoto(env: AlbumEnv, userId: number, input: AlbumHistoryPhotoInput): Promise<AlbumHistoryReservation> {
  integer(input.sourcePostImageId, 1, Number.MAX_SAFE_INTEGER); privateKey(userId, input.previewKey); privateKey(userId, input.hdKey)
  if (input.previewKey === input.hdKey) throw new AlbumError('invalid_private_key', '导入预览和高清对象必须独立', 422)
  integer(input.previewBytes, 1, 2 * MIB); integer(input.hdBytes, 1, 10 * MIB)
  integer(input.width, 1, 100000); integer(input.height, 1, 100000); integer(input.uploadedAt, 0, 253402300799); captured(input.capturedAt)
  const variants = [{ kind: 'preview', key: input.previewKey, bytes: input.previewBytes, mime: input.previewMimeType, md5: input.previewMd5 }, { kind: 'hd', key: input.hdKey, bytes: input.hdBytes, mime: input.hdMimeType, md5: input.hdMd5 }]
  for (const v of variants) if (!(v.kind === 'preview' ? ['image/jpeg', 'image/webp'] : ['image/jpeg', 'image/png', 'image/webp', 'image/gif']).includes(v.mime) || !isCanonicalContentMd5(v.md5)) throw new AlbumError('invalid_request', '导入图片类型或 MD5 不正确')
  const album = await ensureDefaultAlbum(env, userId)
  await expireAlbumBatches(env, userId)
  const batchId = crypto.randomUUID(); const photoId = crypto.randomUUID(); const expires = Math.floor(Date.now() / 1000) + BATCH_TTL
  const hash = await sponsorHash(`history:${userId}:${input.sourcePostImageId}`)
  const statements = [ownerGuard(env, userId, album.id), guard(env, `EXISTS(SELECT 1 FROM album_photos WHERE source_post_image_id=? AND owner_id=?) OR EXISTS(SELECT 1 FROM post_images i JOIN posts p ON p.id=i.post_id WHERE i.id=? AND p.user_id=?)`, input.sourcePostImageId, userId, input.sourcePostImageId, userId), env.abdl_space_db.prepare(`INSERT INTO album_batches(id,album_id,owner_id,operation_id,request_hash,description,captured_at,quality,photo_count,reserved_bytes,source_post_image_id,source_upload_id,uploaded_at,expires_at)
    SELECT ?,?,?,?,?,?,?,'hd',1,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM album_batches WHERE source_post_image_id=? AND status!='cancelled') ON CONFLICT DO NOTHING`).bind(batchId, album.id, userId, `history:${input.sourcePostImageId}:${batchId}`, hash, text(input.description, 3000, true), input.capturedAt, input.previewBytes + input.hdBytes, input.sourcePostImageId, input.sourceUploadId, input.uploadedAt, expires, input.sourcePostImageId)]
  for (const v of variants) statements.push(env.abdl_space_db.prepare(`INSERT INTO album_uploads(id,batch_id,album_id,owner_id,photo_id,client_id,kind,object_key,mime_type,declared_size,content_md5,width,height,expires_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM album_batches WHERE id=?)`).bind(crypto.randomUUID(), batchId, album.id, userId, photoId, `history:${input.sourcePostImageId}`, v.kind, v.key, v.mime, v.bytes, v.md5, input.width, input.height, Math.floor(Date.now() / 1000) + UPLOAD_TTL, batchId))
  await atomic(env, statements)
  const row = await env.abdl_space_db.prepare(`SELECT b.id,b.album_id,b.owner_id,b.status,u.photo_id,max(CASE u.kind WHEN 'preview' THEN u.object_key END) AS preview_key,max(CASE u.kind WHEN 'hd' THEN u.object_key END) AS hd_key,min(u.expires_at) AS expires_at FROM album_batches b JOIN album_uploads u ON u.batch_id=b.id WHERE b.source_post_image_id=? AND b.status!='cancelled' GROUP BY b.id`).bind(input.sourcePostImageId).first<{ id: string; album_id: string; owner_id: number; status: string; photo_id: string; preview_key: string; hd_key: string; expires_at: number }>()
  if (!row || row.owner_id !== userId) throw new AlbumError('history_import_conflict', '历史导入状态已变化', 409)
  return { batch_id: row.id, photo_id: row.photo_id, album_id: row.album_id, created: row.id === batchId, published: row.status === 'published', preview_key: row.preview_key, hd_key: row.hd_key, expires_at: row.expires_at }
}

/** HEAD-verify a reserved server copy, then atomically publish through the ordinary album trigger. */
export async function publishReservedAlbumHistoryPhoto(env: AlbumEnv, userId: number, batchId: string): Promise<{ inserted: boolean; photo_id: string; album_id: string }> {
  const batch = await readBatch(env, batchId)
  if (!batch || batch.owner_id !== userId) throw new AlbumError('batch_not_found', '历史导入批次不存在', 404)
  const rows = await env.abdl_space_db.prepare('SELECT id,photo_id FROM album_uploads WHERE batch_id=? ORDER BY kind').bind(batchId).all<{ id: string; photo_id: string }>()
  if (!rows.success || rows.results.length !== 2) throw new AlbumError('album_batch_incomplete', '历史导入照片不完整', 409)
  for (const upload of rows.results) await completeAlbumUpload(env, userId, upload.id)
  const result = await publishAlbumBatch(env, userId, batchId)
  return { inserted: batch.status !== 'published', photo_id: rows.results[0].photo_id, album_id: result.album_id }
}

/** Cancel only an unpublished copy; ambiguous publication never deletes committed private photos. */
export async function cancelAlbumHistoryReservation(env: AlbumEnv, userId: number, batchId: string): Promise<void> {
  await atomic(env, [guard(env, 'EXISTS(SELECT 1 FROM album_batches WHERE id=? AND owner_id=?)', batchId, userId), env.abdl_space_db.prepare(`UPDATE album_batches SET status='cancelled' WHERE id=? AND owner_id=? AND status='pending'`).bind(batchId, userId)])
  await cleanupAlbumObjects(env, userId)
}

/** Compatibility insertion helper; callers must reserve BEFORE copying and use the returned immutable keys. */
export async function insertAlbumHistoryPhoto(env: AlbumEnv, userId: number, input: AlbumHistoryPhotoInput): Promise<{ inserted: boolean; photo_id: string; album_id: string }> {
  const reserved = await reserveAlbumHistoryPhoto(env, userId, input)
  if (reserved.published) return { inserted: false, photo_id: reserved.photo_id, album_id: reserved.album_id }
  return publishReservedAlbumHistoryPhoto(env, userId, reserved.batch_id)
}

/** Explicit HD/original viewing uses a server-derived media hash, current ACL and atomic sponsor debit guards. */
export async function authorizeAlbumPhoto(env: AlbumEnv, userId: number, photoId: string, input: unknown): Promise<AlbumPhotoAuthorization> {
  const value = object(input); allowedKeys(value, ['variant', 'operation_id', 'notice_version'])
  if (value.variant !== 'hd' && value.variant !== 'original') throw new AlbumError('invalid_request', '照片变体不正确')
  const operationId = operation(value.operation_id)
  const photo = await accessiblePhoto(env, userId, photoId)
  const original = value.variant === 'original'
  if (original && photo.owner_id !== userId) throw new AlbumError('original_owner_only', '无损原图仅所有者可查看', 403)
  if (original && !photo.original_key) throw new AlbumError('original_not_available', '照片没有无损原图', 404)
  const signed = await signRead(env, photo.owner_id, original ? photo.original_key! : photo.hd_key)
  const check = photoGuard(env, userId, photoId, original)
  // Free owner HD is checked under the transaction, then rechecked before returning the URL.
  if (!original && photo.owner_id === userId && await activeSponsor(env, userId)) {
    try {
      await atomic(env, [check, guard(env, `EXISTS(SELECT 1 FROM sponsor_memberships WHERE user_id=? AND (permanent=1 OR expires_at>unixepoch()))`, userId)])
      await accessiblePhoto(env, userId, photoId)
      if (await activeSponsor(env, userId)) return { ...signed, charged: false }
    } catch (error) { if (!(error instanceof AlbumError && error.code === 'album_conflict')) throw error }
  }
  const config = await getSponsorConfig(env)
  if (!config.enabled) {
    if (original) throw new AlbumError('original_quota_unavailable', '无损原图额度服务暂未开放', 503)
    await atomic(env, [check, guard(env, `EXISTS(SELECT 1 FROM sponsor_settings WHERE id=1 AND json_extract(config_json,'$.enabled')=0)`)])
    await accessiblePhoto(env, userId, photoId)
    return { ...signed, charged: false }
  }
  const result = await authorizeSponsorOriginal(env, userId, { operation_id: operationId, media_key: await sponsorHash(`abdl-space:album-photo:${photo.id}:${value.variant}`), notice_version: value.notice_version }, [check, guard(env, `EXISTS(SELECT 1 FROM sponsor_settings WHERE id=1 AND json_extract(config_json,'$.enabled')=1)`)])
  const current = await accessiblePhoto(env, userId, photoId)
  if (original && (current.owner_id !== userId || current.original_key !== photo.original_key)) throw new AlbumError('original_owner_only', '无损原图仅所有者可查看', 403)
  return { ...signed, charged: !result.replayed, quota: result.quota }
}

/** Idempotent like/unlike guarded by current album access within the transaction. */
export async function likeAlbumPhoto(env: AlbumEnv, userId: number, photoId: string, input: unknown): Promise<{ liked: boolean; likes_count: number }> {
  const value = object(input); allowedKeys(value, ['liked'])
  if (typeof value.liked !== 'boolean') throw new AlbumError('invalid_request', 'liked 必须为布尔值')
  await accessiblePhoto(env, userId, photoId)
  await atomic(env, [photoGuard(env, userId, photoId), value.liked ? env.abdl_space_db.prepare('INSERT INTO album_likes(photo_id,user_id) VALUES(?,?) ON CONFLICT(photo_id,user_id) DO NOTHING').bind(photoId, userId) : env.abdl_space_db.prepare('DELETE FROM album_likes WHERE photo_id=? AND user_id=?').bind(photoId, userId)])
  await accessiblePhoto(env, userId, photoId)
  const row = await env.abdl_space_db.prepare('SELECT count(*) AS likes_count,EXISTS(SELECT 1 FROM album_likes WHERE photo_id=? AND user_id=?) AS liked FROM album_likes WHERE photo_id=?').bind(photoId, userId, photoId).first<{ likes_count: number; liked: number }>()
  return { liked: !!row?.liked, likes_count: row?.likes_count ?? 0 }
}
const COMMENT_SELECT = `SELECT c.id,c.user_id,u.username,u.display_name,u.avatar,c.content,c.created_at FROM album_comments c JOIN users u ON u.id=c.user_id`

/** Paginate comments only while the photo remains accessible. */
export async function listAlbumComments(env: AlbumEnv, userId: number, photoId: string, pagination: { limit: number; offset: number }): Promise<AlbumCommentsResponse> {
  await accessiblePhoto(env, userId, photoId)
  const rows = await env.abdl_space_db.prepare(`${COMMENT_SELECT} WHERE c.photo_id=? AND c.deleted_at IS NULL ORDER BY c.created_at,c.id LIMIT ? OFFSET ?`).bind(photoId, pagination.limit + 1, pagination.offset).all<AlbumComment>()
  if (!rows.success) throw new Error('Comment query failed')
  await accessiblePhoto(env, userId, photoId)
  return { comments: rows.results.slice(0, pagination.limit), has_more: rows.results.length > pagination.limit }
}

/** Insert a bounded comment exactly once; changing photo/content under an operation ID is rejected. */
export async function createAlbumComment(env: AlbumEnv, userId: number, photoId: string, input: unknown): Promise<AlbumComment> {
  const value = object(input); allowedKeys(value, ['content', 'operation_id'])
  const content = text(value.content, 2000); const operationId = operation(value.operation_id); const hash = await sponsorHash(JSON.stringify([photoId, content]))
  await accessiblePhoto(env, userId, photoId)
  const commentId = crypto.randomUUID()
  await atomic(env, [photoGuard(env, userId, photoId), env.abdl_space_db.prepare('INSERT INTO album_comments(id,photo_id,user_id,operation_id,request_hash,content) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,operation_id) DO NOTHING').bind(commentId, photoId, userId, operationId, hash, content)])
  const row = await env.abdl_space_db.prepare('SELECT id,request_hash,deleted_at FROM album_comments WHERE user_id=? AND operation_id=?').bind(userId, operationId).first<{ id: string; request_hash: string; deleted_at: number | null }>()
  if (!row || row.request_hash !== hash) throw new AlbumError('idempotency_conflict', '操作编号已用于其他评论', 409)
  if (row.deleted_at !== null) throw new AlbumError('comment_deleted', '评论已删除', 409)
  const comment = await env.abdl_space_db.prepare(`${COMMENT_SELECT} WHERE c.id=?`).bind(row.id).first<AlbumComment>()
  if (!comment) throw new Error('Comment disappeared')
  await accessiblePhoto(env, userId, photoId)
  return comment
}

/** A comment may be deleted only by its author or the album owner, with current read access. */
export async function deleteAlbumComment(env: AlbumEnv, userId: number, commentId: string): Promise<{ deleted: true }> {
  const row = await env.abdl_space_db.prepare('SELECT c.photo_id,c.user_id,p.owner_id FROM album_comments c JOIN album_photos p ON p.id=c.photo_id WHERE c.id=?').bind(id(commentId)).first<{ photo_id: string; user_id: number; owner_id: number }>()
  if (!row) throw new AlbumError('comment_not_found', '评论不存在', 404)
  await accessiblePhoto(env, userId, row.photo_id)
  if (row.user_id !== userId && row.owner_id !== userId) throw new AlbumError('comment_forbidden', '没有删除评论权限', 403)
  await atomic(env, [photoGuard(env, userId, row.photo_id), guard(env, `EXISTS(SELECT 1 FROM album_comments c JOIN album_photos p ON p.id=c.photo_id WHERE c.id=? AND (c.user_id=? OR p.owner_id=?))`, commentId, userId, userId), env.abdl_space_db.prepare('UPDATE album_comments SET deleted_at=coalesce(deleted_at,unixepoch()) WHERE id=?').bind(commentId)])
  return { deleted: true }
}

/** Generate/rotate a 256-bit invite; token hashes expire in seven days and never enter logs. */
export async function createAlbumInvite(env: AlbumEnv, userId: number, albumId: string): Promise<AlbumInvite> {
  const album = await ownedAlbum(env, userId, albumId)
  if (album.visibility !== 'shared') throw new AlbumError('album_not_shared', '只有共享相册可以邀请成员', 409)
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('')
  const hash = await sponsorHash(token); const expires = Math.floor(Date.now() / 1000) + 7 * 86400
  await atomic(env, [ownerGuard(env, userId, albumId), guard(env, `EXISTS(SELECT 1 FROM albums WHERE id=? AND visibility='shared' AND deleted_at IS NULL)`, albumId), env.abdl_space_db.prepare('INSERT INTO album_invites(album_id,token_hash,expires_at) VALUES(?,?,?) ON CONFLICT(album_id) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at,created_at=unixepoch()').bind(albumId, hash, expires)])
  return { token, expires_at: expires, url: `https://abdl-space.top/album-invite/${token}` }
}

/** Accept only a live server-hashed invite; membership insertion and invite checks are atomic. */
export async function joinAlbum(env: AlbumEnv, userId: number, input: unknown): Promise<Album> {
  const value = object(input); allowedKeys(value, ['token'])
  const token = text(value.token, 64)
  if (!/^[a-f0-9]{64}$/.test(token)) throw new AlbumError('invite_unavailable', '邀请无效或已过期', 404)
  const hash = await sponsorHash(token)
  const row = await env.abdl_space_db.prepare(`SELECT a.id FROM album_invites i JOIN albums a ON a.id=i.album_id WHERE i.token_hash=? AND i.expires_at>unixepoch() AND a.visibility='shared' AND a.deleted_at IS NULL`).bind(hash).first<{ id: string }>()
  if (!row) throw new AlbumError('invite_unavailable', '邀请无效或已过期', 404)
  await atomic(env, [guard(env, `EXISTS(SELECT 1 FROM album_invites i JOIN albums a ON a.id=i.album_id JOIN users u ON u.id=? WHERE i.token_hash=? AND i.expires_at>unixepoch() AND a.id=? AND a.visibility='shared' AND a.deleted_at IS NULL)`, userId, hash, row.id), env.abdl_space_db.prepare(`INSERT INTO album_members(album_id,user_id) SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM albums WHERE id=? AND owner_id=?) ON CONFLICT(album_id,user_id) DO NOTHING`).bind(row.id, userId, row.id, userId)], 'invite_unavailable')
  return albumDto(env, userId, await getAccessibleAlbum(env, userId, row.id))
}

/** Membership names are private to the owner and current shared members. */
export async function listAlbumMembers(env: AlbumEnv, userId: number, albumId: string): Promise<AlbumMembersResponse> {
  const album = await getAccessibleAlbum(env, userId, albumId)
  if (album.owner_id !== userId && album.visibility !== 'shared') throw new AlbumError('album_forbidden', '没有查看成员权限', 403)
  const rows = await env.abdl_space_db.prepare('SELECT m.user_id,u.username FROM album_members m JOIN users u ON u.id=m.user_id WHERE m.album_id=? ORDER BY m.created_at,m.user_id LIMIT 1000').bind(albumId).all<{ user_id: number; username: string }>()
  if (!rows.success) throw new Error('Member query failed')
  await getAccessibleAlbum(env, userId, albumId)
  return { members: rows.results }
}

/** Owner removal or self-leave never grants a member upload/write-owner capabilities. */
export async function removeAlbumMember(env: AlbumEnv, userId: number, albumId: string, targetId: number): Promise<{ deleted: true }> {
  integer(targetId, 1, Number.MAX_SAFE_INTEGER)
  const album = await getAccessibleAlbum(env, userId, albumId)
  if (album.owner_id !== userId && targetId !== userId) throw new AlbumError('album_forbidden', '只有相册所有者可以移除其他成员', 403)
  if (targetId === album.owner_id) throw new AlbumError('owner_cannot_leave', '相册所有者不能退出自己的相册', 409)
  await atomic(env, [guard(env, `EXISTS(SELECT 1 FROM albums a WHERE a.id=? AND a.deleted_at IS NULL AND (a.owner_id=? OR (?=? AND a.visibility='shared' AND EXISTS(SELECT 1 FROM album_members WHERE album_id=a.id AND user_id=?))))`, albumId, userId, targetId, userId, userId), env.abdl_space_db.prepare('DELETE FROM album_members WHERE album_id=? AND user_id=?').bind(albumId, targetId)])
  return { deleted: true }
}

/** Soft-delete an owner album immediately, then safely remove storage without ever reclaiming unconfirmed bytes. */
export async function deleteAlbum(env: AlbumEnv, userId: number, albumId: string): Promise<{ deleted: true }> {
  const album = await ownedAlbum(env, userId, albumId)
  if (album.is_default) throw new AlbumError('default_album_immutable', '默认相册不能修改或删除', 409)
  await atomic(env, [ownerGuard(env, userId, albumId), env.abdl_space_db.prepare('UPDATE albums SET deleted_at=unixepoch(),updated_at=unixepoch() WHERE id=? AND owner_id=? AND is_default=0').bind(albumId, userId)])
  await cleanupAlbumObjects(env, userId)
  return { deleted: true }
}

/** Owner-only photo deletion; tombstones/provenance prevent history resurrection. */
export async function deleteAlbumPhoto(env: AlbumEnv, userId: number, photoId: string): Promise<{ deleted: true }> {
  const photo = await accessiblePhoto(env, userId, photoId)
  if (photo.owner_id !== userId) throw new AlbumError('album_forbidden', '只有相册所有者可以删除照片', 403)
  await atomic(env, [ownerGuard(env, userId, photo.album_id), env.abdl_space_db.prepare('UPDATE album_photos SET deleted_at=unixepoch() WHERE id=? AND owner_id=? AND deleted_at IS NULL').bind(photoId, userId)])
  await cleanupAlbumObjects(env, userId)
  return { deleted: true }
}

/** Cancel pending batches; expired reservations remain charged until upload signatures expire and DELETE succeeds. */
export async function expireAlbumBatches(env: AlbumEnv, userId: number): Promise<void> {
  await env.abdl_space_db.prepare(`UPDATE album_batches SET status='cancelled' WHERE owner_id=? AND status='pending' AND expires_at<=unixepoch()`).bind(userId).run()
  await cleanupAlbumObjects(env, userId)
}

/** Bounded private-object cleanup on fixed COS host; retries cannot double-release accounted bytes. */
export async function cleanupAlbumObjects(env: AlbumEnv, userId: number): Promise<void> {
  const rows = await env.abdl_space_db.prepare(`SELECT c.object_key,c.bytes FROM album_object_cleanup c WHERE c.owner_id=? AND c.status='pending'
    AND NOT EXISTS(SELECT 1 FROM album_uploads u WHERE u.object_key=c.object_key AND u.expires_at>=unixepoch()) ORDER BY c.created_at,c.object_key LIMIT 20`).bind(userId).all<{ object_key: string; bytes: number }>()
  if (!rows.success) throw new Error('Cleanup query failed')
  for (const row of rows.results) {
    try {
      privateKey(userId, row.object_key)
      try { await deleteObjectFromCos({ ...cosOptions(env), objectKey: row.object_key, contentType: '' }) }
      catch (error) { if (!(error instanceof CosHttpError && error.status === 404)) throw error }
      await env.abdl_space_db.prepare(`UPDATE album_object_cleanup SET status='cleaned',cleaned_at=unixepoch() WHERE object_key=? AND owner_id=? AND status='pending'
        AND NOT EXISTS(SELECT 1 FROM album_uploads WHERE object_key=? AND expires_at>=unixepoch())`).bind(row.object_key, userId, row.object_key).run()
    } catch { console.error(JSON.stringify({ event: 'album_object_cleanup_deferred' })) }
  }
}
