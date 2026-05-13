import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { getRankings, type RankingItem } from '../lib/api.ts'

type RankingType = 'hot' | 'absorbency' | 'popular' | 'dimension'
type Dimension = 'absorption_score' | 'fit_score' | 'comfort_score' | 'thickness_score' | 'appearance_score' | 'value_score'

const TYPE_LABELS: Record<RankingType, string> = {
  hot: '综合热度',
  absorbency: '吸收量',
  popular: '评分人数',
  dimension: '分维度'
}

const DIM_LABELS: Record<Dimension, string> = {
  absorption_score: '吸收力',
  fit_score: '贴合度',
  comfort_score: '舒适感',
  thickness_score: '轻薄度',
  appearance_score: '外观',
  value_score: '性价比'
}

/** 排行榜页 */
export function RankingsPage() {
  const [type, setType] = useState<RankingType>('hot')
  const [dimension, setDimension] = useState<Dimension>('absorption_score')
  const [items, setItems] = useState<RankingItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const fetchData = async () => {
      try {
        const params = type === 'dimension' ? { type, dimension } : { type }
        const data = await getRankings(params)
        if (!cancelled) setItems(data.rankings)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchData()
    return () => { cancelled = true }
  }, [type, dimension])

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-[var(--text-primary)]">排行榜</h1>

      <div className="glass mb-6 flex flex-wrap gap-2 p-4">
        {(Object.keys(TYPE_LABELS) as RankingType[]).map(t => (
          <button
            key={t}
            onClick={() => setType(t)}
            className={`rounded-[var(--radius-sm)] px-4 py-2 text-sm font-medium transition-all ${type === t ? 'bg-[var(--color-primary)] text-white' : 'text-[var(--text-secondary)] hover:bg-[var(--color-primary-lighter)]'}`}
          >
            {TYPE_LABELS[t]}
          </button>
        ))}
      </div>

      {type === 'dimension' && (
        <div className="glass mb-6 flex flex-wrap gap-2 p-4">
          {(Object.keys(DIM_LABELS) as Dimension[]).map(d => (
            <button
              key={d}
              onClick={() => setDimension(d)}
              className={`rounded-[var(--radius-sm)] px-3 py-1.5 text-xs font-medium transition-all ${dimension === d ? 'bg-[var(--color-primary)] text-white' : 'text-[var(--text-secondary)] hover:bg-[var(--color-primary-lighter)]'}`}
            >
              {DIM_LABELS[d]}
            </button>
          ))}
        </div>
      )}

      {error && <div className="glass mb-6 px-4 py-3 text-center text-sm text-[var(--color-accent)]">{error}</div>}

      {loading ? (
        <div className="glass px-8 py-12 text-center text-[var(--text-secondary)]">加载中...</div>
      ) : items.length === 0 ? (
        <div className="glass px-8 py-12 text-center text-[var(--text-secondary)]">暂无数据</div>
      ) : (
        <div className="space-y-3">
          {items.map((item, i) => (
            <Link
              key={item.id}
              to={`/diapers/${item.id}`}
              className="glass flex items-center gap-4 p-4 transition-all duration-200 hover:scale-[1.01]"
            >
              <span className={`w-8 text-center text-lg font-bold ${i < 3 ? 'text-[var(--color-primary)]' : 'text-[var(--text-secondary)]'}`}>
                {i + 1}
              </span>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[var(--color-primary)]">{item.brand}</span>
                  <span className="font-medium text-[var(--text-primary)]">{item.model}</span>
                </div>
                <div className="mt-1 flex gap-3 text-xs text-[var(--text-secondary)]">
                  <span>厚度: {item.thickness}/5</span>
                  {item.absorbency_adult && <span>吸收: {item.absorbency_adult}</span>}
                  <span>{item.rating_count} 人评分</span>
                </div>
              </div>
              <div className="text-right">
                <span className="text-lg font-bold text-[var(--color-star)]">
                  {Number(item.avg_score).toFixed(1)}
                </span>
                <span className="ml-1 text-xs text-[var(--text-secondary)]">分</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}