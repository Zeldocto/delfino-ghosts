import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface TooltipProps {
  label: string
  children: ReactNode
  /** Extra class for the trigger wrapper. */
  className?: string
}

const GAP = 6
const MARGIN = 8

/**
 * Shows on hover and on keyboard focus, and is wired to its trigger with
 * aria-describedby so assistive tech announces it rather than relying on the
 * visual bubble.
 *
 * The bubble is rendered into <body> and placed against the viewport, so a
 * container with overflow: hidden (the ellipsis cells in GhostRow) cannot clip
 * it. It sits above the trigger, below it when there is no room, and is kept
 * inside the window.
 */
export function Tooltip({ label, children, className }: TooltipProps) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const trigger = useRef<HTMLSpanElement>(null)
  const bubble = useRef<HTMLSpanElement>(null)
  const id = useId()

  useLayoutEffect(() => {
    if (!open || !trigger.current || !bubble.current) {
      setPosition(null)
      return
    }
    const t = trigger.current.getBoundingClientRect()
    const b = bubble.current.getBoundingClientRect()
    const above = t.top - GAP - b.height
    const left = t.left + t.width / 2 - b.width / 2
    setPosition({
      top: above >= MARGIN ? above : t.bottom + GAP,
      left: Math.max(MARGIN, Math.min(left, window.innerWidth - b.width - MARGIN)),
    })
  }, [open, label])

  // A fixed bubble would drift from its trigger on scroll, so close it instead.
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  // Measured once while hidden, then shown in place.
  const style: CSSProperties = position ?? { top: 0, left: 0, visibility: 'hidden' }

  return (
    <span
      ref={trigger}
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
      {open &&
        createPortal(
          <span ref={bubble} className="tip-bubble" role="tooltip" id={id} style={style}>
            {label}
          </span>,
          document.body,
        )}
      {!open && (
        <span className="sr-only" id={id}>
          {label}
        </span>
      )}
    </span>
  )
}
