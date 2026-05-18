import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { authMiddleware } from '../middleware/auth.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const images = new Hono<AppType>()

const IMGBED_URL = 'https://img.abdl-space.top'

/**
 * POST /api/images/upload — 代理上传到图床
 */
images.post('/upload', authMiddleware, async (c) => {
  const user = c.get('user')

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

  const uploadForm = new FormData()
  uploadForm.append('file', file)

  const res = await fetch(`${IMGBED_URL}/upload?returnFormat=full`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${c.env.IMGBED_UPLOAD_KEY}`,
    },
    body: uploadForm,
  })

  if (!res.ok) {
    const err = await res.text()
    return c.json({ error: `上传失败: ${err}` }, 500)
  }

  const data = await res.json() as { src: string }[]
  const url = data[0]?.src

  if (!url) {
    return c.json({ error: '上传失败，未返回图片地址' }, 500)
  }

  return c.json({ url })
})

/**
 * POST /api/images/delete — 代理删除图床图片
 */
images.post('/delete', authMiddleware, async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ url: string }>()
  const { url } = body

  if (!url) return c.json({ error: 'url 必填' }, 400)

  // 从完整 URL 提取文件名（/file/xxx.jpg → xxx.jpg）
  let fileName = url
  try {
    const parsed = new URL(url)
    fileName = parsed.pathname.replace(/^\/file\//, '')
  } catch {
    // url 可能已经是相对路径
    fileName = url.replace(/^\/file\//, '')
  }

  const res = await fetch(`${IMGBED_URL}/api/manage/delete`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${c.env.IMGBED_DELETE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ list: [fileName] }),
  })

  if (!res.ok) {
    return c.json({ error: '删除失败' }, 500)
  }

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

  const page = c.req.query('page') || '1'
  const perPage = c.req.query('perPage') || '20'

  const res = await fetch(`${IMGBED_URL}/api/manage/list?page=${page}&perPage=${perPage}`, {
    headers: {
      'Authorization': `Bearer ${c.env.IMGBED_LIST_KEY}`,
    },
  })

  if (!res.ok) {
    return c.json({ error: '获取列表失败' }, 500)
  }

  const data = await res.json()
  return c.json(data)
})

export default images
