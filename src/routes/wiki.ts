import { Hono } from 'hono'
import type { Env, JWTPayload } from '../types/index.ts'
import { query, queryOne, run } from '../lib/db.ts'
import { authMiddleware } from '../middleware/auth.ts'

type AppType = { Bindings: Env; Variables: { user: JWTPayload } }

const wiki = new Hono<AppType>()

/**
 * GET /api/pages — Wiki 列表
 */
wiki.get('/', async (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') || '1'))
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20')))
  const diaperId = c.req.query('diaper_id')

  const conditions: string[] = []
  const params: unknown[] = []

  if (diaperId) {
    conditions.push('diaper_id = ?')
    params.push(parseInt(diaperId))
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const countResult = await query<{ total: number }>(
    c.env.abdl_space_db,
    `SELECT COUNT(*) as total FROM wiki_pages ${whereClause}`,
    params
  )

  const offset = (page - 1) * limit
  const rows = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT id, slug, title, diaper_id, version, is_published, author_id, created_at, updated_at
     FROM wiki_pages ${whereClause}
     ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  )

  return c.json({
    pages: rows.map(r => ({
      id: r.id,
      slug: r.slug,
      title: r.title,
      diaper_id: r.diaper_id ?? null,
      version: r.version,
      is_published: r.is_published,
      author_id: r.author_id ?? null,
      created_at: r.created_at,
      updated_at: r.updated_at
    })),
    pagination: {
      page,
      limit,
      total: countResult[0].total,
      totalPages: Math.ceil(countResult[0].total / limit)
    }
  })
})

/**
 * GET /api/pages/:slug — Wiki 页面详情
 */
wiki.get('/:slug', async (c) => {
  const slug = c.req.param('slug')

  const page = await queryOne<Record<string, unknown>>(
    c.env.abdl_space_db,
    'SELECT * FROM wiki_pages WHERE slug = ?',
    [slug]
  )
  if (!page) return c.json({ error: 'Page not found' }, 404)

  return c.json({
    id: page.id,
    slug: page.slug,
    title: page.title,
    content: page.content,
    diaper_id: page.diaper_id ?? null,
    version: page.version,
    is_published: page.is_published,
    author_id: page.author_id ?? null,
    created_at: page.created_at,
    updated_at: page.updated_at
  })
})

/**
 * POST /api/pages — 创建 Wiki 页面
 */
wiki.post('/', authMiddleware, async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ slug: string; title: string; content: string; diaper_id?: number }>()
  const { slug, title, content, diaper_id } = body

  if (!slug || !title || !content) {
    return c.json({ error: 'slug, title, and content are required' }, 400)
  }

  const existing = await queryOne<{ id: number }>(
    c.env.abdl_space_db,
    'SELECT id FROM wiki_pages WHERE slug = ?',
    [slug]
  )
  if (existing) {
    return c.json({ error: 'Slug already exists' }, 409)
  }

  if (diaper_id) {
    const bound = await queryOne<{ id: number }>(
      c.env.abdl_space_db,
      'SELECT id FROM wiki_pages WHERE diaper_id = ?',
      [diaper_id]
    )
    if (bound) {
      return c.json({ error: 'This diaper already has a wiki page' }, 400)
    }
  }

  const result = await run(
    c.env.abdl_space_db,
    'INSERT INTO wiki_pages (slug, title, content, author_id, diaper_id, version) VALUES (?, ?, ?, ?, ?, 1)',
    [slug, title, content, user.sub, diaper_id ?? null]
  )

  const pageId = result.meta.last_row_id as number

  await run(
    c.env.abdl_space_db,
    'INSERT INTO page_versions (page_id, content, version, author_id) VALUES (?, ?, 1, ?)',
    [pageId, content, user.sub]
  )

  return c.json({ id: pageId, slug, message: '创建成功' }, 201)
})

/**
 * PUT /api/pages/:slug — 编辑 Wiki 页面
 */
wiki.put('/:slug', authMiddleware, async (c) => {
  const user = c.get('user')
  const slug = c.req.param('slug')

  const page = await queryOne<{ id: number; version: number; author_id: number | null }>(
    c.env.abdl_space_db,
    'SELECT id, version, author_id FROM wiki_pages WHERE slug = ?',
    [slug]
  )
  if (!page) return c.json({ error: 'Page not found' }, 404)

  const body = await c.req.json<{ title?: string; content?: string; is_published?: number }>()
  const { title, content, is_published } = body

  const updates: string[] = []
  const params: unknown[] = []

  if (title !== undefined) {
    updates.push('title = ?')
    params.push(title)
  }
  if (content !== undefined) {
    updates.push('content = ?')
    params.push(content)
  }
  if (is_published !== undefined) {
    updates.push('is_published = ?')
    params.push(is_published)
  }

  if (updates.length === 0) {
    return c.json({ error: 'No fields to update' }, 400)
  }

  const newVersion = page.version + 1
  updates.push('version = ?', 'updated_at = CURRENT_TIMESTAMP')
  params.push(newVersion)

  await run(
    c.env.abdl_space_db,
    `UPDATE wiki_pages SET ${updates.join(', ')} WHERE slug = ?`,
    [...params, slug]
  )

  const updatedContent = content ?? (await queryOne<{ content: string }>(
    c.env.abdl_space_db, 'SELECT content FROM wiki_pages WHERE slug = ?', [slug]
  ))?.content ?? ''

  await run(
    c.env.abdl_space_db,
    'INSERT INTO page_versions (page_id, content, version, author_id) VALUES (?, ?, ?, ?)',
    [page.id, updatedContent, newVersion, user.sub]
  )

  return c.json({ message: '更新成功', version: newVersion })
})

/**
 * DELETE /api/pages/:slug — 删除 Wiki 页面
 */
wiki.delete('/:slug', authMiddleware, async (c) => {
  const user = c.get('user')
  const slug = c.req.param('slug')

  const page = await queryOne<{ id: number; author_id: number | null }>(
    c.env.abdl_space_db,
    'SELECT id, author_id FROM wiki_pages WHERE slug = ?',
    [slug]
  )
  if (!page) return c.json({ error: 'Page not found' }, 404)

  if (user.role !== 'admin' && page.author_id !== user.sub) {
    return c.json({ error: 'Not authorized to delete this page' }, 403)
  }

  await run(c.env.abdl_space_db, 'DELETE FROM wiki_pages WHERE slug = ?', [slug])

  return c.json({ message: '已删除' })
})

/**
 * GET /api/pages/:slug/inline-comments — 获取段评
 */
wiki.get('/:slug/inline-comments', async (c) => {
  const slug = c.req.param('slug')
  const paragraphHash = c.req.query('paragraph_hash')

  const page = await queryOne<{ id: number }>(
    c.env.abdl_space_db,
    'SELECT id FROM wiki_pages WHERE slug = ?',
    [slug]
  )
  if (!page) return c.json({ error: 'Page not found' }, 404)

  const conditions = ['wic.page_id = ?']
  const params: unknown[] = [page.id]

  if (paragraphHash) {
    conditions.push('wic.paragraph_hash = ?')
    params.push(paragraphHash)
  }

  const comments = await query<Record<string, unknown>>(
    c.env.abdl_space_db,
    `SELECT wic.id, wic.paragraph_hash, wic.content, wic.created_at,
            u.id as user_id, u.username, u.avatar
     FROM wiki_inline_comments wic
     JOIN users u ON wic.author_id = u.id
     WHERE ${conditions.join(' AND ')}
     ORDER BY wic.created_at ASC`,
    params
  )

  return c.json({
    comments: comments.map(c => ({
      id: c.id,
      paragraph_hash: c.paragraph_hash,
      author: { id: c.user_id, username: c.username, avatar: c.avatar ?? null },
      content: c.content,
      created_at: c.created_at
    }))
  })
})

/**
 * POST /api/pages/:slug/inline-comments — 发表段评
 */
wiki.post('/:slug/inline-comments', authMiddleware, async (c) => {
  const user = c.get('user')
  const slug = c.req.param('slug')

  const page = await queryOne<{ id: number }>(
    c.env.abdl_space_db,
    'SELECT id FROM wiki_pages WHERE slug = ?',
    [slug]
  )
  if (!page) return c.json({ error: 'Page not found' }, 404)

  const body = await c.req.json<{ paragraph_hash: string; content: string }>()
  const { paragraph_hash, content } = body

  if (!paragraph_hash || !content) {
    return c.json({ error: 'paragraph_hash and content are required' }, 400)
  }
  if (content.length > 1000) {
    return c.json({ error: 'Content must be 1000 characters or less' }, 400)
  }

  const result = await run(
    c.env.abdl_space_db,
    'INSERT INTO wiki_inline_comments (page_id, paragraph_hash, author_id, content) VALUES (?, ?, ?, ?)',
    [page.id, paragraph_hash, user.sub, content]
  )

  return c.json({ id: result.meta.last_row_id, message: '评论成功' }, 201)
})

/**
 * DELETE /api/pages/:slug/inline-comments/:id — 删除段评
 */
wiki.delete('/:slug/inline-comments/:id', authMiddleware, async (c) => {
  const user = c.get('user')
  const slug = c.req.param('slug')
  const commentId = parseInt(c.req.param('id') || '')

  const page = await queryOne<{ id: number }>(
    c.env.abdl_space_db,
    'SELECT id FROM wiki_pages WHERE slug = ?',
    [slug]
  )
  if (!page) return c.json({ error: 'Page not found' }, 404)

  const comment = await queryOne<{ id: number; author_id: number }>(
    c.env.abdl_space_db,
    'SELECT id, author_id FROM wiki_inline_comments WHERE id = ? AND page_id = ?',
    [commentId, page.id]
  )
  if (!comment) return c.json({ error: 'Comment not found' }, 404)

  if (user.role !== 'admin' && comment.author_id !== user.sub) {
    return c.json({ error: 'Not authorized' }, 403)
  }

  await run(c.env.abdl_space_db, 'DELETE FROM wiki_inline_comments WHERE id = ?', [commentId])

  return c.json({ message: '已删除' })
})

export default wiki
