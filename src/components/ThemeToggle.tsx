import { useTheme } from '../hooks/useTheme'

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme()
  return (
    <button
      type="button"
      className="btn btn-quiet btn-sm"
      onClick={toggleTheme}
      aria-pressed={theme === 'dark'}
    >
      {theme === 'dark' ? 'Dark mode' : 'Light mode'}
    </button>
  )
}
