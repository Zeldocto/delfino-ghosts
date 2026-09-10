/**
 * Times are stored as integer milliseconds and formatted for display here.
 * Runners write them a few different ways, so parsing is forgiving:
 *
 *   14.387    -> 14387
 *   0:37.337  -> 37337
 *   1:23.456  -> 83456
 *   1:23      -> 83000
 *   14        -> 14000
 *   1:02:03.4 -> 3723400
 */
export function parseTimeInput(input: string): number | null {
  const raw = input.trim().replace(',', '.')
  if (!raw) return null
  if (!/^(\d+:)?(\d+:)?\d+(\.\d{1,3})?$/.test(raw)) return null

  const parts = raw.split(':')
  if (parts.length > 3) return null

  let total = 0
  for (const part of parts) {
    const value = Number(part)
    if (!Number.isFinite(value)) return null
    total = total * 60 + value
  }

  const ms = Math.round(total * 1000)
  if (ms <= 0 || ms > 86_400_000) return null
  return ms
}

/** 14387 -> "14.387", 83456 -> "1:23.456". Matches how runners quote times. */
export function formatTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return ''

  const totalSeconds = Math.floor(ms / 1000)
  const millis = String(ms % 1000).padStart(3, '0')
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${millis}`
  }
  if (minutes > 0) {
    return `${minutes}:${String(seconds).padStart(2, '0')}.${millis}`
  }
  return `${seconds}.${millis}`
}

export function validateTimeInput(input: string): string | null {
  if (!input.trim()) return null
  return parseTimeInput(input) === null ? 'Use a time like 14.387 or 1:23.456.' : null
}
