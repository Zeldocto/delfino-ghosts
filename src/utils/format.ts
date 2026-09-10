export function formatNumber(n: number): string {
  return new Intl.NumberFormat('en-US').format(n)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/** Compact date for dense listing rows: "Sep 8" this year, "Sep 8 2025" otherwise. */
export function formatShortDate(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === now.getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' }
  return new Intl.DateTimeFormat('en-US', opts).format(d)
}

export function formatLongDate(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(iso))
}

export function formatMonthYear(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long' }).format(new Date(iso))
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many
}
