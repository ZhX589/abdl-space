import { useParams, Link } from 'react-router-dom'

/** Wiki 详情页 */
export function WikiDetailPage() {
  const { slug } = useParams<{ slug: string }>()

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">
          {slug ?? 'Wiki 页面'}
        </h1>
        <Link
          to={`/wiki/${slug}/edit`}
          className="rounded-[var(--radius-sm)] bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--text-on-primary)] transition-all duration-200 hover:opacity-90"
        >
          编辑
        </Link>
      </div>
      <div className="glass px-8 py-10 text-center text-[var(--text-secondary)]">
        页面内容、评论区、评分 — 待实现
      </div>
    </div>
  )
}
