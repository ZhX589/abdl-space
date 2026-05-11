interface RatingDisplayProps {
  score: number
  count: number
  size?: 'sm' | 'md'
}

/** 综合评分展示组件 */
export function RatingDisplay({ score, count, size = 'md' }: RatingDisplayProps) {
  const textClass = size === 'sm' ? 'text-xs' : 'text-sm'
  const scoreClass = size === 'sm' ? 'text-lg' : 'text-2xl'

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1">
        <span className={`font-bold text-[var(--color-star)] ${scoreClass}`}>
          {score > 0 ? score.toFixed(1) : '-'}
        </span>
      </div>
      <span className={`${textClass} text-[var(--text-secondary)]`}>
        {count > 0 ? `${count} 人评分` : '暂无评分'}
      </span>
    </div>
  )
}
