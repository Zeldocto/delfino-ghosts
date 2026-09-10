import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { GhostForm, type GhostFormValues } from '../components/GhostForm'
import { Notice } from '../components/Notices'
import { getGhost, updateGhost } from '../lib/ghosts'
import { friendlyError } from '../lib/errors'
import { useAuth } from '../lib/auth'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import type { GhostListing } from '../types'

export function EditGhost() {
  const { id = '' } = useParams()
  const { user } = useAuth()
  const navigate = useNavigate()

  const [ghost, setGhost] = useState<GhostListing | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  async function handleSubmit(values: GhostFormValues, file: File | null) {
    if (!ghost) return
    setSubmitting(true)
    setError(null)
    try {
      await updateGhost(ghost, {
        title: values.title,
        description: values.description || null,
        isTas: values.isTas,
        moonshineVersion: values.moonshineVersion || null,
        tags: values.tags,
        file,
      })
      navigate(`/ghost/${ghost.id}`)
    } catch (err) {
      setError(friendlyError(err, 'The changes could not be saved.'))
      setSubmitting(false)
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

  if (!ghost) {
    return (
      <div className="page">
        <Notice tone="error">{error ?? 'That ghost does not exist.'}</Notice>
      </div>
    )
  }

  // Ownership is enforced by RLS; this only avoids showing a form that would fail.
  if (user?.id !== ghost.user_id) {
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

      {error && <Notice tone="error">{error}</Notice>}

      <div className="form-narrow" style={{ marginTop: 18 }}>
        <GhostForm
          mode="edit"
          existingFilename={ghost.original_filename}
          initial={{
            title: ghost.title,
            description: ghost.description ?? '',
            isTas: ghost.is_tas,
            moonshineVersion: ghost.moonshine_version ?? '',
            tags: ghost.tags,
          }}
          submitting={submitting}
          submitLabel="Save changes"
          onSubmit={handleSubmit}
        />
      </div>
    </div>
  )
}
