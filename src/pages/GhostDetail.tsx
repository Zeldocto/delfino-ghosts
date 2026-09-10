import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { AuthorName } from '../components/AuthorName'
import { TasIndicator } from '../components/TasIndicator'
import { DownloadButton } from '../components/DownloadButton'
import { Notice } from '../components/Notices'
import { deleteGhost, getGhost } from '../lib/ghosts'
import { friendlyError } from '../lib/errors'
import { useAuth } from '../lib/auth'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { formatBytes, formatLongDate, formatNumber, pluralize } from '../utils/format'
import type { GhostListing } from '../types'

export function GhostDetail() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()

  const [ghost, setGhost] = useState<GhostListing | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useDocumentTitle(ghost?.title ?? 'Ghost')

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    setNotFound(false)

    getGhost(id)
      .then((result) => {
        if (!active) return
        if (!result) setNotFound(true)
        else setGhost(result)
      })
      .catch((err) => {
        if (active) setError(friendlyError(err, 'This ghost could not be loaded.'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [id])

  const handleCounted = useCallback((count: number | null) => {
    if (count === null) return
    setGhost((current) => (current ? { ...current, download_count: count } : current))
  }, [])

  async function handleDelete() {
    if (!ghost) return
    setDeleting(true)
    setError(null)
    try {
      await deleteGhost(ghost)
      navigate(`/profile/${ghost.author_username}`, { replace: true })
    } catch (err) {
      setError(friendlyError(err, 'This ghost could not be deleted.'))
      setDeleting(false)
    }
  }

  if (loading) {
    return (
      <div className="page">
        <p className="page-note" role="status">
          Loading ghost...
        </p>
      </div>
    )
  }

  if (notFound) {
    return (
      <div className="page">
        <h1 className="page-title">Ghost not found</h1>
        <p className="page-note" style={{ marginTop: 8 }}>
          This entry has been deleted, or the link is wrong. Its download link no longer resolves.
        </p>
        <p style={{ marginTop: 14 }}>
          <Link className="btn" to="/browse">
            Back to the archive
          </Link>
        </p>
      </div>
    )
  }

  if (!ghost) {
    return (
      <div className="page">
        <Notice tone="error">{error ?? 'This ghost could not be loaded.'}</Notice>
      </div>
    )
  }

  const isOwner = user?.id === ghost.user_id

  return (
    <div className="page">
      {error && <Notice tone="error">{error}</Notice>}

      <div className="page-head">
        <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <TasIndicator isTas={ghost.is_tas} />
          {ghost.title}
        </h1>
        {isOwner && (
          <span style={{ display: 'flex', gap: 8 }}>
            <Link className="btn btn-sm" to={`/ghost/${ghost.id}/edit`}>
              Edit
            </Link>
            {confirmingDelete ? (
              <>
                <button type="button" className="btn btn-sm btn-danger" onClick={handleDelete} disabled={deleting}>
                  {deleting ? 'Deleting...' : 'Confirm delete'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={deleting}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-sm btn-danger" onClick={() => setConfirmingDelete(true)}>
                Delete
              </button>
            )}
          </span>
        )}
      </div>

      <p className="page-note" style={{ marginBottom: 18 }}>
        by <AuthorName username={ghost.author_username} displayName={ghost.author_display_name} />
        {ghost.is_tas && ' \u00b7 tool-assisted'}
      </p>

      {ghost.description && (
        <p className="prose" style={{ whiteSpace: 'pre-wrap', marginBottom: 22 }}>
          {ghost.description}
        </p>
      )}

      {ghost.tags.length > 0 && (
        <p style={{ marginBottom: 18 }}>
          {ghost.tags.map((tag) => (
            <span className="tag" key={tag}>
              {tag}
            </span>
          ))}
        </p>
      )}

      <dl className="kv" style={{ marginBottom: 22 }}>
        <dt>Downloads</dt>
        <dd>
          {formatNumber(ghost.download_count)} {pluralize(ghost.download_count, 'download')}
        </dd>
        <dt>Uploaded</dt>
        <dd>{formatLongDate(ghost.created_at)}</dd>
        {ghost.updated_at !== ghost.created_at && (
          <>
            <dt>Updated</dt>
            <dd>{formatLongDate(ghost.updated_at)}</dd>
          </>
        )}
        <dt>File</dt>
        <dd>
          {ghost.original_filename} ({formatBytes(ghost.file_size)})
        </dd>
        {ghost.moonshine_version && (
          <>
            <dt>Moonshine version</dt>
            <dd>{ghost.moonshine_version}</dd>
          </>
        )}
        <dt>Type</dt>
        <dd>{ghost.is_tas ? 'TAS (tool-assisted)' : 'Played manually'}</dd>
      </dl>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <DownloadButton ghost={ghost} prominent onCounted={handleCounted} />
        {isOwner ? (
          <span className="page-note">Downloading your own ghost does not add to its count.</span>
        ) : (
          !user && (
            <span className="page-note">Downloads count toward the archive when you are signed in.</span>
          )
        )}
      </div>
    </div>
  )
}
