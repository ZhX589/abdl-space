import { Link } from 'react-router-dom'

/** 登录页 */
export function LoginPage() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="glass w-full max-w-sm px-8 py-10">
        <h1 className="mb-6 text-center text-2xl font-bold text-[var(--color-primary)]">
          登录
        </h1>
        <p className="text-center text-sm text-[var(--text-secondary)]">
          登录表单 — 待实现
        </p>
        <p className="mt-4 text-center text-sm text-[var(--text-secondary)]">
          还没有账号？
          <Link to="/register" className="text-[var(--color-primary)] hover:underline">注册</Link>
        </p>
      </div>
    </div>
  )
}
