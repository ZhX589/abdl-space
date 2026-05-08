import { useParams, Link } from 'react-router-dom'

/** Wiki 编辑页 */
export function WikiEditPage() {
  const { slug } = useParams<{ slug: string }>()

  return (
    <div>
      <div className="mb-6 flex items-center gap-4">
        <Link
          to={`/wiki/${slug}`}
          className="text-sm text-[var(--text-secondary)] transition-colors duration-200 hover:text-[var(--color-primary)]"
        >
          ← 返回详情
        </Link>
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">
          编辑: {slug ?? '新页面'}
        </h1>
      </div>
      <div className="glass px-8 py-10 text-center text-[var(--text-secondary)]">
        编辑器 — 待实现
      </div>
    </div>
  )
}
