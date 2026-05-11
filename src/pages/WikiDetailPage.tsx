import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getPage, getInlineComments, createInlineComment, type PageResponse, type InlineComment } from '../lib/api.ts'
import { formatDate, paragraphHash } from '../lib/utils.ts'

/** 渲染 Markdown 为简单段落（非富文本） */
function renderMarkdownAsParagraphs(content: string): string[] {
  return content
    .split('\n\n')
    .filter(p => p.trim())
    .map(p => p.trim())
}

/** Wiki 详情页 */
export function WikiDetailPage() {
  const { slug } = useParams<{ slug: string }>()
  const [page, setPage] = useState<PageResponse | null>(null)
  const [comments, setComments] = useState<InlineComment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeHash, setActiveHash] = useState<string | null>(null)
  const [newComment, setNewComment] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!slug) return
    let cancelled = false
    Promise.all([
      getPage(slug),
      getInlineComments(slug)
    ]).then(([pageData, commentsData]) => {
      if (!cancelled) {
        setPage(pageData)
        setComments(commentsData.comments)
      }
    }).catch(e => {
      if (!cancelled) setError(e instanceof Error ? e.message : '加载失败')
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [slug])

  const paragraphs = page ? renderMarkdownAsParagraphs(page.content) : []

  function getCommentsForParagraph(hash: string): InlineComment[] {
    return comments.filter(c => c.paragraph_hash === hash)
  }

  async function handleSubmitComment() {
    if (!slug || !activeHash || !newComment.trim()) return
    setSubmitting(true)
    try {
      const token = localStorage.getItem('token')
      if (!token) {
        alert('请先登录')
        return
      }
      await createInlineComment(slug, { paragraph_hash: activeHash, content: newComment.trim() }, token)
      setNewComment('')
      const updated = await getInlineComments(slug)
      setComments(updated.comments)
    } catch (e) {
      alert(e instanceof Error ? e.message : '发布失败')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <div className="glass px-8 py-12 text-center text-[var(--text-secondary)]">加载中...</div>
  if (error) return <div className="glass px-8 py-4 text-center text-[var(--color-accent)]">{error}</div>
  if (!page) return <div className="glass px-8 py-12 text-center text-[var(--text-secondary)]">页面未找到</div>

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <Link to="/wiki" className="text-sm text-[var(--text-secondary)] transition-colors hover:text-[var(--color-primary)]">
          ← 返回列表
        </Link>
        <Link
          to={`/wiki/${slug}/edit`}
          className="rounded-[var(--radius-sm)] bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--text-on-primary)] transition-all duration-200 hover:opacity-90"
        >
          编辑
        </Link>
      </div>

      <div className="glass mb-6 p-6">
        <h1 className="mb-2 text-2xl font-bold text-[var(--text-primary)]">{page.title}</h1>
        <p className="mb-6 text-sm text-[var(--text-secondary)]">
          v{page.version} · 更新于 {formatDate(page.updated_at)}
          {page.diaper_id ? (
            <> · <Link to={`/diapers/${page.diaper_id}`} className="text-[var(--color-primary)] hover:underline">关联纸尿裤</Link></>
          ) : ''}
        </p>

        <div className="prose prose-sm max-w-none">
          {paragraphs.map((para, i) => {
            const hash = paragraphHash(para)
            const paraComments = getCommentsForParagraph(hash)
            return (
              <div key={i} className="group relative mb-4 rounded-[var(--radius-sm)] p-3 transition-colors hover:bg-[var(--color-primary-lighter)]">
                <p className="text-sm leading-relaxed text-[var(--text-primary)]">{para}</p>
                <button
                  onClick={() => setActiveHash(activeHash === hash ? null : hash)}
                  className="mt-2 text-xs text-[var(--text-secondary)] opacity-0 transition-opacity group-hover:opacity-100"
                >
                  {paraComments.length > 0 ? `${paraComments.length} 条段评` : '添加段评'}
                </button>

                {paraComments.length > 0 && (
                  <div className="mt-2 space-y-2">
                    {paraComments.map(c => (
                      <div key={c.id} className="rounded-[4px] bg-[var(--bg-page)] p-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium text-[var(--color-primary)]">{c.author.username}</span>
                          <span className="text-[10px] text-[var(--text-secondary)]">{formatDate(c.created_at)}</span>
                        </div>
                        <p className="mt-1 text-xs text-[var(--text-primary)]">{c.content}</p>
                      </div>
                    ))}
                  </div>
                )}

                {activeHash === hash && (
                  <div className="mt-2 flex gap-2">
                    <input
                      type="text"
                      value={newComment}
                      onChange={e => setNewComment(e.target.value)}
                      placeholder="写段评..."
                      className="flex-1 rounded-[4px] border border-[rgba(0,0,0,0.1)] bg-[var(--bg-page)] px-2 py-1 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--color-primary)]"
                    />
                    <button
                      onClick={handleSubmitComment}
                      disabled={submitting || !newComment.trim()}
                      className="rounded-[4px] bg-[var(--color-primary)] px-3 py-1 text-xs font-medium text-[var(--text-on-primary)] disabled:opacity-40"
                    >
                      {submitting ? '...' : '发送'}
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
