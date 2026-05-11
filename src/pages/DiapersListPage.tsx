import { useState, useEffect, useRef } from 'react'
import { getDiapers, getDiaperBrands, getDiaperSizes, type DiaperListItem } from '../lib/api.ts'
import { DiaperCard } from '../components/DiaperCard'

/** 纸尿裤列表页 */
export function DiapersListPage() {
  const [diapers, setDiapers] = useState<DiaperListItem[]>([])
  const [brands, setBrands] = useState<string[]>([])
  const [sizes, setSizes] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [brand, setBrand] = useState('')
  const [size, setSize] = useState('')
  const [sort, setSort] = useState<string>('id')
  const [order, setOrder] = useState<string>('DESC')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const loadingRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    const fetchData = async () => {
      if (loadingRef.current) return
      loadingRef.current = true
      setLoading(true)
      setError(null)
      try {
        const res = await getDiapers({ search, brand, size, sort: sort as 'id' | 'avg_score' | 'rating_count' | 'thickness', order: order as 'ASC' | 'DESC', page, limit: 24 })
        if (!cancelled) {
          setDiapers(res.diapers)
          setTotalPages(res.pagination.totalPages)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载失败')
      } finally {
        if (!cancelled) {
          setLoading(false)
          loadingRef.current = false
        }
      }
    }
    fetchData()
    return () => { cancelled = true }
  }, [search, brand, size, sort, order, page])

  useEffect(() => {
    getDiaperBrands().then(r => setBrands(r.brands)).catch(() => {})
    getDiaperSizes().then(r => setSizes(r.sizes)).catch(() => {})
  }, [])

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-[var(--text-primary)]">纸尿裤数据库</h1>

      <div className="glass mb-6 flex flex-wrap gap-3 p-4">
        <input
          type="text"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1) }}
          placeholder="搜索品牌或型号..."
          className="flex-1 rounded-[var(--radius-sm)] border border-[rgba(0,0,0,0.1)] bg-[var(--bg-page)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--color-primary)]"
        />
        <select value={brand} onChange={e => { setBrand(e.target.value); setPage(1) }} className="rounded-[var(--radius-sm)] border border-[rgba(0,0,0,0.1)] bg-[var(--bg-page)] px-3 py-2 text-sm text-[var(--text-primary)]">
          <option value="">全部品牌</option>
          {brands.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
        <select value={size} onChange={e => { setSize(e.target.value); setPage(1) }} className="rounded-[var(--radius-sm)] border border-[rgba(0,0,0,0.1)] bg-[var(--bg-page)] px-3 py-2 text-sm text-[var(--text-primary)]">
          <option value="">全部尺码</option>
          {sizes.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={sort} onChange={e => { setSort(e.target.value); setPage(1) }} className="rounded-[var(--radius-sm)] border border-[rgba(0,0,0,0.1)] bg-[var(--bg-page)] px-3 py-2 text-sm text-[var(--text-primary)]">
          <option value="id">默认排序</option>
          <option value="avg_score">综合评分</option>
          <option value="rating_count">评分人数</option>
          <option value="thickness">厚度</option>
        </select>
        <button
          type="button"
          onClick={() => setOrder(order === 'DESC' ? 'ASC' : 'DESC')}
          className="rounded-[var(--radius-sm)] border border-[rgba(0,0,0,0.1)] bg-[var(--bg-page)] px-3 py-2 text-sm text-[var(--text-primary)]"
        >
          {order === 'DESC' ? '↓ 降序' : '↑ 升序'}
        </button>
      </div>

      {error && <div className="glass mb-6 px-4 py-3 text-center text-sm text-[var(--color-accent)]">{error}</div>}

      {loading ? (
        <div className="glass px-8 py-12 text-center text-[var(--text-secondary)]">加载中...</div>
      ) : diapers.length === 0 ? (
        <div className="glass px-8 py-12 text-center text-[var(--text-secondary)]">没有找到匹配的纸尿裤</div>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {diapers.map(d => <DiaperCard key={d.id} diaper={d} />)}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2">
              <button
                disabled={page <= 1}
                onClick={() => setPage(p => p - 1)}
                className="rounded-[var(--radius-sm)] bg-[var(--color-primary)] px-3 py-1.5 text-sm text-[var(--text-on-primary)] disabled:opacity-40"
              >
                上一页
              </button>
              <span className="text-sm text-[var(--text-secondary)]">{page} / {totalPages}</span>
              <button
                disabled={page >= totalPages}
                onClick={() => setPage(p => p + 1)}
                className="rounded-[var(--radius-sm)] bg-[var(--color-primary)] px-3 py-1.5 text-sm text-[var(--text-on-primary)] disabled:opacity-40"
              >
                下一页
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
