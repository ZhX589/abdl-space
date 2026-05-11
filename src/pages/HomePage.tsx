import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { getDiapers, getGuessRecommend, type DiaperListItem, type GuessRecommendItem } from '../lib/api.ts'
import { DiaperCard } from '../components/DiaperCard'

/** 首页 */
export function HomePage() {
  const [diapers, setDiapers] = useState<DiaperListItem[]>([])
  const [guessList, setGuessList] = useState<GuessRecommendItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      getDiapers({ sort: 'avg_score', order: 'DESC', limit: 6 }),
      getGuessRecommend()
    ]).then(([d, g]) => {
      if (!cancelled) {
        setDiapers(d.diapers)
        setGuessList(g.recommendations)
      }
    }).catch(() => {}).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  return (
    <div className="flex flex-col gap-8">
      <div className="glass px-8 py-10 text-center">
        <h1 className="mb-3 text-3xl font-bold text-[var(--color-primary)]">
          ☁️ ABDL Space
        </h1>
        <p className="mb-6 text-[var(--text-secondary)]">
          纸尿裤社区百科 · 数据驱动的产品信息平台
        </p>
        <div className="flex justify-center gap-3">
          <Link
            to="/diapers"
            className="rounded-[var(--radius-sm)] bg-[var(--color-primary)] px-6 py-3 font-medium text-[var(--text-on-primary)] transition-all duration-200 hover:opacity-90"
          >
            浏览纸尿裤
          </Link>
          <Link
            to="/wiki"
            className="rounded-[var(--radius-sm)] border border-[var(--color-primary)] px-6 py-3 font-medium text-[var(--color-primary)] transition-all duration-200 hover:bg-[var(--color-primary-lighter)]"
          >
            Wiki 百科
          </Link>
        </div>
      </div>

      {!loading && guessList.length > 0 && (
        <div>
          <h2 className="mb-4 text-xl font-bold text-[var(--text-primary)]">猜你喜欢</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {guessList.map(item => (
              <Link
                key={item.id}
                to={`/diapers/${item.id}`}
                className="glass block overflow-hidden p-4 transition-all duration-300 hover:scale-[1.02]"
              >
                <div className="mb-2 flex items-start justify-between">
                  <div>
                    <span className="text-xs text-[var(--color-primary)]">{item.brand}</span>
                    <h3 className="font-bold text-[var(--text-primary)]">{item.model}</h3>
                  </div>
                  <span className="rounded-[var(--radius-sm)] bg-[var(--color-primary-lighter)] px-2 py-0.5 text-xs font-medium text-[var(--color-primary)]">
                    {item.avg_score > 0 ? `${item.avg_score.toFixed(1)} 分` : '新上线'}
                  </span>
                </div>
                <p className="text-sm text-[var(--text-secondary)]">{item.reason}</p>
                <div className="mt-2 flex gap-3 text-xs text-[var(--text-secondary)]">
                  <span>厚度: {item.thickness}/5</span>
                  <span>{item.rating_count} 人评分</span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {!loading && diapers.length > 0 && (
        <div>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xl font-bold text-[var(--text-primary)]">高分纸尿裤</h2>
            <Link to="/diapers" className="text-sm text-[var(--color-primary)] hover:underline">
              查看全部 →
            </Link>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {diapers.map(d => <DiaperCard key={d.id} diaper={d} />)}
          </div>
        </div>
      )}

      {loading && (
        <div className="glass px-8 py-12 text-center text-[var(--text-secondary)]">加载中...</div>
      )}
    </div>
  )
}
