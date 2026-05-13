import { useState, useEffect } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { getDiaperCompare, getDiapers, type CompareDiaper, type DiaperListItem } from '../lib/api.ts'

const DIM_LABELS: Record<string, string> = {
  absorption_score: '吸收力',
  fit_score: '贴合度',
  comfort_score: '舒适感',
  thickness_score: '轻薄度',
  appearance_score: '外观',
  value_score: '性价比'
}

const DIM_KEYS = ['absorption_score', 'fit_score', 'comfort_score', 'thickness_score', 'appearance_score', 'value_score'] as const

function getBest(diaper: CompareDiaper, dim: string): boolean {
  return diaper.dimensions[dim as keyof typeof diaper.dimensions]?.avg === 10
}

/** 纸尿裤对比页 */
export function ComparePage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [compareItems, setCompareItems] = useState<CompareDiaper[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [availableDiapers, setAvailableDiapers] = useState<DiaperListItem[]>([])
  const [selectedIds, setSelectedIds] = useState<number[]>([])

  useEffect(() => {
    getDiapers({ limit: 100, sort: 'avg_score', order: 'DESC' })
      .then(r => setAvailableDiapers(r.diapers))
      .catch(() => {})
  }, [])

  useEffect(() => {
    const idsParam = searchParams.get('ids')
    if (!idsParam) return

    const ids = idsParam.split(',').map(Number).filter(id => !isNaN(id) && id > 0).slice(0, 5)
    if (ids.length === 0) return

    setLoading(true)
    setError(null)
    getDiaperCompare(ids.join(','))
      .then(data => {
        setCompareItems(data.diapers)
        setSelectedIds(ids)
      })
      .catch(e => {
        setError(e instanceof Error ? e.message : '加载失败')
      })
      .finally(() => setLoading(false))
  }, [searchParams])

  function toggleDiaper(id: number) {
    if (selectedIds.includes(id)) {
      setSelectedIds(prev => prev.filter(i => i !== id))
    } else if (selectedIds.length < 5) {
      setSelectedIds(prev => [...prev, id])
    }
  }

  function applyCompare() {
    if (selectedIds.length < 2) {
      alert('请至少选择 2 款纸尿裤')
      return
    }
    setSearchParams({ ids: selectedIds.join(',') })
  }

  function clearCompare() {
    setCompareItems([])
    setSelectedIds([])
    setSearchParams({})
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">纸尿裤对比</h1>
        {compareItems.length > 0 && (
          <button
            onClick={clearCompare}
            className="text-sm text-[var(--text-secondary)] hover:text-[var(--color-primary)]"
          >
            清空对比
          </button>
        )}
      </div>

      <div className="glass mb-6 p-4">
        <h3 className="mb-3 text-sm font-medium text-[var(--text-primary)]">选择纸尿裤（最多 5 款）</h3>
        <div className="flex flex-wrap gap-2">
          {availableDiapers.map(d => (
            <button
              key={d.id}
              onClick={() => toggleDiaper(d.id)}
              className={`rounded-[var(--radius-sm)] px-3 py-1.5 text-xs transition-all ${
                selectedIds.includes(d.id)
                  ? 'bg-[var(--color-primary)] text-white'
                  : 'bg-[var(--color-primary-lighter)] text-[var(--text-primary)] hover:bg-[var(--color-primary)] hover:bg-opacity-20'
              }`}
            >
              {d.brand} {d.model}
            </button>
          ))}
        </div>
        <button
          onClick={applyCompare}
          disabled={selectedIds.length < 2}
          className="mt-3 rounded-[var(--radius-sm)] bg-[var(--color-primary)] px-6 py-2 text-sm font-medium text-[var(--text-on-primary)] transition-all hover:opacity-90 disabled:opacity-40"
        >
          开始对比 ({selectedIds.length})
        </button>
      </div>

      {error && <div className="glass mb-6 px-4 py-3 text-center text-sm text-[var(--color-accent)]">{error}</div>}

      {loading && <div className="glass px-8 py-12 text-center text-[var(--text-secondary)]">加载中...</div>}

      {!loading && compareItems.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="glass px-4 py-3 text-left text-sm font-medium text-[var(--text-primary)]">指标</th>
                {compareItems.map(d => (
                  <th key={d.id} className="glass min-w-[160px] px-4 py-3 text-left text-sm font-medium text-[var(--text-primary)]">
                    <Link to={`/diapers/${d.id}`} className="hover:underline">
                      <div className="text-xs text-[var(--color-primary)]">{d.brand}</div>
                      <div>{d.model}</div>
                    </Link>
                    <div className="mt-1 text-xs text-[var(--text-secondary)]">
                      {d.avg_score > 0 ? `${d.avg_score.toFixed(1)} 分` : '暂无评分'} · {d.rating_count} 人
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {DIM_KEYS.map(dim => (
                <tr key={dim} className="border-t border-[rgba(255,255,255,0.05)]">
                  <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">{DIM_LABELS[dim]}</td>
                  {compareItems.map(d => {
                    const val = d.dimensions[dim as keyof typeof d.dimensions]?.avg ?? 0
                    const isBest = getBest(d, dim)
                    return (
                      <td key={d.id} className={`px-4 py-3 text-center ${isBest ? 'text-[var(--color-star)] font-bold' : 'text-[var(--text-primary)]'}`}>
                        {val > 0 ? val.toFixed(1) : '-'}
                        {isBest && <span className="ml-1 text-xs">★</span>}
                      </td>
                    )
                  })}
                </tr>
              ))}
              <tr className="border-t border-[rgba(255,255,255,0.05)]">
                <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">厚度</td>
                {compareItems.map(d => (
                  <td key={d.id} className="px-4 py-3 text-center text-sm text-[var(--text-primary)]">
                    {d.thickness}/5
                  </td>
                ))}
              </tr>
              <tr className="border-t border-[rgba(255,255,255,0.05)]">
                <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">吸收量</td>
                {compareItems.map(d => (
                  <td key={d.id} className="px-4 py-3 text-center text-sm text-[var(--text-primary)]">
                    {d.absorbency_adult || '-'}
                  </td>
                ))}
              </tr>
              <tr className="border-t border-[rgba(255,255,255,0.05)]">
                <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">参考价格</td>
                {compareItems.map(d => (
                  <td key={d.id} className="px-4 py-3 text-center text-sm text-[var(--text-primary)]">
                    {d.avg_price || '-'}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {!loading && compareItems.length === 0 && !error && (
        <div className="glass px-8 py-12 text-center text-[var(--text-secondary)]">
          选择纸尿裤开始对比
        </div>
      )}
    </div>
  )
}