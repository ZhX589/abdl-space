import { Link } from 'react-router-dom'

/** 404 页面 */
export function NotFoundPage() {
  return (
    <div className="flex flex-col items-center gap-6 py-20 text-center">
      <div className="text-6xl">🌫️</div>
      <h1 className="text-3xl font-bold text-[var(--text-primary)]">404</h1>
      <p className="text-[var(--text-secondary)]">页面不存在</p>
      <Link
        to="/"
        className="rounded-[var(--radius-sm)] bg-[var(--color-primary)] px-6 py-3 font-medium text-[var(--text-on-primary)] transition-all duration-200 hover:opacity-90"
      >
        返回首页
      </Link>
    </div>
  )
}
