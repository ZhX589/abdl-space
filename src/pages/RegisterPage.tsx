import { Link } from 'react-router-dom'

/** 注册页 */
export function RegisterPage() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="glass w-full max-w-sm px-8 py-10">
        <h1 className="mb-6 text-center text-2xl font-bold text-[var(--color-primary)]">
          注册
        </h1>
        <p className="text-center text-sm text-[var(--text-secondary)]">
          注册表单 — 待实现
        </p>
        <p className="mt-4 text-center text-sm text-[var(--text-secondary)]">
          已有账号？
          <Link to="/login" className="text-[var(--color-primary)] hover:underline">登录</Link>
        </p>
      </div>
    </div>
  )
}
