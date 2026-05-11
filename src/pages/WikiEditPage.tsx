import { useState, useEffect } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { getPage, createPage, updatePage } from '../lib/api.ts'

/** Wiki 编辑页 */
export function WikiEditPage() {
  const { slug } = useParams<{ slug: string }>()
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [pageSlug, setPageSlug] = useState(slug || '')
  const [loading, setLoading] = useState(slug !== 'new' && slug !== undefined)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const isNew = slug === 'new'

  useEffect(() => {
    if (!slug || slug === 'new') return
    let cancelled = false
    getPage(slug)
      .then(page => {
        if (!cancelled) {
          setTitle(page.title)
          setContent(page.content)
          setPageSlug(page.slug)
        }
      })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : '加载失败') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [slug])

  async function handleSave() {
    if (!title.trim() || !content.trim() || !pageSlug.trim()) {
      setError('标题、内容、Slug 为必填')
      return
    }
    setError(null)
    setSaving(true)
    try {
      const token = localStorage.getItem('token')
      if (!token) { setError('请先登录'); return }

      if (isNew) {
        await createPage({ slug: pageSlug, title: title.trim(), content: content.trim() }, token)
        setSuccess('创建成功')
        navigate(`/wiki/${pageSlug}`)
      } else if (slug) {
        await updatePage(slug, { title: title.trim(), content: content.trim() }, token)
        setSuccess('更新成功')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="glass px-8 py-12 text-center text-[var(--text-secondary)]">加载中...</div>

  return (
    <div>
      <div className="mb-6 flex items-center gap-4">
        <Link
          to={isNew ? '/wiki' : `/wiki/${slug}`}
          className="text-sm text-[var(--text-secondary)] transition-colors hover:text-[var(--color-primary)]"
        >
          ← 返回
        </Link>
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">
          {isNew ? '创建新页面' : `编辑: ${slug}`}
        </h1>
      </div>

      <div className="glass p-6">
        {error && <div className="mb-4 rounded-[var(--radius-sm)] bg-[rgba(255,140,148,0.1)] px-4 py-2 text-sm text-[var(--color-accent)]">{error}</div>}
        {success && <div className="mb-4 rounded-[var(--radius-sm)] bg-[rgba(91,163,230,0.1)] px-4 py-2 text-sm text-[var(--color-primary)]">{success}</div>}

        <div className="mb-4">
          <label className="mb-1 block text-sm font-medium text-[var(--text-primary)]">Slug</label>
          <input
            type="text"
            value={pageSlug}
            onChange={e => setPageSlug(e.target.value)}
            placeholder="url-friendly-name"
            disabled={!isNew}
            className="w-full rounded-[var(--radius-sm)] border border-[rgba(0,0,0,0.1)] bg-[var(--bg-page)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--color-primary)] disabled:opacity-50"
          />
        </div>

        <div className="mb-4">
          <label className="mb-1 block text-sm font-medium text-[var(--text-primary)]">标题</label>
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="页面标题"
            className="w-full rounded-[var(--radius-sm)] border border-[rgba(0,0,0,0.1)] bg-[var(--bg-page)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--color-primary)]"
          />
        </div>

        <div className="mb-4">
          <label className="mb-1 block text-sm font-medium text-[var(--text-primary)]">内容 (Markdown)</label>
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            rows={20}
            placeholder="编写 Wiki 内容..."
            className="w-full rounded-[var(--radius-sm)] border border-[rgba(0,0,0,0.1)] bg-[var(--bg-page)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--color-primary)]"
          />
        </div>

        <div className="flex gap-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-[var(--radius-sm)] bg-[var(--color-primary)] px-6 py-2 text-sm font-medium text-[var(--text-on-primary)] transition-all duration-200 hover:opacity-90 disabled:opacity-40"
          >
            {saving ? '保存中...' : '保存'}
          </button>
          <Link
            to={isNew ? '/wiki' : `/wiki/${slug}`}
            className="rounded-[var(--radius-sm)] border border-[rgba(0,0,0,0.1)] px-6 py-2 text-sm text-[var(--text-secondary)] transition-all duration-200 hover:bg-[var(--color-primary-lighter)]"
          >
            取消
          </Link>
        </div>
      </div>
    </div>
  )
}
