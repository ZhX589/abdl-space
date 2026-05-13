import { useState, useEffect } from 'react'
import { getTerms, getTermCategories, type TermItem } from '../lib/api.ts'

/** 术语百科页 */
export function TermsPage() {
  const [terms, setTerms] = useState<TermItem[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [selectedCategory, setSelectedCategory] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([
      getTerms(selectedCategory ? { category: selectedCategory } : {}),
      getTermCategories()
    ]).then(([termsData, catsData]) => {
      setTerms(termsData.terms)
      setCategories(catsData.categories)
    }).catch(e => {
      setError(e instanceof Error ? e.message : '加载失败')
    }).finally(() => {
      setLoading(false)
    })
  }, [selectedCategory])

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-[var(--text-primary)]">术语百科</h1>

      <div className="glass mb-6 flex flex-wrap gap-2 p-4">
        <button
          onClick={() => setSelectedCategory('')}
          className={`rounded-[var(--radius-sm)] px-4 py-2 text-sm font-medium transition-all ${selectedCategory === '' ? 'bg-[var(--color-primary)] text-white' : 'text-[var(--text-secondary)] hover:bg-[var(--color-primary-lighter)]'}`}
        >
          全部
        </button>
        {categories.map(cat => (
          <button
            key={cat}
            onClick={() => setSelectedCategory(cat)}
            className={`rounded-[var(--radius-sm)] px-4 py-2 text-sm font-medium transition-all ${selectedCategory === cat ? 'bg-[var(--color-primary)] text-white' : 'text-[var(--text-secondary)] hover:bg-[var(--color-primary-lighter)]'}`}
          >
            {cat}
          </button>
        ))}
      </div>

      {error && <div className="glass mb-6 px-4 py-3 text-center text-sm text-[var(--color-accent)]">{error}</div>}

      {loading ? (
        <div className="glass px-8 py-12 text-center text-[var(--text-secondary)]">加载中...</div>
      ) : terms.length === 0 ? (
        <div className="glass px-8 py-12 text-center text-[var(--text-secondary)]">暂无术语</div>
      ) : (
        <div className="space-y-4">
          {terms.map(term => (
            <div key={term.id} className="glass p-4">
              <div className="flex items-start gap-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-lg font-bold text-[var(--text-primary)]">{term.term}</h3>
                    {term.abbreviation && (
                      <span className="rounded-[4px] bg-[var(--color-primary-lighter)] px-2 py-0.5 text-xs text-[var(--color-primary)]">{term.abbreviation}</span>
                    )}
                    {term.category && (
                      <span className="text-xs text-[var(--text-secondary)]">{term.category}</span>
                    )}
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-[var(--text-primary)]">{term.definition}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}