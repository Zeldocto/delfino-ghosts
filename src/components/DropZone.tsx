import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { GHOST_EXTENSION } from '../types'

interface DropZoneProps {
  onFiles: (files: File[]) => void
  disabled?: boolean
  /** Shown under the main line, e.g. remaining slots. */
  hint?: string
}

/**
 * Accepts a whole folder's worth of ghosts at once, by drop or by browsing.
 *
 * Drag tracking uses a counter rather than a boolean: dragenter/dragleave fire
 * for every child element the pointer crosses, so a naive boolean flickers off
 * the moment the cursor moves over the inner text.
 */
export function DropZone({ onFiles, disabled = false, hint }: DropZoneProps) {
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const inputId = useId()

  // Without this, dropping slightly off-target makes the browser navigate away
  // to the file, losing whatever is already queued.
  useEffect(() => {
    const swallow = (event: DragEvent) => {
      if (event.dataTransfer?.types?.includes('Files')) event.preventDefault()
    }
    window.addEventListener('dragover', swallow)
    window.addEventListener('drop', swallow)
    return () => {
      window.removeEventListener('dragover', swallow)
      window.removeEventListener('drop', swallow)
    }
  }, [])

  const takeFiles = useCallback(
    (list: FileList | null) => {
      if (!list || list.length === 0) return
      onFiles(Array.from(list))
    },
    [onFiles],
  )

  function handleDragEnter(event: React.DragEvent) {
    if (disabled || !event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    depth.current += 1
    setDragging(true)
  }

  function handleDragOver(event: React.DragEvent) {
    if (disabled || !event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  function handleDragLeave(event: React.DragEvent) {
    event.preventDefault()
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) setDragging(false)
  }

  function handleDrop(event: React.DragEvent) {
    event.preventDefault()
    depth.current = 0
    setDragging(false)
    if (disabled) return
    takeFiles(event.dataTransfer.files)
  }

  return (
    <div
      className={`dropzone${dragging ? ' is-dragging' : ''}${disabled ? ' is-disabled' : ''}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={() => !disabled && inputRef.current?.click()}
      onKeyDown={(event) => {
        if (disabled) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          inputRef.current?.click()
        }
      }}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-describedby={`${inputId}-hint`}
    >
      <p className="dropzone-line">
        {dragging ? 'Drop to add these ghosts' : 'Drop ghost files here, or click to browse'}
      </p>
      <p className="dropzone-hint" id={`${inputId}-hint`}>
        {hint ?? `Any number of ${GHOST_EXTENSION} files, up to 2 MB each.`}
      </p>

      <input
        ref={inputRef}
        id={inputId}
        className="sr-only"
        type="file"
        accept={GHOST_EXTENSION}
        multiple
        disabled={disabled}
        onChange={(event) => {
          takeFiles(event.target.files)
          // Reset so picking the same file twice still fires a change event.
          event.target.value = ''
        }}
      />
    </div>
  )
}
