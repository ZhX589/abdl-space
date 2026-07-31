import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Env } from '../types/index.ts'
import { queryOne, run } from '../lib/db.ts'
import { mastodonAuthDetails } from '../mastodon/shared.ts'
import { getCompletedUploadReference, uploadLegacyObject } from '../lib/upload-consumer.ts'
import { canUploadRelease } from './uploads.ts'

type AppType = { Bindings: Env }

const version = new Hono<AppType>()

// CORS for version API (browser access from abdl-space.top)
version.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Upload-Key'],
}))

const IMGBED_FALLBACK_HEADER = 'X-ABDL-Upload-Fallback'

export function resolveReleaseUpload(db: D1Database, reference: string, userId: number) {
  return getCompletedUploadReference(db, reference, userId, 'release')
}

/**
 * GET /api/v1/version — 获取最新版本信息
 */
version.get('/', async (c) => {
  const db = c.env.abdl_space_db

  const latest = await queryOne<{
    value: string
  }>(db, `SELECT value FROM kv_store WHERE key = 'app_version_latest'`)

  if (!latest) {
    return c.json({ hasUpdate: false, message: '暂无版本信息' })
  }

  try {
    const info = JSON.parse(latest.value)
    return c.json({
      hasUpdate: true,
      versionName: info.versionName,
      versionCode: info.versionCode,
      downloadUrl: info.downloadUrl,
      changelog: info.changelog || '',
      releasedAt: info.releasedAt || '',
      apkSize: info.apkSize || 0,
    })
  } catch {
    return c.json({ hasUpdate: false, message: '版本信息格式错误' })
  }
})

/**
 * POST /api/v1/version/upload — 上传新版本安装包并更新版本信息
 * Body: multipart/form-data
 * - apk: File
 * - versionName: string
 * - versionCode: number
 * - changelog: string (optional)
 */
version.post('/upload', async (c) => {
  try {
  const db = c.env.abdl_space_db
  const auth = await mastodonAuthDetails(c)
  if (!auth) return c.json({ error: 'Authentication required' }, 401)
  if (!await canUploadRelease(db, auth)) return c.json({ error: 'Admin access required' }, 403)

  let versionName = ''
  let versionCode = 0
  let changelog = ''
  let apkUrl = ''
  let apkSize = 0
  let apk: File | null = null
  let uploadId = ''

  const contentType = c.req.header('Content-Type') || ''

  if (contentType.includes('multipart/form-data')) {
    const formData = await c.req.formData()
    versionName = formData.get('versionName') as string || ''
    versionCode = parseInt(formData.get('versionCode') as string) || 0
    changelog = formData.get('changelog') as string || ''

    apk = formData.get('apk') instanceof File ? formData.get('apk') as File : null
    if (apk) {
      const upload = await uploadLegacyObject(c.env, auth.user.sub, 'release', apk, c.req.header(IMGBED_FALLBACK_HEADER) === 'imgbed')
      uploadId = upload.id
      apkUrl = upload.public_url
      apkSize = upload.verified_size || upload.declared_size
    }
  } else {
    try {
      const body = await c.req.json()
      versionName = body.versionName || ''
      versionCode = body.versionCode || 0
      changelog = body.changelog || ''
      uploadId = body.upload_id || ''
      const upload = await resolveReleaseUpload(db, uploadId, auth.user.sub)
      apkUrl = upload.public_url
      apkSize = upload.verified_size || upload.declared_size
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
  }

  if (!versionName || !versionCode) {
    return c.json({ error: 'versionName 和 versionCode 必填' }, 400)
  }

  if (!apkUrl) {
    return c.json({ error: 'apk_url 必填或 APK 上传失败' }, 400)
  }

  // Ensure kv_store table exists
  await run(db, `CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`)

  // Update version info
  const versionInfo = JSON.stringify({
    versionName,
    versionCode,
    downloadUrl: apkUrl,
    changelog,
    releasedAt: new Date().toISOString(),
    apkSize,
    uploadId,
  })

  await run(db,
    `INSERT INTO kv_store (key, value, updated_at) VALUES ('app_version_latest', ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [versionInfo]
  )

  return c.json({
    success: true,
    versionName,
    versionCode,
    downloadUrl: apkUrl,
    uploadId,
    message: '版本更新成功',
  })
  } catch {
    return c.json({ error: '版本更新失败' }, 500)
  }
})

export default version
