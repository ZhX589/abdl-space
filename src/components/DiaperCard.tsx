import { Link } from 'react-router-dom'
import type { DiaperListItem } from '../lib/api.ts'
import { RatingDisplay } from './RatingDisplay'

interface DiaperCardProps {
  diaper: DiaperListItem
}

/** 纸尿裤卡片组件 */
export function DiaperCard({ diaper }: DiaperCardProps) {
  return (
    <Link
      to={`/diapers/${diaper.id}`}
      className="glass block overflow-hidden transition-all duration-300 hover:scale-[1.02] hover:shadow-lg"
    >
      <div className="p-5">
        <div className="mb-2 flex items-start justify-between">
          <div>
            <span className="text-xs font-medium text-[var(--color-primary)]">{diaper.brand}</span>
            <h3 className="text-lg font-bold text-[var(--text-primary)]">{diaper.model}</h3>
          </div>
          <span className="rounded-[var(--radius-sm)] bg-[var(--color-primary-light)] px-2 py-0.5 text-xs font-medium text-[var(--color-primary)]">
            {diaper.product_type}
          </span>
        </div>

        <div className="mb-3 flex flex-wrap gap-3 text-sm text-[var(--text-secondary)]">
          <span>厚度: {'●'.repeat(diaper.thickness)}{'○'.repeat(5 - diaper.thickness)}</span>
          <span>{diaper.absorbency_adult}</span>
          <span>{diaper.avg_price}</span>
        </div>

        <div className="mb-3 flex flex-wrap gap-1">
          {diaper.sizes.map((s) => (
            <span key={s.label} className="rounded-[4px] bg-[var(--color-primary-lighter)] px-1.5 py-0.5 text-xs text-[var(--color-primary)]">
              {s.label}
            </span>
          ))}
        </div>

        <div className="flex items-center justify-between border-t border-[rgba(0,0,0,0.06)] pt-3">
          <RatingDisplay score={diaper.avg_score} count={diaper.rating_count} />
        </div>
      </div>
    </Link>
  )
}
