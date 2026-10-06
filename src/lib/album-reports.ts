import type { D1PreparedStatement } from '@cloudflare/workers-types'
import type { AdminReportAlbum, AdminReportPhoto, AlbumReport, AlbumReportDetail, AlbumReportListItem, AlbumReportListResponse, AlbumReportReason, AlbumReportResolveResponse, AlbumPhotoBlockResponse, AlbumVisibility } from '../types/albums.ts'
import { AlbumError, getAccessibleAlbum } from './albums.ts'
import type { AlbumEnv } from './albums.ts'
import { sponsorHash } from './sponsors.ts'
import { createCosGetAuthorization } from './tencent-cos.ts'

const READ_TTL = 60
const REPORT_LIMIT = 10
const REPORT_WINDOW = 3600
const MAX_BLOCK_PHOTOS = 20
const MAX_DETAIL_PHOTOS = 500
const REASONS: readonly string[] = ['spam', 'nsfw', 'minor', 'copyright', 'other']

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AlbumError('invalid_request', '请求格式不正确')
  return value as Record<string, unknown>
}
function allowedKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new AlbumError('invalid_request', '请求包含不支持的字段')
}
function boundedText(value: unknown, maximum: number, field: string): string {
  // eslint-disable-next-line no-control-regex -- report text accepts newlines but not hidden controls
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new AlbumError('invalid_request', `${field}格式不正确`)
  return value.trim()
}
function optionalDetail(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return boundedText(value, 2000, 'detail') || null
}
function identifier(value: unknown, field: string): string {
  const text = boundedText(value, 80, field)
  if (!text) throw new AlbumError('invalid_request', `${field}格式不正确`)
  return text
}
function operation(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new AlbumError('invalid_request', 'operation_id 必须为 UUID')
  return value.toLowerCase()
}

interface AlbumReportRow {
  id: string; album_id: string; reporter_id: number; reason: AlbumReportReason; detail: string | null
  status: 'open' | 'resolved'; created_at: number; resolved_at: number | null
}
interface AlbumReportListItemRow extends AlbumReportRow { album_name: string; owner_id: number; blocked_photo_count: number; album_photo_count: number }

function reportDto(row: AlbumReportRow): AlbumReport {
  return { id: row.id, album_id: row.album_id, reporter_id: row.reporter_id, reason: row.reason, detail: row.detail, status: row.status, created_at: row.created_at, resolved_at: row.resolved_at }
}
function itemDto(row: AlbumReportListItemRow): AlbumReportListItem {
  return { ...reportDto(row), album_name: row.album_name, owner_id: row.owner_id, blocked_photo_count: row.blocked_photo_count, album_photo_count: row.album_photo_count }
}

/** List item projection with album context and moderation counts; total photos stay counted, blocks are separate. */
const ITEM_SELECT = `SELECT r.id,r.album_id,r.reporter_id,r.reason,r.detail,r.status,r.created_at,r.resolved_at,
  a.name AS album_name,a.owner_id,
  (SELECT count(*) FROM album_photo_blocks b WHERE b.album_id=r.album_id) AS blocked_photo_count,
  (SELECT count(*) FROM album_photos p WHERE p.album_id=r.album_id AND p.deleted_at IS NULL) AS album_photo_count
  FROM album_reports r JOIN albums a ON a.id=r.album_id`

/** A per-user durable hourly limit shared with the album rate-limit storage; no process-local state. */
async function enforceReportRateLimit(env: AlbumEnv, userId: number): Promise<void> {
  const row = await env.abdl_space_db.prepare(`INSERT INTO album_rate_limits(bucket,window_start,count) VALUES(?,unixepoch(),1)
    ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN window_start<=unixepoch()-${REPORT_WINDOW} THEN 1 ELSE count+1 END,
    window_start=CASE WHEN window_start<=unixepoch()-${REPORT_WINDOW} THEN unixepoch() ELSE window_start END RETURNING count`).bind(`user:${userId}:album-report`).first<{ count: number }>()
  if (!row || row.count > REPORT_LIMIT) throw new AlbumError('rate_limited', '举报操作过于频繁，请稍后重试', 429)
}

function guard(env: AlbumEnv, sql: string, ...params: Array<string | number | null>): D1PreparedStatement {
  return env.abdl_space_db.prepare(`INSERT INTO album_transaction_guards(id) SELECT CASE WHEN (${sql}) THEN 1 ELSE 0 END ON CONFLICT(id) DO UPDATE SET id=excluded.id`).bind(...params)
}
async function atomic(env: AlbumEnv, statements: D1PreparedStatement[], conflictCode = 'album_conflict'): Promise<void> {
  try {
    const results = await env.abdl_space_db.batch(statements)
    if (results.some(result => !result.success)) throw new AlbumError('albums_unavailable', '数据库操作未成功', 503)
  } catch (error) {
    if (error instanceof AlbumError) throw error
    if (error instanceof Error && /album_transaction_guards|CHECK constraint failed: id=1/.test(error.message)) throw new AlbumError(conflictCode, '权限或内容状态已变更，请刷新后重试', 409)
    throw error
  }
}

/** Admin 60-second preview signing; never HD/original and never a client-minted token. */
async function signAdminPreview(env: AlbumEnv, ownerId: number, key: string): Promise<string> {
  const { COS_SECRET_ID: secretId, COS_SECRET_KEY: secretKey, COS_BUCKET: bucket, COS_REGION: region } = env
  if (!secretId || !secretKey || !bucket || !region) throw new AlbumError('private_storage_unavailable', '相册私有存储暂不可用', 503)
  // eslint-disable-next-line no-control-regex -- guard mirrors the album signer's server-owned COS path rules
  if (!key.startsWith(`albums/${ownerId}/`) || key.includes('..') || /[\\?#\u0000-\u001f]/.test(key) || key.includes('//') || key.endsWith('/')) throw new AlbumError('invalid_private_key', '相册对象不是受管理私有对象', 422)
  const result = await createCosGetAuthorization({ secretId, secretKey, bucket, region, objectKey: key, contentType: '', expiresInSeconds: READ_TTL })
  return result.url
}

async function reportListItem(env: AlbumEnv, reportId: string): Promise<AlbumReportListItem | null> {
  return env.abdl_space_db.prepare(`${ITEM_SELECT} WHERE r.id=?`).bind(reportId).first<AlbumReportListItemRow>()
}
async function existingReport(env: AlbumEnv, reportId: string): Promise<AlbumReportListItem> {
  const row = await reportListItem(env, reportId)
  if (!row) throw new AlbumError('report_not_found', '举报不存在', 404)
  return row
}

/** Submit one album report from a currently ACL-accessible non-owned album; idempotent per operation and open report. */
export async function createAlbumReport(env: AlbumEnv, userId: number, albumId: string, input: unknown): Promise<AlbumReport> {
  const value = object(input); allowedKeys(value, ['reason', 'detail', 'operation_id'])
  if (!REASONS.includes(value.reason as string)) throw new AlbumError('invalid_request', '举报原因不正确')
  const detail = optionalDetail(value.detail)
  const operationId = operation(value.operation_id)
  await enforceReportRateLimit(env, userId)
  // Only a currently accessible album (owner, public or shared membership) can be reported.
  const album = await getAccessibleAlbum(env, userId, albumId)
  if (album.owner_id === userId) throw new AlbumError('album_report_self_forbidden', '不能举报自己的相册', 403)
  const hash = await sponsorHash(JSON.stringify([album.id, value.reason, detail]))
  const previous = await env.abdl_space_db.prepare('SELECT id,album_id,request_hash,status FROM album_reports WHERE operation_id=?').bind(operationId).first<{ id: string; album_id: string; request_hash: string; status: string }>()
  if (previous) {
    if (previous.album_id === album.id && previous.request_hash === hash && previous.status === 'open') return reportDto(await existingReport(env, previous.id))
    throw new AlbumError('idempotency_conflict', '操作编号已用于其他举报', 409)
  }
  const open = await env.abdl_space_db.prepare(`SELECT id FROM album_reports WHERE album_id=? AND reporter_id=? AND status='open'`).bind(album.id, userId).first<{ id: string }>()
  if (open) throw new AlbumError('duplicate_open', '您已举报过该相册，请等待处理', 409)
  await env.abdl_space_db.prepare(`INSERT INTO album_reports(id,album_id,reporter_id,reason,detail,operation_id,request_hash) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`).bind(crypto.randomUUID(), album.id, userId, value.reason, detail, operationId, hash).run()
  const inserted = await env.abdl_space_db.prepare(`SELECT id FROM album_reports WHERE album_id=? AND reporter_id=? AND status='open'`).bind(album.id, userId).first<{ id: string }>()
  if (!inserted) throw new AlbumError('album_conflict', '举报状态已变更，请刷新后重试', 409)
  return reportDto(await existingReport(env, inserted.id))
}

/** Paginate reports for the admin console; status filters honoured by total, newest first. */
export async function listAlbumReports(env: AlbumEnv, options: { status: 'open' | 'resolved' | 'all'; limit: number; offset: number }): Promise<AlbumReportListResponse> {
  const where = options.status === 'all' ? '' : ' WHERE r.status=?'
  const params: Array<string | number> = options.status === 'all' ? [] : [options.status]
  const rows = await env.abdl_space_db.prepare(`${ITEM_SELECT}${where} ORDER BY r.created_at DESC,r.id DESC LIMIT ? OFFSET ?`).bind(...params, options.limit, options.offset).all<AlbumReportListItemRow>()
  if (!rows.success) throw new Error('Report query failed')
  const total = await env.abdl_space_db.prepare(`SELECT count(*) AS total FROM album_reports r${where}`).bind(...params).first<{ total: number }>()
  return { reports: rows.results.map(itemDto), total: total?.total ?? 0 }
}

/** Full admin review payload; previews are signed 60s only for unblocked photos and originals are never exposed. */
export async function getAlbumReportDetail(env: AlbumEnv, reportId: string): Promise<AlbumReportDetail> {
  const row = await env.abdl_space_db.prepare(`SELECT r.*,a.name AS album_name,a.owner_id,a.visibility,a.is_default,a.created_at AS album_created_at,
    coalesce((SELECT download_protected FROM album_protection WHERE album_id=r.album_id),0) AS download_protected,
    (SELECT count(*) FROM album_photo_blocks b WHERE b.album_id=r.album_id) AS blocked_photo_count,
    (SELECT count(*) FROM album_photos p WHERE p.album_id=r.album_id AND p.deleted_at IS NULL) AS album_photo_count
    FROM album_reports r JOIN albums a ON a.id=r.album_id WHERE r.id=?`).bind(reportId).first<AlbumReportListItemRow & { visibility: AlbumVisibility; is_default: number; album_created_at: number; download_protected: number }>()
  if (!row) throw new AlbumError('report_not_found', '举报不存在', 404)
  const photos = await env.abdl_space_db.prepare(`SELECT p.id,p.description,p.width,p.height,p.captured_at,p.uploaded_at,p.preview_key,
    EXISTS(SELECT 1 FROM album_photo_blocks b WHERE b.album_id=p.album_id AND b.photo_id=p.id) AS admin_blocked
    FROM album_photos p WHERE p.album_id=? AND p.deleted_at IS NULL
    ORDER BY coalesce(p.captured_at,p.uploaded_at) DESC,p.uploaded_at DESC,p.id DESC LIMIT ${MAX_DETAIL_PHOTOS}`).bind(row.album_id).all<{ id: string; description: string; width: number; height: number; captured_at: number | null; uploaded_at: number; preview_key: string; admin_blocked: number }>()
  if (!photos.success) throw new Error('Admin photo query failed')
  const projected: AdminReportPhoto[] = await Promise.all(photos.results.map(async photo => ({
    id: photo.id, description: photo.description, width: photo.width, height: photo.height, captured_at: photo.captured_at, uploaded_at: photo.uploaded_at,
    admin_blocked: !!photo.admin_blocked,
    preview_url: photo.admin_blocked ? null : await signAdminPreview(env, row.owner_id, photo.preview_key),
  })))
  const album: AdminReportAlbum = {
    id: row.album_id, name: row.album_name, visibility: row.visibility, owner_id: row.owner_id, is_default: !!row.is_default,
    // Summary count excludes blocked photos; the report item keeps the total plus a separate block count.
    photo_count: row.album_photo_count - row.blocked_photo_count, created_at: row.album_created_at, download_protected: !!row.download_protected,
  }
  return { report: itemDto(row), album, photos: projected, download_protected: !!row.download_protected }
}

/** Replace the album's blocked-photo desired state; blocked photos stay stored and unblock is an empty list. */
export async function blockAlbumPhotos(env: AlbumEnv, adminId: number, reportId: string, input: unknown): Promise<AlbumPhotoBlockResponse> {
  const value = object(input); allowedKeys(value, ['photo_ids', 'operation_id'])
  if (!Array.isArray(value.photo_ids) || value.photo_ids.length > MAX_BLOCK_PHOTOS) throw new AlbumError('invalid_request', '照片列表不正确')
  const photoIds = value.photo_ids.map(item => identifier(item, 'photo_id'))
  if (new Set(photoIds).size !== photoIds.length) throw new AlbumError('invalid_request', '照片列表不能重复')
  if (value.operation_id !== undefined) operation(value.operation_id)
  const report = await env.abdl_space_db.prepare('SELECT id,album_id FROM album_reports WHERE id=?').bind(reportId).first<{ id: string; album_id: string }>()
  if (!report) throw new AlbumError('report_not_found', '举报不存在', 404)
  if (photoIds.length) {
    const known = await env.abdl_space_db.prepare(`SELECT count(*) AS n FROM album_photos WHERE album_id=? AND deleted_at IS NULL AND id IN (${photoIds.map(() => '?').join(',')})`).bind(report.album_id, ...photoIds).first<{ n: number }>()
    if ((known?.n ?? 0) !== photoIds.length) throw new AlbumError('invalid_request', '照片不属于此相册或不存在')
  }
  await atomic(env, [
    guard(env, 'EXISTS(SELECT 1 FROM album_reports WHERE id=?)', reportId),
    env.abdl_space_db.prepare('DELETE FROM album_photo_blocks WHERE album_id=?').bind(report.album_id),
    ...photoIds.map(photoId => env.abdl_space_db.prepare('INSERT INTO album_photo_blocks(album_id,photo_id,admin_id) VALUES(?,?,?) ON CONFLICT(album_id,photo_id) DO NOTHING').bind(report.album_id, photoId, adminId)),
  ])
  const rows = await env.abdl_space_db.prepare('SELECT photo_id FROM album_photo_blocks WHERE album_id=? ORDER BY photo_id').bind(report.album_id).all<{ photo_id: string }>()
  if (!rows.success) throw new Error('Block query failed')
  return { blocked_photo_ids: rows.results.map(row => row.photo_id) }
}

/** Mark a report resolved; the first resolution timestamp and actor win, later calls are idempotent reads. */
export async function resolveAlbumReport(env: AlbumEnv, adminId: number, reportId: string): Promise<AlbumReportResolveResponse> {
  const report = await env.abdl_space_db.prepare('SELECT id,status FROM album_reports WHERE id=?').bind(reportId).first<{ id: string; status: string }>()
  if (!report) throw new AlbumError('report_not_found', '举报不存在', 404)
  if (report.status === 'open') {
    await atomic(env, [
      guard(env, `EXISTS(SELECT 1 FROM album_reports WHERE id=? AND status='open')`, reportId),
      env.abdl_space_db.prepare(`UPDATE album_reports SET status='resolved',resolved_at=unixepoch(),resolved_by=? WHERE id=? AND status='open'`).bind(adminId, reportId),
    ])
  }
  return { report: await existingReport(env, reportId) }
}
