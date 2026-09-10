import { useId } from 'react'
import { SORT_OPTIONS, type SortKey } from '../types'

interface SortSelectorProps {
  value: SortKey
  onChange: (value: SortKey) => void
}

export function SortSelector({ value, onChange }: SortSelectorProps) {
  const id = useId()
  return (
    <div className="toolbar-sort">
      <label htmlFor={id}>Sort</label>
      <select
        id={id}
        className="select"
        value={value}
        onChange={(e) => onChange(e.target.value as SortKey)}
      >
        {SORT_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  )
}
