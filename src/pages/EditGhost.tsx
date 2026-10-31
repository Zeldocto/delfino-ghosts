import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { GhostForm, type GhostFormValues } from '../components/GhostForm'
import { Notice } from '../components/Notices'
import { getGhost, updateGhost } from '../lib/ghosts'
import { MAX_REASON_LENGTH, updateGhostAsStaff } from '../lib/moderation'
import { friendlyError } from '../lib/errors'
import { useAuth } from '../lib/auth'
import { useStaff } from '../hooks/useStaff'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { formatTime, parseTimeInput } from '../utils/time'
import type { GhostListing } from '../types'

export function EditGhost() {
  const { id = '' } = useParams()
  const { user } = useAuth()
  const { isStaff, loading: staffLoading } = useStaff()
  const navigate = useNavigate()

  const [ghost, setGhost] = useState<GhostListing | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reason, setReason] = useState('')

  useDocumentTitle(ghost ? `Edit ${ghost.title}` : 'Edit ghost')

  useEffect(() => {
    let active = true
    getGhost(id)
      .then((result) => {
        if (active) setGhost(result)
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

  const isOwner = Boolean(ghost && user?.id === ghost.user_id)
  /** Staff editing someone else's ghost: details only, logged, with an optional reason. */
  const asStaff = !isOwner && isStaff

  async function handleSubmit(values: GhostFormValues, file: File | null) {
    if (!ghost) return
    setSubmitting(true)
    setError(null)
    const details = {
      title: values.title,
      description: values.description || null,
      level: values.level || null,
      timeMs: parseTimeInput(values.time),
      isTas: values.isTas,
      moonshineVersion: values.moonshineVersion || null,
      tags: values.tags,
    }
    try {
      if (asStaff) await updateGhostAsStaff(ghost.id, details, reason)
      else await updateGhost(ghost, { ...details, file })
      navigate(`/ghost/${ghost.id}`)
    } catch (err) {
      setError(friendlyError(err, 'The changes could not be saved.'))
      setSubmitting(false)
    }
  }

  if (loading || staffLoading) {
    return (
      <div className="page">
        <p className="page-note" role="status">
          Loading ghost...
        </p>
      </div>
    )
  }

  if (!ghost) {
    return (
      <div className="page">
        <Notice tone="error">{error ?? 'That ghost does not exist.'}</Notice>
      </div>
    )
  }

  // Ownership and staff roles are enforced by the database; this only avoids showing a form that would fail.
  if (!isOwner && !asStaff) {
    return (
      <div className="page">
        <h1 className="page-title">Not your ghost</h1>
        <p className="page-note" style={{ marginTop: 8 }}>
          Only {ghost.author_username} can edit this entry.
        </p>
      </div>
    )
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Edit ghost</h1>
      </div>

      {asStaff && (
        <Notice tone="warn">
          You are editing {ghost.author_username}&rsquo;s ghost as staff. The change is recorded in the moderation log
          with the old and new values.
        </Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}

      <div className="form-narrow" style={{ marginTop: 18 }}>
        <GhostForm
          mode="edit"
          existingFilename={ghost.original_filename}
          allowFileChange={!asStaff}
          initial={{
            title: ghost.title,
            description: ghost.description ?? '',
            level: ghost.level ?? '',
            time: formatTime(ghost.time_ms),
            isTas: ghost.is_tas,
            moonshineVersion: ghost.moonshine_version ?? '',
            tags: ghost.tags,
          }}
          submitting={submitting}
          submitLabel="Save changes"
          extraFields={
            asStaff && (
              <div className="field">
                <label className="field-label" htmlFor="edit-reason">
                  Reason for the change (staff only, optional)
                </label>
                <input
                  id="edit-reason"
                  className="input"
                  value={reason}
                  maxLength={MAX_REASON_LENGTH}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. marked as TAS"
                  disabled={submitting}
                />
              </div>
            )
          }
          onSubmit={handleSubmit}
        />
      </div>
    </div>
  )
}
