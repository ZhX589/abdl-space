import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { authMiddleware } from '../middleware/auth.ts'
import { inspectMediaImageDimensions } from '../lib/media-preview.ts'
import { deleteCompletedUpload, getCompletedUploadReference, uploadLegacyObject } from '../lib/upload-consumer.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const images = new Hono<AppType>()

const IMGBED_URL = 'https://img.abdl-space.top'
const IMGBED_FALLBACK_HEADER = 'X-ABDL-Upload-Fallback'

export function resolveGenericImageUpload(db: D1Database, reference: string, userId: number) {
  return getCompletedUploadReference(db, reference, userId, 'generic')
}

/**
 * POST /api/images/upload — 代理上传到图床
 */
images.post('/upload', authMiddleware, async (c) => {
  const user = c.get('user')

  if ((c.req.header('Content-Type') || '').includes('application/json')) {
    let body: { upload_id?: string; url?: string }
    try { body = await c.req.json() } catch { return c.json({ error: '无效请求' }, 400) }
    try {
      const upload = await resolveGenericImageUpload(c.env.abdl_space_db, body.upload_id || body.url || '', user.sub)
      return c.json({ upload_id: upload.id, url: upload.public_url })
    } catch {
      return c.json({ error: '无效的图片上传' }, 400)
    }
  }

  const formData = await c.req.formData()
  const file = formData.get('file')
  if (!file || !(file instanceof File)) {
    return c.json({ error: '请选择图片' }, 400)
  }

  // 验证文件类型
  const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
  if (!allowedTypes.includes(file.type)) {
    return c.json({ error: '仅支持 JPG/PNG/GIF/WebP 格式' }, 400)
  }

  // 验证文件大小 (5MB)
  if (file.size > 5 * 1024 * 1024) {
    return c.json({ error: '图片不能超过 5MB' }, 400)
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  const dimensions = inspectMediaImageDimensions(bytes)
  if (!dimensions) return c.json({ error: '无效图片' }, 400)
  try {
    const upload = await uploadLegacyObject(c.env, user.sub, 'generic', file, c.req.header(IMGBED_FALLBACK_HEADER) === 'imgbed', dimensions)
    return c.json({ upload_id: upload.id, url: upload.public_url })
  } catch {
    return c.json({ error: '上传失败' }, 500)
  }
})

/**
 * POST /api/images/delete — 代理删除图床图片
 */
images.post('/delete', authMiddleware, async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ upload_id?: string; url?: string }>()
  const reference = body.upload_id || body.url

  if (!reference) return c.json({ error: 'upload_id 必填' }, 400)

  let upload
  try {
    upload = await resolveGenericImageUpload(c.env.abdl_space_db, reference, user.sub)
  } catch {
    return c.json({ error: '无效的图片上传' }, 400)
  }

  if (upload.storage_provider === 'cos') {
    try {
      await deleteCompletedUpload({
        db: c.env.abdl_space_db,
        id: upload.id,
        userId: user.sub,
        purpose: 'generic',
        cos: { secretId: c.env.COS_SECRET_ID, secretKey: c.env.COS_SECRET_KEY, bucket: c.env.COS_BUCKET, region: c.env.COS_REGION },
      })
      return c.json({ message: '已删除' })
    } catch {
      return c.json({ error: '删除失败' }, 500)
    }
  }

  const url = upload.public_url

  // 从完整 URL 提取文件路径
  let src = url
  try {
    const parsed = new URL(url)
    src = parsed.pathname // 保留 /file/ 前缀
  } catch {
    if (!url.startsWith('/file/')) src = `/file/${url}`
  }

  const res = await fetch(`${IMGBED_URL}/api/manage/delete`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${c.env.IMGBED_DELETE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ src }),
  })

  if (!res.ok) {
    return c.json({ error: '删除失败' }, 500)
  }

  await c.env.abdl_space_db.prepare('DELETE FROM media_uploads WHERE id = ? AND user_id = ?').bind(upload.id, user.sub).run()

  return c.json({ message: '已删除' })
})

/**
 * GET /api/images/list — 代理列出图床图片（管理员）
 */
images.get('/list', authMiddleware, async (c) => {
  const user = c.get('user')
  if (user.role !== 'admin') {
    return c.json({ error: '需要管理员权限' }, 403)
  }

  const page = Math.max(1, parseInt(c.req.query('page') || '1') || 1)
  const perPage = Math.min(100, Math.max(1, parseInt(c.req.query('perPage') || '20') || 20))
  const result = await c.env.abdl_space_db.prepare(`SELECT id AS upload_id, public_url AS url, mime_type,
    verified_size AS size, width, height, storage_provider, created_at
    FROM media_uploads WHERE purpose = 'generic' AND status = 'complete'
    ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(perPage, (page - 1) * perPage).all()
  if (!result.success) return c.json({ error: '获取列表失败' }, 500)
  return c.json({ items: result.results, page, perPage })
})

export default images
