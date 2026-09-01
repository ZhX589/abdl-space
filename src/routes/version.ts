import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Env } from '../types/index.ts'
import { queryOne, run } from '../lib/db.ts'
import { cacheGet, cacheSet, cacheDelete } from '../lib/ttl-cache.ts'
import { kvCacheGet, kvCacheSet, kvCacheInvalidate } from '../lib/kv-cache.ts'
import { getCompletedUploadReference } from '../lib/upload-consumer.ts'

type AppType = { Bindings: Env }

// 版本信息属于低频变更数据，缓存 5 分钟，避免每个客户端频繁查 kv_store。
const VERSION_CACHE_KEY = 'version:app_version_latest'
const VERSION_CACHE_TTL_MS = 300_000
// KV 缓存 TTL 比进程内更长（免费层写配额 1 次/天 上限，15 分钟回填 ≈ 96 次/天/key）
const VERSION_KV_KEY = 'version:latest'
const VERSION_KV_TTL_SEC = 900

const version = new Hono<AppType>()

// CORS for version API (browser access from abdl-space.top)
version.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Upload-Key'],
}))

const IMGBED_HOST = 'https://img.abdl-space.top'
const IMGBED_PAGES_HOST = 'https://cloudflare-imgbed-790.pages.dev'
const IMGBED_APK_UPLOAD_URL = `${IMGBED_HOST}/upload?returnFormat=full&uploadFolder=apk&uploadChannel=huggingface&channelName=abdl-space-img&autoRetry=false`

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function resolveReleaseUpload(db: D1Database, reference: string, userId: number) {
  return getCompletedUploadReference(db, reference, userId, 'release')
}

/**
 * GET /api/v1/version — 获取最新版本信息
 */
version.get('/', async (c) => {
  const db = c.env.abdl_space_db
  const kv = c.env.NOTICE_KV

  // L0 进程内缓存（单实例最近 5 分钟）
  const cached = cacheGet<Record<string, unknown>>(VERSION_CACHE_KEY)
  if (cached) return c.json(cached)

  // L1 KV 缓存（跨实例共享，命中即不触 D1；KV 未配置/异常时静默回退 D1）
  const kvBody = await kvCacheGet<Record<string, unknown>>(kv, VERSION_KV_KEY)
  if (kvBody) return c.json(kvBody)

  const latest = await queryOne<{
    value: string
  }>(db, `SELECT value FROM kv_store WHERE key = 'app_version_latest'`)

  if (!latest) {
    const body = { hasUpdate: false, message: '暂无版本信息' }
    cacheSet(VERSION_CACHE_KEY, body, VERSION_CACHE_TTL_MS)
    await kvCacheSet(kv, VERSION_KV_KEY, body, VERSION_KV_TTL_SEC)
    return c.json(body)
  }

  try {
    const info = JSON.parse(latest.value)
    const body = {
      hasUpdate: true,
      versionName: info.versionName,
      versionCode: info.versionCode,
      downloadUrl: info.downloadUrl,
      changelog: info.changelog || '',
      releasedAt: info.releasedAt || '',
      apkSize: info.apkSize || 0,
    }
    cacheSet(VERSION_CACHE_KEY, body, VERSION_CACHE_TTL_MS)
    await kvCacheSet(kv, VERSION_KV_KEY, body, VERSION_KV_TTL_SEC)
    return c.json(body)
  } catch {
    const body = { hasUpdate: false, message: '版本信息格式错误' }
    cacheSet(VERSION_CACHE_KEY, body, VERSION_CACHE_TTL_MS)
    await kvCacheSet(kv, VERSION_KV_KEY, body, VERSION_KV_TTL_SEC)
    return c.json(body)
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
  let stage = 'request'
  try {
  const db = c.env.abdl_space_db

  let versionName = ''
  let versionCode = 0
  let changelog = ''
  let apkUrl = ''
  let apkSize = 0
  let apk: File | null = null

  const contentType = c.req.header('Content-Type') || ''

  if (contentType.includes('multipart/form-data')) {
    const formData = await c.req.formData()
    versionName = formData.get('versionName') as string || ''
    versionCode = parseInt(formData.get('versionCode') as string) || 0
    changelog = formData.get('changelog') as string || ''

    apk = formData.get('apk') instanceof File ? formData.get('apk') as File : null
    if (apk) {
      stage = 'imgbed_upload'
      const sha256 = toHex(await crypto.subtle.digest('SHA-256', await apk.arrayBuffer()))
      const uploadForm = new FormData()
      uploadForm.append('file', apk)
      uploadForm.append('sha256', sha256)
      let response = await fetch(IMGBED_APK_UPLOAD_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${c.env.IMGBED_UPLOAD_KEY}` },
        body: uploadForm,
      })
      const upstreamStatuses = [response.status]
      if (!response.ok && c.env.IMGBED_UPLOAD_KEY) {
        const retryForm = new FormData()
        retryForm.append('file', apk)
        retryForm.append('sha256', sha256)
        response = await fetch(`${IMGBED_APK_UPLOAD_URL}&authCode=${encodeURIComponent(c.env.IMGBED_UPLOAD_KEY)}`, {
          method: 'POST',
          body: retryForm,
        })
        upstreamStatuses.push(response.status)
      }
      if (!response.ok && c.env.IMGBED_UPLOAD_KEY) {
        const headerForm = new FormData()
        headerForm.append('file', apk)
        headerForm.append('sha256', sha256)
        response = await fetch(IMGBED_APK_UPLOAD_URL, {
          method: 'POST',
          headers: { authCode: c.env.IMGBED_UPLOAD_KEY },
          body: headerForm,
        })
        upstreamStatuses.push(response.status)
      }
      if (!response.ok) return c.json({ error: 'APK 上传失败', upstream_statuses: upstreamStatuses }, 502)
      const upstreamContentType = response.headers.get('Content-Type') || ''
      const upstreamBody = await response.text()
      let data: { src?: string; url?: string } | { src?: string; url?: string }[]
      try {
        data = JSON.parse(upstreamBody)
      } catch {
        return c.json({
          error: 'APK 上传失败',
          upstream_status: response.status,
          upstream_content_type: upstreamContentType,
          upstream_body: upstreamBody.slice(0, 200),
        }, 502)
      }
      const uploaded = Array.isArray(data) ? data[0] : data
      apkUrl = uploaded?.src || uploaded?.url || ''
      const uploadedUrl = apkUrl ? new URL(apkUrl) : null
      if (!uploadedUrl || (uploadedUrl.origin !== IMGBED_HOST && uploadedUrl.origin !== IMGBED_PAGES_HOST)) {
        return c.json({ error: 'APK 上传失败', upstream_status: response.status }, 502)
      }
      apkUrl = `${IMGBED_HOST}${uploadedUrl.pathname}${uploadedUrl.search}`
      apkSize = apk.size
    }
  } else {
    try {
      const body = await c.req.json()
      versionName = body.versionName || ''
      versionCode = body.versionCode || 0
      changelog = body.changelog || ''
      apkUrl = body.apkUrl || ''
      apkSize = body.apkSize || 0
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
  stage = 'version_update'
  await run(db, `CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`)

  // Update version info
  const versionInfo = JSON.stringify({
    versionName,
    versionCode,
    downloadUrl: apkUrl,
    changelog,
    releasedAt: new Date().toISOString(),
    apkSize,
  })

  await run(db,
    `INSERT INTO kv_store (key, value, updated_at) VALUES ('app_version_latest', ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [versionInfo]
  )

  // 新版本上传成功后立即失效 GET 缓存（进程内 + KV），让客户端尽快看到更新
  cacheDelete(VERSION_CACHE_KEY)
  await kvCacheInvalidate(c.env.NOTICE_KV, VERSION_KV_KEY)

  return c.json({
    success: true,
    versionName,
    versionCode,
    downloadUrl: apkUrl,
    message: '版本更新成功',
  })
  } catch (error) {
    let detail = error instanceof Error ? error.message : 'Unknown error'
    if (c.env.IMGBED_UPLOAD_KEY) detail = detail.replaceAll(c.env.IMGBED_UPLOAD_KEY, '[redacted]')
    detail = detail.replace(/authCode=[^&\s]+/gi, 'authCode=[redacted]').slice(0, 200)
    return c.json({ error: '版本更新失败', stage, detail }, 500)
  }
})

export default version
