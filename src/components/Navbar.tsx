import { useState } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { useTheme } from '../hooks/useTheme'

/** 全局导航栏 */
export function Navbar() {
  const { theme, toggleTheme } = useTheme()
  const [menuOpen, setMenuOpen] = useState(false)

  const navLinks = [
    { to: '/', label: '首页' },
    { to: '/diapers', label: '纸尿裤' },
    { to: '/wiki', label: 'Wiki' },
    { to: '/rankings', label: '排行榜' },
    { to: '/compare', label: '对比' },
  ]

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `px-3 py-2 rounded-[var(--radius-sm)] text-sm font-medium transition-colors duration-200 ${
      isActive
        ? 'text-[var(--text-on-primary)] bg-[var(--color-primary)]'
        : 'text-[var(--text-primary)] hover:bg-[var(--color-primary-lighter)]'
    }`

  return (
    <header className="glass sticky top-0 z-50 rounded-none border-x-0 border-t-0">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link to="/" className="flex items-center gap-2 text-lg font-bold text-[var(--color-primary)]">
          <span className="text-xl">☁️</span>
          <span>ABDL Space</span>
        </Link>

        <div className="hidden items-center gap-1 md:flex">
          {navLinks.map((link) => (
            <NavLink key={link.to} to={link.to} className={linkClass} end={link.to === '/'}>
              {link.label}
            </NavLink>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleTheme}
            className="rounded-[var(--radius-sm)] p-2 text-[var(--text-secondary)] transition-colors duration-200 hover:bg-[var(--color-primary-lighter)] hover:text-[var(--color-primary)]"
            aria-label={theme === 'dark' ? '切换到亮色模式' : '切换到暗色模式'}
          >
            {theme === 'dark' ? (
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2" /><path d="M12 20v2" />
                <path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" />
                <path d="M2 12h2" /><path d="M20 12h2" />
                <path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
              </svg>
            )}
          </button>

          <Link
            to="/login"
            className="hidden rounded-[var(--radius-sm)] bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--text-on-primary)] transition-all duration-200 hover:opacity-90 md:block"
          >
            登录
          </Link>

          <button
            type="button"
            onClick={() => setMenuOpen(!menuOpen)}
            className="rounded-[var(--radius-sm)] p-2 text-[var(--text-secondary)] transition-colors duration-200 hover:bg-[var(--color-primary-lighter)] md:hidden"
            aria-label="菜单"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {menuOpen ? (
                <>
                  <path d="M18 6 6 18" /><path d="m6 6 12 12" />
                </>
              ) : (
                <>
                  <path d="M4 12h16" /><path d="M4 6h16" /><path d="M4 18h16" />
                </>
              )}
            </svg>
          </button>
        </div>
      </nav>

      {menuOpen && (
        <div className="border-t border-[rgba(255,255,255,0.1)] px-4 py-3 md:hidden">
          <div className="flex flex-col gap-1">
            {navLinks.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                className={linkClass}
                end={link.to === '/'}
                onClick={() => setMenuOpen(false)}
              >
                {link.label}
              </NavLink>
            ))}
            <Link
              to="/login"
              className="mt-2 rounded-[var(--radius-sm)] bg-[var(--color-primary)] px-4 py-2 text-center text-sm font-medium text-[var(--text-on-primary)] transition-all duration-200 hover:opacity-90"
              onClick={() => setMenuOpen(false)}
            >
              登录
            </Link>
          </div>
        </div>
      )}
    </header>
  )
}
