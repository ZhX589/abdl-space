import type { Context } from 'hono'
import { PhotonImage, SamplingFilter, resize } from '@cf-wasm/photon'
import type { Env, JWTPayload } from '../types/index.ts'
import type { AlbumImportResponse } from '../types/albums.ts'
import { cancelAlbumHistoryReservation, ensureDefaultAlbum, getAlbumStorageQuota, publishReservedAlbumHistoryPhoto, reserveAlbumHistoryPhoto, type AlbumEnv } from './albums.ts'
import { query, queryOne, run } from './db.ts'
import { inspectMediaImageDimensions } from './media-preview.ts'
import { buildCosObjectUrl, createCosGetAuthorization, createCosPutAuthorization, md5Base64 } from './tencent-cos.ts'

const HD_MAX = 10 * 1024 * 1024
const PREVIEW_MAX = 2 * 1024 * 1024
const IMPORT_LIMIT = 4
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
type ImportEnv = AlbumEnv
type ImportApp = { Bindings: Env; Variables: { user: JWTPayload } }

/** Server-only options; callers cannot choose a URL, destination key or quota. */
export interface AlbumHistoryOptions { postId?: number; limit?: number }
interface HistoryImage {
  id: number; user_id: number; post_id: number; image_url: string; preview_url: string | null
  content: string; created_at: string
}
interface HistoryUpload {
  id: string; user_id: number; purpose: string; storage_provider: string; status: string
  object_key: string; public_url: string; mime_type: string; verified_size: number | null; declared_size: number
  width: number | null; height: number | null; preview_upload_id: string | null; preview_object_key: string | null; preview_url: string | null
}
interface VerifiedImage { bytes: Uint8Array; mimeType: string; width: number; height: number }
class HistorySkip extends Error {
  readonly reason: string
  readonly retry: boolean
  constructor(reason: string, retry = false) { super(reason); this.reason = reason; this.retry = retry }
}

/** Verify a source against the exact configured COS API host and canonical owned object key.
 * Public CDN aliases, redirects, query transforms, credentials and encoded path tricks are not accepted.
 */
export function isVerifiedHistoryCosUrl(env: Pick<Env, 'COS_BUCKET' | 'COS_REGION'>, url: string, objectKey: string): boolean {
  try {
    if (!env.COS_BUCKET || !env.COS_REGION) return false
    const expected = buildCosObjectUrl(objectKey, { bucket: env.COS_BUCKET, region: env.COS_REGION })
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port && !parsed.search && !parsed.hash
      && parsed.href === expected && url === expected
  } catch { return false }
}

function ownedUpload(env: ImportEnv, upload: HistoryUpload, userId: number, preview: boolean): void {
  const prefix = preview ? `media/preview/${userId}/` : upload.purpose === 'generic' ? `generic/${userId}/` : `media/original/${userId}/`
  const max = preview ? PREVIEW_MAX : HD_MAX
  if (upload.user_id !== userId || upload.status !== 'complete' || upload.storage_provider !== 'cos'
    || (preview ? upload.purpose !== 'status_preview' : !['status_original', 'generic'].includes(upload.purpose))
    || !upload.object_key.startsWith(prefix) || !isVerifiedHistoryCosUrl(env, upload.public_url, upload.object_key)
    || !IMAGE_TYPES.has(upload.mime_type) || !Number.isSafeInteger(upload.verified_size) || Number(upload.verified_size) <= 0
    || Number(upload.verified_size) > max || upload.verified_size !== upload.declared_size
    || !Number.isSafeInteger(upload.width) || !Number.isSafeInteger(upload.height) || Number(upload.width) <= 0 || Number(upload.height) <= 0
    || (preview && (Math.max(Number(upload.width), Number(upload.height)) > 540 || !['image/jpeg', 'image/webp'].includes(upload.mime_type)))) {
    throw new HistorySkip(preview ? 'unverified_preview' : 'unverified_source')
  }
}

function boundedHistoryDimensions(width: number, height: number): { width: number; height: number } | null {
  // Keep the shared inspector's decoder safety ceiling for every WebP container variant.
  return width >= 1 && height >= 1 && width <= 8192 && height <= 8192 && width * height <= 12_000_000
    ? { width, height } : null
}

function historyImageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const known = inspectMediaImageDimensions(bytes)
  if (known) return known
  // Android WEBP_LOSSLESS previews use simple VP8L; simple lossy WebP uses VP8, not VP8X.
  if (bytes.length < 25 || new TextDecoder().decode(bytes.subarray(0, 4)) !== 'RIFF'
    || new TextDecoder().decode(bytes.subarray(8, 12)) !== 'WEBP') return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(4, true) + 8 !== bytes.byteLength) return null
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = new TextDecoder().decode(bytes.subarray(offset, offset + 4))
    const size = view.getUint32(offset + 4, true)
    const start = offset + 8
    if (size > bytes.length - start || size + (size % 2) > bytes.length - start) return null
    if (kind === 'VP8X' && size >= 10) {
      return boundedHistoryDimensions(1 + bytes[start + 4] + (bytes[start + 5] << 8) + (bytes[start + 6] << 16),
        1 + bytes[start + 7] + (bytes[start + 8] << 8) + (bytes[start + 9] << 16))
    }
    if (kind === 'VP8L' && size >= 5 && bytes[start] === 0x2f) {
      const bits = view.getUint32(start + 1, true)
      if (bits >>> 29 !== 0) return null // Only the defined lossless bitstream version is valid.
      return boundedHistoryDimensions(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff))
    }
    if (kind === 'VP8 ' && size >= 10 && (bytes[start] & 1) === 0 && bytes[start + 3] === 0x9d
      && bytes[start + 4] === 0x01 && bytes[start + 5] === 0x2a) {
      return boundedHistoryDimensions(view.getUint16(start + 6, true) & 0x3fff, view.getUint16(start + 8, true) & 0x3fff)
    }
    offset = start + size + (size % 2)
  }
  return null
}

function signal(deadline: number): AbortSignal {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new HistorySkip('deadline', true)
  return AbortSignal.timeout(Math.min(5000, remaining))
}

async function readVerifiedImage(env: ImportEnv, upload: HistoryUpload, max: number, deadline: number): Promise<VerifiedImage> {
  // Build the request from the proven object key, never from post/user URLs.
  const authorization = await createCosGetAuthorization({
    secretId: env.COS_SECRET_ID, secretKey: env.COS_SECRET_KEY, bucket: env.COS_BUCKET, region: env.COS_REGION,
    objectKey: upload.object_key, contentType: upload.mime_type,
  })
  const url = buildCosObjectUrl(upload.object_key, { bucket: env.COS_BUCKET, region: env.COS_REGION })
  const response = await fetch(url, { headers: authorization.headers, redirect: 'manual', signal: signal(deadline) })
  if (!response.ok || response.redirected) {
    await response.body?.cancel()
    throw new HistorySkip(response.status === 404 ? 'source_missing' : 'source_unavailable', true)
  }
  const mimeType = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()
  const length = response.headers.get('Content-Length')
  if (mimeType !== upload.mime_type || !response.body || (length !== null && (!/^[0-9]+$/.test(length) || Number(length) !== upload.verified_size || Number(length) > max))) {
    await response.body?.cancel()
    throw new HistorySkip('source_integrity')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  const state = { total: 0 }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      state.total += value.byteLength
      if (state.total > max || state.total > Number(upload.verified_size)) {
        await reader.cancel()
        throw new HistorySkip('source_too_large')
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  if (state.total !== upload.verified_size || state.total === 0) throw new HistorySkip('source_integrity')
  const bytes = new Uint8Array(state.total)
  const position = { offset: 0 }
  for (const chunk of chunks) { bytes.set(chunk, position.offset); position.offset += chunk.byteLength }
  const dimensions = historyImageDimensions(bytes)
  if (!dimensions || dimensions.width !== upload.width || dimensions.height !== upload.height) throw new HistorySkip('source_dimensions')
  return { bytes, mimeType, ...dimensions }
}

function generatePreview(image: VerifiedImage): VerifiedImage {
  // Decode only the already bounded, dimension-checked owned HD bytes. No remote preview service/URL.
  const handles: { source?: PhotonImage; preview?: PhotonImage } = {}
  try {
    handles.source = PhotonImage.new_from_byteslice(image.bytes)
    const width = handles.source.get_width()
    const height = handles.source.get_height()
    if (width !== image.width || height !== image.height) throw new HistorySkip('source_dimensions')
    const scale = Math.min(1, 540 / Math.max(width, height))
    const dimensions = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
    handles.preview = resize(handles.source, dimensions.width, dimensions.height, SamplingFilter.Lanczos3)
    const bytes = handles.preview.get_bytes_jpeg(75)
    if (!bytes.byteLength || bytes.byteLength > PREVIEW_MAX) throw new HistorySkip('preview_too_large')
    return { bytes, mimeType: 'image/jpeg', ...dimensions }
  } catch (error) { throw error instanceof HistorySkip ? error : new HistorySkip('preview_decode_failed') }
  finally { handles.preview?.free(); handles.source?.free() }
}

async function copyPrivateImage(env: ImportEnv, userId: number, key: string, image: VerifiedImage, deadline: number): Promise<void> {
  const upload = await queryOne<{ expires_at: number }>(env.abdl_space_db,
    "SELECT expires_at FROM album_uploads WHERE object_key=? AND owner_id=? AND status='pending'", [key, userId])
  const now = Math.floor(Date.now() / 1000)
  if (!upload || upload.expires_at <= now) throw new HistorySkip('copy_expired', true)
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', image.bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
  const authorization = await createCosPutAuthorization({
    secretId: env.COS_SECRET_ID, secretKey: env.COS_SECRET_KEY, bucket: env.COS_BUCKET, region: env.COS_REGION,
    objectKey: key, contentType: image.mimeType, contentLength: image.bytes.byteLength, contentMd5: md5Base64(image.bytes),
    metadataSha256: sha256, objectAcl: 'private', now: new Date(now * 1000), expiresInSeconds: Math.min(300, upload.expires_at - now),
  })
  const response = await fetch(authorization.url, { method: 'PUT', headers: authorization.headers, body: image.bytes, redirect: 'manual', signal: signal(deadline) })
  await response.body?.cancel()
  if (!response.ok || response.redirected) throw new HistorySkip('copy_unavailable', true)
}

async function recordAttempt(env: ImportEnv, userId: number, imageId: number, reason: string, retry: boolean): Promise<void> {
  await run(env.abdl_space_db, `INSERT INTO album_history_attempts(owner_id,source_post_image_id,outcome,reason,retry_at,attempted_at)
    VALUES(?,?,?,?,?,unixepoch()) ON CONFLICT(owner_id,source_post_image_id) DO UPDATE SET
    outcome=excluded.outcome,reason=excluded.reason,retry_at=excluded.retry_at,attempted_at=excluded.attempted_at`,
  [userId, imageId, retry ? 'retry' : 'skipped', reason, retry ? Math.floor(Date.now() / 1000) + 60 : 0])
}

async function importImage(env: ImportEnv, userId: number, image: HistoryImage, deadline: number): Promise<boolean> {
  const uploads = await query<HistoryUpload>(env.abdl_space_db, `SELECT * FROM media_uploads
    WHERE user_id=? AND public_url=? AND status='complete' AND purpose IN ('status_original','generic') ORDER BY id LIMIT 2`, [userId, image.image_url])
  if (uploads.length !== 1 || image.user_id !== userId) throw new HistorySkip('no_owned_upload')
  const upload = uploads[0]
  // A crash after PUT may leave a fully copied pending reservation. Recover it before generating
  // any new keys; missing partial copies are cancelled only after the old signature has expired.
  const pending = await queryOne<{ id: string; expires_at: number; status: string }>(env.abdl_space_db,
    "SELECT id,status,expires_at FROM album_batches WHERE owner_id=? AND source_post_image_id=? AND status!='cancelled'", [userId, image.id])
  if (pending) {
    if (pending.status === 'published') return false
    try { return (await publishReservedAlbumHistoryPhoto(env, userId, pending.id)).inserted }
    catch {
      if (pending.expires_at <= Math.floor(Date.now() / 1000)) await cancelAlbumHistoryReservation(env, userId, pending.id)
      throw new HistorySkip('import_in_progress', true)
    }
  }
  ownedUpload(env, upload, userId, false)
  const previewUrl = image.preview_url || upload.preview_url
  const previewUpload = previewUrl ? await queryOne<HistoryUpload>(env.abdl_space_db,
    'SELECT * FROM media_uploads WHERE public_url=? AND user_id=? AND purpose=? AND status=?', [previewUrl, userId, 'status_preview', 'complete']) : null
  if (previewUrl) {
    if (!previewUpload || (upload.preview_url && previewUrl !== upload.preview_url)
      || (upload.preview_upload_id && upload.preview_upload_id !== previewUpload.id)
      || (upload.preview_object_key && upload.preview_object_key !== previewUpload.object_key)) throw new HistorySkip('unverified_preview')
    ownedUpload(env, previewUpload, userId, true)
  }
  const quota = await getAlbumStorageQuota(env, userId)
  // Cheap precheck avoids copies when already full; helper rechecks live quota atomically at publication.
  if (quota.remaining_bytes < Number(upload.verified_size) + (previewUpload?.verified_size ?? 1)) throw new HistorySkip('storage_full', true)
  const hd = await readVerifiedImage(env, upload, HD_MAX, deadline)
  const preview = previewUpload ? await readVerifiedImage(env, previewUpload, PREVIEW_MAX, deadline) : generatePreview(hd)
  if (Math.max(preview.width, preview.height) > 540) throw new HistorySkip('preview_dimensions')
  const keyPrefix = `albums/${userId}/history/${crypto.randomUUID()}`
  const previewKey = `${keyPrefix}/preview`
  const hdKey = `${keyPrefix}/hd`
  const parsedDate = Date.parse(image.created_at.includes('T') ? image.created_at : `${image.created_at.replace(' ', 'T')}Z`)
  const uploadedAt = Number.isFinite(parsedDate) && parsedDate > 0 ? Math.floor(parsedDate / 1000) : Math.floor(Date.now() / 1000)
  const reservation = await reserveAlbumHistoryPhoto(env, userId, {
    sourcePostImageId: image.id, sourceUploadId: upload.id, previewKey, hdKey,
    previewBytes: preview.bytes.byteLength, hdBytes: hd.bytes.byteLength, width: hd.width, height: hd.height,
    description: image.content.slice(0, 3000), capturedAt: null, uploadedAt,
    previewMimeType: preview.mimeType, hdMimeType: hd.mimeType, previewMd5: md5Base64(preview.bytes), hdMd5: md5Base64(hd.bytes),
  })
  if (reservation.published) return false
  if (!reservation.created) throw new HistorySkip('import_in_progress', true)
  try {
    // Immutable keys and byte reservations exist transactionally before any PUT is authorized.
    await copyPrivateImage(env, userId, reservation.preview_key, preview, deadline)
    await copyPrivateImage(env, userId, reservation.hd_key, hd, deadline)
    const result = await publishReservedAlbumHistoryPhoto(env, userId, reservation.batch_id)
    return result.inserted
  } catch (error) {
    // Only a pending batch is cancelled. Ambiguous committed publication is untouched; failed copies
    // retain a durable cleanup reservation until the PUT signature expires and fixed-host DELETE succeeds.
    try { await cancelAlbumHistoryReservation(env, userId, reservation.batch_id) }
    catch { console.warn(JSON.stringify({ event: 'album_history_cancel_unavailable', user_id: userId })) }
    throw error
  }
}

/** Import a bounded retryable page of proven same-owner post images into separate private objects.
 * Terminal skip evidence avoids starvation; transient/expired capacity is retried after a short backoff.
 */
export async function importAlbumHistory(env: ImportEnv, userId: number, options: AlbumHistoryOptions = {}): Promise<AlbumImportResponse> {
  if (!Number.isSafeInteger(userId) || userId <= 0 || (options.postId !== undefined && (!Number.isSafeInteger(options.postId) || options.postId <= 0))) throw new Error('Invalid album history owner/post')
  const limit = Math.min(IMPORT_LIMIT, Math.max(1, Number.isSafeInteger(options.limit) ? options.limit! : IMPORT_LIMIT))
  await ensureDefaultAlbum(env, userId)
  const deadline = Date.now() + 20_000
  const images = await query<HistoryImage>(env.abdl_space_db, `SELECT i.id,p.user_id,p.id AS post_id,i.image_url,i.preview_url,p.content,p.created_at
    FROM post_images i JOIN posts p ON p.id=i.post_id
    WHERE p.user_id=? AND (? IS NULL OR p.id=?)
    AND NOT EXISTS(SELECT 1 FROM album_photos f WHERE f.source_post_image_id=i.id)
    AND NOT EXISTS(SELECT 1 FROM album_history_attempts h WHERE h.owner_id=? AND h.source_post_image_id=i.id AND (h.outcome='skipped' OR h.retry_at>unixepoch()))
    ORDER BY i.id DESC LIMIT ?`, [userId, options.postId ?? null, options.postId ?? null, userId, limit + 1])
  const counts = { imported: 0, skipped: 0, remaining: images.length > limit }
  for (const image of images.slice(0, limit)) {
    if (Date.now() >= deadline) { counts.remaining = true; break }
    try {
      if (await importImage(env, userId, image, deadline)) counts.imported++
      else counts.skipped++
      await run(env.abdl_space_db, 'DELETE FROM album_history_attempts WHERE owner_id=? AND source_post_image_id=?', [userId, image.id])
    } catch (error) {
      const known = error instanceof HistorySkip
      const reason = known ? error.reason : 'import_unavailable'
      const retry = known ? error.retry : true
      await recordAttempt(env, userId, image.id, reason, retry)
      counts.skipped++
      if (retry) counts.remaining = true
      if (!known) console.warn(JSON.stringify({ event: 'album_history_image_unavailable', user_id: userId, source_post_image_id: image.id }))
    }
  }
  // Include delayed retry work, even when no eligible rows were returned this invocation.
  const outstanding = await queryOne<{ pending: number }>(env.abdl_space_db, `SELECT EXISTS(SELECT 1 FROM post_images i JOIN posts p ON p.id=i.post_id
    WHERE p.user_id=? AND NOT EXISTS(SELECT 1 FROM album_photos f WHERE f.source_post_image_id=i.id)
    AND NOT EXISTS(SELECT 1 FROM album_history_attempts h WHERE h.owner_id=? AND h.source_post_image_id=i.id AND h.outcome='skipped')) AS pending`, [userId, userId])
  return { ...counts, remaining: !!outstanding?.pending || counts.remaining }
}

/** Nonblocking post hooks/own-album GET retries must register this promise with executionCtx.waitUntil. */
export async function bestEffortImportAlbumHistory(env: ImportEnv, userId: number, options: AlbumHistoryOptions = {}): Promise<void> {
  try { await importAlbumHistory(env, userId, options) }
  catch { console.warn(JSON.stringify({ event: 'album_history_unavailable', user_id: userId })) }
}

/** Core albums router registers this authenticated, no-store POST /import-history handler. */
export async function importAlbumHistoryHandler(c: Context<ImportApp>): Promise<Response> {
  c.header('Cache-Control', 'private, no-store')
  if (c.req.method !== 'POST') return c.json({ error: 'Invalid method', code: 'invalid_request' }, 405)
  const user = c.get('user')
  if (!user || !Number.isSafeInteger(user.sub) || user.sub <= 0) return c.json({ error: '请先登录', code: 'unauthenticated' }, 401)
  // No URL/id/capacity inputs; only a tiny empty object is permitted, even without body middleware.
  const reader = c.req.raw.body?.getReader()
  const state = { text: '', bytes: 0 }
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        state.bytes += value.byteLength
        if (state.bytes > 1024) { await reader.cancel(); return c.json({ error: '请求内容过大', code: 'invalid_request' }, 413) }
        state.text += new TextDecoder().decode(value)
      }
      const body: unknown = state.text.trim() ? JSON.parse(state.text) : {}
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) return c.json({ error: '请求格式不正确', code: 'invalid_request' }, 400)
    } catch { return c.json({ error: '请求格式不正确', code: 'invalid_request' }, 400) }
    finally { reader.releaseLock() }
  }
  try { return c.json(await importAlbumHistory(c.env, user.sub)) }
  catch {
    console.warn(JSON.stringify({ event: 'album_history_request_unavailable', user_id: user.sub }))
    return c.json({ error: '相册历史导入暂不可用，请稍后重试', code: 'albums_unavailable' }, 503)
  }
}
