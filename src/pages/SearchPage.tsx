import { useState, useEffect } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { getSearch, type SearchResponse } from '../lib/api.ts'

/** 搜索结果页 */
export function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [results, setResults] = useState<SearchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState(searchParams.get('q') || '')

  useEffect(() => {
    const q = searchParams.get('q')
    if (!q) return
    setLoading(true)
    setError(null)
    getSearch({ q })
      .then(data => setResults(data))
      .catch(e => setError(e instanceof Error ? e.message : '搜索失败'))
      .finally(() => setLoading(false))
  }, [searchParams])

  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    if (query.trim().length < 2) return
    setSearchParams({ q: query.trim() })
  }

  const q = searchParams.get('q') || ''

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-[var(--text-primary)]">搜索</h1>

      <form onSubmit={handleSearch} className="glass mb-6 flex gap-3 p-4">
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="搜索纸尿裤、Wiki、术语..."
          className="flex-1 rounded-[var(--radius-sm)] border border-[rgba(0,0,0,0.1)] bg-[var(--bg-page)] px-4 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--color-primary)]"
        />
        <button
          type="submit"
          className="rounded-[var(--radius-sm)] bg-[var(--color-primary)] px-6 py-2 text-sm font-medium text-[var(--text-on-primary)] transition-all hover:opacity-90"
        >
          搜索
        </button>
      </form>

      {error && <div className="glass mb-6 px-4 py-3 text-center text-sm text-[var(--color-accent)]">{error}</div>}

      {loading && <div className="glass px-8 py-12 text-center text-[var(--text-secondary)]">搜索中...</div>}

      {!loading && results && (
        <div className="space-y-6">
          {results.results.diapers.length > 0 && (
            <div>
              <h2 className="mb-3 flex items-center gap-2 text-lg font-bold text-[var(--text-primary)]">
                纸尿裤 <span className="text-sm font-normal text-[var(--text-secondary)]">({results.results.diapers.length})</span>
              </h2>
              <div className="space-y-2">
                {results.results.diapers.map(d => (
                  <Link key={d.id} to={`/diapers/${d.id}`} className="glass flex items-center justify-between p-4 transition-all hover:scale-[1.01]">
                    <div>
                      <span className="text-xs text-[var(--color-primary)]">{d.brand}</span>
                      <div className="font-medium text-[var(--text-primary)]">{d.model}</div>
                    </div>
                    <div className="text-right">
                      <span className="text-lg font-bold text-[var(--color-star)]">{d.avg_score > 0 ? d.avg_score.toFixed(1) : '-'}</span>
                      <span className="ml-1 text-xs text-[var(--text-secondary)]">分</span>
                      <div className="mt-1 text-xs text-[var(--text-secondary)]">{d.rating_count} 人评分</div>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {results.results.wiki.length > 0 && (
            <div>
              <h2 className="mb-3 flex items-center gap-2 text-lg font-bold text-[var(--text-primary)]">
                Wiki <span className="text-sm font-normal text-[var(--text-secondary)]">({results.results.wiki.length})</span>
              </h2>
              <div className="space-y-2">
                {results.results.wiki.map(w => (
                  <Link key={w.id} to={`/wiki/${w.slug}`} className="glass block p-4 transition-all hover:scale-[1.01]">
                    <div className="font-medium text-[var(--text-primary)]">{w.title}</div>
                    <div className="mt-1 line-clamp-2 text-sm text-[var(--text-secondary)]">{w.content_preview}</div>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {results.results.terms.length > 0 && (
            <div>
              <h2 className="mb-3 flex items-center gap-2 text-lg font-bold text-[var(--text-primary)]">
                术语 <span className="text-sm font-normal text-[var(--text-secondary)]">({results.results.terms.length})</span>
              </h2>
              <div className="space-y-2">
                {results.results.terms.map(t => (
                  <div key={t.id} className="glass p-4">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-[var(--text-primary)]">{t.term}</span>
                      {t.abbreviation && (
                        <span className="rounded-[4px] bg-[var(--color-primary-lighter)] px-2 py-0.5 text-xs text-[var(--color-primary)]">{t.abbreviation}</span>
                      )}
                      {t.category && (
                        <span className="text-xs text-[var(--text-secondary)]">{t.category}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {results.total === 0 && (
            <div className="glass px-8 py-12 text-center text-[var(--text-secondary)]">
              没有找到 "{q}" 相关结果
            </div>
          )}
        </div>
      )}

      {!loading && !results && !error && (
        <div className="glass px-8 py-12 text-center text-[var(--text-secondary)]">
          输入关键词搜索纸尿裤、Wiki 页面或术语
        </div>
      )}
    </div>
  )
}