import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getDiaper, getDiaperRatings, getDiaperFeelings, type DiaperDetailResponse, type RatingsResponse, type FeelingsResponse } from '../lib/api.ts'
import { RatingDisplay } from '../components/RatingDisplay'
import { RadarChart } from '../components/RadarChart'
import { formatDate } from '../lib/utils.ts'

/** 纸尿裤详情页 */
export function DiaperDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [diaperData, setDiaperData] = useState<DiaperDetailResponse | null>(null)
  const [ratings, setRatings] = useState<RatingsResponse | null>(null)
  const [feelings, setFeelings] = useState<FeelingsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'ratings' | 'feelings' | 'wiki'>('ratings')

  useEffect(() => {
    if (!id) return
    let cancelled = false
    Promise.all([
      getDiaper(parseInt(id)),
      getDiaperRatings(parseInt(id)),
      getDiaperFeelings(parseInt(id))
    ]).then(([d, r, f]) => {
      if (!cancelled) {
        setDiaperData(d)
        setRatings(r)
        setFeelings(f)
        setError(null)
      }
    }).catch(e => {
      if (!cancelled) setError(e instanceof Error ? e.message : '加载失败')
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [id])

  if (loading) return <div className="glass px-8 py-12 text-center text-[var(--text-secondary)]">加载中...</div>
  if (error) return <div className="glass px-8 py-4 text-center text-[var(--color-accent)]">{error}</div>
  if (!diaperData) return <div className="glass px-8 py-12 text-center text-[var(--text-secondary)]">未找到</div>

  const { diaper, reviews, wiki } = diaperData

  return (
    <div>
      <Link to="/diapers" className="mb-4 inline-block text-sm text-[var(--text-secondary)] transition-colors hover:text-[var(--color-primary)]">
        ← 返回列表
      </Link>

      <div className="glass mb-6 p-6">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
          <div>
            <span className="text-sm font-medium text-[var(--color-primary)]">{diaper.brand}</span>
            <h1 className="text-2xl font-bold text-[var(--text-primary)]">{diaper.model}</h1>
            <span className="text-sm text-[var(--text-secondary)]">{diaper.product_type}</span>
          </div>
          <RatingDisplay score={diaper.avg_score} count={diaper.rating_count} />
        </div>

        <div className="mb-6 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div className="rounded-[var(--radius-sm)] bg-[var(--color-primary-lighter)] p-3">
            <div className="text-xs text-[var(--text-secondary)]">厚度</div>
            <div className="font-medium text-[var(--text-primary)]">{'●'.repeat(diaper.thickness)}{'○'.repeat(5 - diaper.thickness)}</div>
          </div>
          <div className="rounded-[var(--radius-sm)] bg-[var(--color-primary-lighter)] p-3">
            <div className="text-xs text-[var(--text-secondary)]">吸水量(成人)</div>
            <div className="font-medium text-[var(--text-primary)]">{diaper.absorbency_adult}</div>
          </div>
          <div className="rounded-[var(--radius-sm)] bg-[var(--color-primary-lighter)] p-3">
            <div className="text-xs text-[var(--text-secondary)]">参考价格</div>
            <div className="font-medium text-[var(--text-primary)]">{diaper.avg_price}</div>
          </div>
          <div className="rounded-[var(--radius-sm)] bg-[var(--color-primary-lighter)] p-3">
            <div className="text-xs text-[var(--text-secondary)]">舒适度</div>
            <div className="font-medium text-[var(--text-primary)]">{diaper.comfort ? `${diaper.comfort}/5` : '-'}</div>
          </div>
        </div>

        <div className="mb-4">
          <h3 className="mb-1 text-sm font-medium text-[var(--text-primary)]">适用尺码</h3>
          <div className="flex flex-wrap gap-2">
            {diaper.sizes.map(s => (
              <span key={s.label} className="rounded-[var(--radius-sm)] border border-[var(--color-primary-light)] px-2 py-1 text-xs text-[var(--color-primary)]">
                {s.label} (腰 {s.waist_min}-{s.waist_max}cm / 臀 {s.hip_min}-{s.hip_max}cm)
              </span>
            ))}
          </div>
        </div>

        <div className="mb-4">
          <h3 className="mb-1 text-sm font-medium text-[var(--text-primary)]">材质</h3>
          <p className="text-sm text-[var(--text-secondary)]">{diaper.material}</p>
        </div>

        <div>
          <h3 className="mb-1 text-sm font-medium text-[var(--text-primary)]">特点</h3>
          <p className="text-sm text-[var(--text-secondary)]">{diaper.features}</p>
        </div>
      </div>

      {ratings?.stats && ratings.stats.count > 0 && (
        <div className="glass mb-6 p-6">
          <h2 className="mb-4 text-lg font-bold text-[var(--text-primary)]">评分雷达图</h2>
          <div className="flex justify-center">
            <RadarChart dimensions={ratings.stats.dimensions} size={260} />
          </div>
          <div className="mt-4 text-center text-sm text-[var(--text-secondary)]">
            综合评分: <span className="font-bold text-[var(--color-star)]">{ratings.stats.composite.toFixed(1)}</span> ({ratings.stats.count} 人评分)
          </div>
        </div>
      )}

      <div className="glass mb-6 overflow-hidden">
        <div className="flex border-b border-[rgba(0,0,0,0.06)]">
          {(['ratings', 'feelings', 'wiki'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-3 text-sm font-medium transition-colors ${
                activeTab === tab
                  ? 'border-b-2 border-[var(--color-primary)] text-[var(--color-primary)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {tab === 'ratings' ? `评分 (${reviews.length})` : tab === 'feelings' ? `感受 (${feelings?.count ?? 0})` : 'Wiki'}
            </button>
          ))}
        </div>

        <div className="p-4">
          {activeTab === 'ratings' && (
            <div>
              {reviews.length === 0 ? (
                <p className="py-4 text-center text-sm text-[var(--text-secondary)]">暂无评分</p>
              ) : (
                <div className="space-y-4">
                  {reviews.map(review => (
                    <div key={review.id} className="rounded-[var(--radius-sm)] bg-[var(--color-primary-lighter)] p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-[var(--text-primary)]">{review.user.username}</span>
                          <span className="text-xs text-[var(--text-secondary)]">{formatDate(review.created_at)}</span>
                        </div>
                        <span className="text-sm font-bold text-[var(--color-star)]">
                          {((review.absorption_score + review.fit_score + review.comfort_score + review.thickness_score + review.appearance_score + review.value_score) / 6).toFixed(1)}
                        </span>
                      </div>
                      <div className="mb-2 grid grid-cols-3 gap-1 text-xs">
                        {Object.entries({
                          absorption_score: '吸收力',
                          fit_score: '贴合度',
                          comfort_score: '舒适感',
                          thickness_score: '轻薄度',
                          appearance_score: '外观',
                          value_score: '性价比'
                        } as Record<string, string>).map(([key, label]) => (
                          <div key={key} className="flex justify-between">
                            <span className="text-[var(--text-secondary)]">{label}</span>
                            <span className="text-[var(--text-primary)]">{review[key as keyof typeof review]}/10</span>
                          </div>
                        ))}
                      </div>
                      {review.review && (
                        <p className="text-sm text-[var(--text-secondary)]">{review.review}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'feelings' && (
            <div>
              {!feelings || feelings.feelings.length === 0 ? (
                <p className="py-4 text-center text-sm text-[var(--text-secondary)]">暂无使用感受</p>
              ) : (
                <>
                  {feelings.stats && (
                    <div className="mb-4 grid grid-cols-5 gap-2">
                      {Object.entries({
                        looseness: '松紧度',
                        softness: '柔软度',
                        dryness: '干爽度',
                        odor_control: '锁味',
                        quietness: '静音'
                      } as Record<string, string>).map(([key, label]) => (
                        <div key={key} className="rounded-[var(--radius-sm)] bg-[var(--color-primary-lighter)] p-2 text-center">
                          <div className="text-[10px] text-[var(--text-secondary)]">{label}</div>
                          <div className={`text-sm font-bold ${(feelings.stats[key as keyof typeof feelings.stats] as number) >= 0 ? 'text-[var(--color-primary)]' : 'text-[var(--color-accent)]'}`}>
                            {(feelings.stats[key as keyof typeof feelings.stats] as number).toFixed(1)}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="space-y-3">
                    {feelings.feelings.map(f => (
                      <div key={f.id} className="rounded-[var(--radius-sm)] bg-[var(--color-primary-lighter)] p-3">
                        <div className="mb-1 flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-[var(--text-primary)]">{f.user.username}</span>
                            <span className="rounded-[4px] bg-[var(--color-primary)] px-1.5 py-0.5 text-[10px] text-[var(--text-on-primary)]">{f.size}</span>
                          </div>
                          <span className="text-xs text-[var(--text-secondary)]">{formatDate(f.created_at)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {activeTab === 'wiki' && (
            <div>
              {wiki ? (
                <div>
                  <Link
                    to={`/wiki/${wiki.title.toLowerCase().replace(/\s+/g, '-')}`}
                    className="font-medium text-[var(--color-primary)] hover:underline"
                  >
                    {wiki.title}
                  </Link>
                  <p className="mt-1 text-xs text-[var(--text-secondary)]">分类: {wiki.category}</p>
                  <p className="mt-2 line-clamp-4 text-sm text-[var(--text-secondary)]">{wiki.content}</p>
                </div>
              ) : (
                <p className="py-4 text-center text-sm text-[var(--text-secondary)]">暂无 Wiki 页面</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
