import { supabase } from './supabase'
import { ghostPublicUrl } from './ghost/GhostStorage'
import type { GhostListing } from '../types'

export interface DownloadOutcome {
  /** The file reached the visitor. */
  delivered: boolean
  /** The archive's counter moved as a result of this download. */
  counted: boolean
  /** New counter value when we were able to read one back. */
  count: number | null
}

/**
 * Guests download freely; only a signed-in download is counted.
 *
 * The counter is never written from here. The client asks Postgres to record
 * the download through `record_authenticated_download`, which is SECURITY
 * DEFINER, executable only by the `authenticated` role, and performs a single
 * atomic increment. The frontend has no UPDATE path to `ghosts.download_count`
 * at all — an update trigger pins the column to its previous value outside that
 * function, so a hand-written API call cannot move it.
 */
export async function downloadGhost(
  ghost: Pick<GhostListing, 'id' | 'file_path' | 'original_filename'>,
  isAuthenticated: boolean,
): Promise<DownloadOutcome> {
  const url = ghostPublicUrl(ghost.file_path)

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(response.status === 404 ? 'ghost_not_found' : 'download_failed')
  }

  // The bytes are saved exactly as stored — nothing here rewrites the container.
  const blob = await response.blob()
  saveBlob(blob, ghost.original_filename)

  if (!isAuthenticated) {
    return { delivered: true, counted: false, count: null }
  }

  try {
    const { data, error } = await supabase.rpc('record_authenticated_download', {
      p_ghost_id: ghost.id,
    })
    if (error) throw error
    return { delivered: true, counted: true, count: typeof data === 'number' ? data : null }
  } catch {
    // A counting failure must never look like a failed download.
    return { delivered: true, counted: false, count: null }
  }
}

function saveBlob(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Give the browser a moment to start the save before releasing the blob.
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000)
}
