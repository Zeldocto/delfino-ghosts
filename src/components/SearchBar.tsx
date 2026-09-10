import { useId } from 'react'

interface SearchBarProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  label?: string
}

export function SearchBar({ value, onChange, placeholder = 'Search ghosts...', label = 'Search ghosts' }: SearchBarProps) {
  const id = useId()
  return (
    <div className="toolbar-search">
      <label className="sr-only" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="input"
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
    </div>
  )
}
