import { useState, useEffect } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getPage, createPage, updatePage } from '../lib/api.ts'

type Mode = 'edit' | 'preview'

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
  const [mode, setMode] = useState<Mode>('edit')

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

  function insertMarkdown(before: string, after: string = '') {
    const textarea = document.querySelector<HTMLTextAreaElement>('.wiki-editor')
    if (!textarea) return
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const selected = content.substring(start, end)
    const newContent = content.substring(0, start) + before + selected + after + content.substring(end)
    setContent(newContent)
    setTimeout(() => {
      textarea.focus()
      textarea.setSelectionRange(start + before.length, start + before.length + selected.length)
    }, 0)
  }

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
          <div className="mb-2 flex items-center justify-between">
            <label className="block text-sm font-medium text-[var(--text-primary)]">内容 (Markdown)</label>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setMode('edit')}
                className={`rounded-[4px] px-3 py-1 text-xs transition-colors ${mode === 'edit' ? 'bg-[var(--color-primary)] text-white' : 'text-[var(--text-secondary)] hover:bg-[var(--color-primary-lighter)]'}`}
              >
                编辑
              </button>
              <button
                type="button"
                onClick={() => setMode('preview')}
                className={`rounded-[4px] px-3 py-1 text-xs transition-colors ${mode === 'preview' ? 'bg-[var(--color-primary)] text-white' : 'text-[var(--text-secondary)] hover:bg-[var(--color-primary-lighter)]'}`}
              >
                预览
              </button>
            </div>
          </div>

          {mode === 'edit' ? (
            <>
              <div className="mb-2 flex flex-wrap gap-1">
                {[
                  { label: 'B', before: '**', after: '**', title: '粗体' },
                  { label: 'I', before: '_', after: '_', title: '斜体' },
                  { label: 'H2', before: '## ', after: '', title: '二级标题' },
                  { label: 'H3', before: '### ', after: '', title: '三级标题' },
                  { label: 'ul', before: '- ', after: '', title: '无序列表' },
                  { label: 'ol', before: '1. ', after: '', title: '有序列表' },
                  { label: 'code', before: '`', after: '`', title: '行内代码' },
                  { label: '```', before: '```\n', after: '\n```', title: '代码块' },
                  { label: '>', before: '> ', after: '', title: '引用' },
                  { label: '---', before: '\n---\n', after: '', title: '分割线' },
                ].map(btn => (
                  <button
                    key={btn.label}
                    type="button"
                    title={btn.title}
                    onClick={() => insertMarkdown(btn.before, btn.after)}
                    className="rounded-[4px] border border-[rgba(0,0,0,0.15)] bg-[var(--bg-page)] px-2 py-1 text-xs font-mono text-[var(--text-primary)] transition-colors hover:bg-[var(--color-primary-lighter)]"
                  >
                    {btn.label}
                  </button>
                ))}
              </div>
              <textarea
                value={content}
                onChange={e => setContent(e.target.value)}
                rows={20}
                placeholder="编写 Wiki 内容..."
                className="wiki-editor w-full rounded-[var(--radius-sm)] border border-[rgba(0,0,0,0.1)] bg-[var(--bg-page)] px-3 py-2 text-sm font-mono text-[var(--text-primary)] outline-none focus:border-[var(--color-primary)]"
              />
            </>
          ) : (
            <div className="prose prose-sm max-w-none rounded-[var(--radius-sm)] border border-[rgba(0,0,0,0.1)] bg-[var(--bg-page)] p-4 min-h-[400px]">
              {content ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
              ) : (
                <p className="text-sm text-[var(--text-secondary)]">无内容预览</p>
              )}
            </div>
          )}
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