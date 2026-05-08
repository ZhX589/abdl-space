/** 全局页脚 */
export function Footer() {
  return (
    <footer className="border-t border-[rgba(0,0,0,0.06)] py-6 text-center text-sm text-[var(--text-secondary)]">
      <p>&copy; {new Date().getFullYear()} ABDL Space Wiki</p>
    </footer>
  )
}
