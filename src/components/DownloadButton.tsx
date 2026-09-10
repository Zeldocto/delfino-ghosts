import { useState } from 'react'
import { downloadGhost } from '../lib/downloads'
import { useAuth } from '../lib/auth'
import { friendlyError } from '../lib/errors'
import type { GhostListing } from '../types'

interface DownloadButtonProps {
  ghost: Pick<GhostListing, 'id' | 'user_id' | 'file_path' | 'original_filename' | 'title'>
  /** Wider label + primary styling for the ghost detail page. */
  prominent?: boolean
  onCounted?: (count: number | null) => void
}

export function DownloadButton({ ghost, prominent = false, onCounted }: DownloadButtonProps) {
  const { user } = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleClick() {
    setBusy(true)
    setError(null)
    try {
      const outcome = await downloadGhost(ghost, user?.id ?? null)
      if (outcome.counted) onCounted?.(outcome.count)
    } catch (err) {
      setError(friendlyError(err, 'That file could not be downloaded right now.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className={`btn${prominent ? ' btn-primary' : ' btn-sm'}`}
        onClick={handleClick}
        disabled={busy}
        aria-label={`Download ${ghost.title}`}
      >
        {busy ? 'Saving...' : prominent ? 'Download ghost' : 'Download'}
      </button>
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </>
  )
}
