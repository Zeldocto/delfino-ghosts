import { useId, useState } from 'react'
import type { ReactNode } from 'react'

interface TooltipProps {
  label: string
  children: ReactNode
  /** Extra class for the trigger wrapper. */
  className?: string
}

/**
 * Shows on hover and on keyboard focus, and is wired to its trigger with
 * aria-describedby so assistive tech announces it rather than relying on the
 * visual bubble.
 */
export function Tooltip({ label, children, className }: TooltipProps) {
  const [open, setOpen] = useState(false)
  const id = useId()

  return (
    <span
      className={`tip${className ? ` ${className}` : ''}`}
      tabIndex={0}
      aria-describedby={id}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setOpen(false)
      }}
    >
      {children}
      {open && (
        <span className="tip-bubble" role="tooltip" id={id}>
          {label}
        </span>
      )}
      {!open && (
        <span className="sr-only" id={id}>
          {label}
        </span>
      )}
    </span>
  )
}
