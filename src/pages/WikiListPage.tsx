import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { getPages, type WikiPageItem } from '../lib/api.ts'
import { formatDate } from '../lib/utils.ts'

/** Wiki 列表页 */
export function WikiListPage() {
  const [pages, setPages] = useState<WikiPageItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getPages({ limit: 50 })
      .then(res => { if (!cancelled) setPages(res.pages) })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : '加载失败') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">Wiki 百科</h1>
      </div>

      {error && <div className="glass mb-6 px-4 py-3 text-center text-sm text-[var(--color-accent)]">{error}</div>}

      {loading ? (
        <div className="glass px-8 py-10 text-center text-[var(--text-secondary)]">加载中...</div>
      ) : pages.length === 0 ? (
        <div className="glass px-8 py-10 text-center text-[var(--text-secondary)]">暂无 Wiki 页面</div>
      ) : (
        <div className="grid gap-4">
          {pages.map(page => (
            <Link
              key={page.id}
              to={`/wiki/${page.slug}`}
              className="glass block p-5 transition-all duration-300 hover:scale-[1.01] hover:shadow-lg"
            >
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-bold text-[var(--text-primary)]">{page.title}</h3>
                  <p className="mt-1 text-sm text-[var(--text-secondary)]">
                    v{page.version} · {formatDate(page.updated_at)}
                    {page.diaper_id ? ` · 关联纸尿裤 #${page.diaper_id}` : ''}
                  </p>
                </div>
                <span className="rounded-[var(--radius-sm)] bg-[var(--color-primary-lighter)] px-2 py-0.5 text-xs text-[var(--color-primary)]">
                  {page.is_published ? '已发布' : '草稿'}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
