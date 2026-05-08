import { Link } from 'react-router-dom'

/** 首页 */
export function HomePage() {
  return (
    <div className="flex flex-col items-center gap-8 py-12 text-center">
      <div className="glass max-w-lg px-8 py-10">
        <h1 className="mb-4 text-3xl font-bold text-[var(--color-primary)]">
          ☁️ ABDL Space Wiki
        </h1>
        <p className="mb-6 text-[var(--text-secondary)]">
          社区协作的产品百科平台
        </p>
        <Link
          to="/wiki"
          className="inline-block rounded-[var(--radius-sm)] bg-[var(--color-primary)] px-6 py-3 font-medium text-[var(--text-on-primary)] transition-all duration-200 hover:opacity-90"
        >
          浏览 Wiki
        </Link>
      </div>
    </div>
  )
}
