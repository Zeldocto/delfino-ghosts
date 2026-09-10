import type { ReactNode } from 'react'

type NoticeTone = 'info' | 'error' | 'ok' | 'warn'

export function Notice({ tone = 'info', children }: { tone?: NoticeTone; children: ReactNode }) {
  const cls = tone === 'error' ? 'notice notice-error' : tone === 'ok' ? 'notice notice-ok' : tone === 'warn' ? 'notice notice-warn' : 'notice'
  return (
    <p className={cls} role={tone === 'error' ? 'alert' : undefined}>
      {children}
    </p>
  )
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>
}

/** Placeholder rows that keep the listing from jumping once data lands. */
export function ListingSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading ghosts">
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton-row" key={i}>
          <span className="skeleton-bar" style={{ width: `${38 + ((i * 13) % 34)}%` }} />
        </div>
      ))}
    </div>
  )
}
