import { Hono } from 'hono'
import type { Env } from '../types/index.ts'
import { queryOne, run } from '../lib/db.ts'
import { authMiddleware } from '../middleware/auth.ts'

type AppType = { Bindings: Env }

const version = new Hono<AppType>()

const IMGBED_HOST = 'https://img.abdl-space.top'

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
  // Accept either admin auth OR upload key as admin credential
  let isAdmin = false
  const authHeader = c.req.header('Authorization')
  if (authHeader) {
    const user = await authMiddleware(c) as any
    if (user && user.role === 'admin') isAdmin = true
  }
  // Also accept upload key as admin credential
  const uploadKey = c.req.header('X-Upload-Key')
  if (uploadKey && uploadKey === c.env.IMGBED_UPLOAD_KEY) isAdmin = true

  if (!isAdmin) {
    return c.json({ error: '需要管理员权限或上传密钥' }, 403)
  }

  const db = c.env.abdl_space_db

  let versionName = ''
  let versionCode = 0
  let changelog = ''
  let apkUrl = ''

  const contentType = c.req.header('Content-Type') || ''

  if (contentType.includes('multipart/form-data')) {
    const formData = await c.req.formData()
    versionName = formData.get('versionName') as string || ''
    versionCode = parseInt(formData.get('versionCode') as string) || 0
    changelog = formData.get('changelog') as string || ''

    const apk = formData.get('apk')
    if (apk && apk instanceof File) {
      const uploadForm = new FormData()
      uploadForm.append('file', apk)

      let res = await fetch(`${IMGBED_HOST}/upload?returnFormat=full&uploadFolder=apk`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${c.env.IMGBED_UPLOAD_KEY}` },
        body: uploadForm,
      })

      if (!res.ok && c.env.IMGBED_UPLOAD_KEY) {
        const uploadForm2 = new FormData()
        uploadForm2.append('file', apk)
        res = await fetch(`${IMGBED_HOST}/upload?returnFormat=full&uploadFolder=apk&authCode=${c.env.IMGBED_UPLOAD_KEY}`, {
          method: 'POST',
          body: uploadForm2,
        })
      }

      if (!res.ok) {
        return c.json({ error: 'APK 上传失败' }, 500)
      }

      const data = await res.json() as { src: string }[]
      apkUrl = data[0]?.src || ''
      if (!apkUrl) return c.json({ error: 'APK 上传返回为空' }, 500)
    }
  } else {
    const body = await c.req.json()
    versionName = body.versionName || ''
    versionCode = body.versionCode || 0
    changelog = body.changelog || ''
    apkUrl = body.apkUrl || ''
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
    message: '版本更新成功',
  })
})

export default version
