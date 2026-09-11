import { useId } from 'react'
import { formatNumber } from '../utils/format'
import type { LevelFacet } from '../types'

interface LevelSelectorProps {
  value: string
  levels: LevelFacet[]
  loading?: boolean
  onChange: (value: string) => void
}

/**
 * Only lists levels that actually have ghosts, so every option returns
 * something. Counts are shown because "Pinna Park 3 (12)" tells you whether
 * it is worth opening.
 */
export function LevelSelector({ value, levels, loading = false, onChange }: LevelSelectorProps) {
  const id = useId()

  return (
    <div className="toolbar-sort">
      <label htmlFor={id}>Level</label>
      <select
        id={id}
        className="select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={loading && levels.length === 0}
      >
        <option value="">All levels</option>
        {levels.map((entry) => (
          <option value={entry.level} key={entry.level}>
            {entry.level} ({formatNumber(entry.ghost_count)})
          </option>
        ))}
      </select>
    </div>
  )
}
