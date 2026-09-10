import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { GhostForm, type GhostFormValues } from '../components/GhostForm'
import { Notice } from '../components/Notices'
import { countGhostsForUser, createGhost } from '../lib/ghosts'
import { friendlyError } from '../lib/errors'
import { useAuth } from '../lib/auth'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { formatNumber } from '../utils/format'
import { GHOST_LIMIT } from '../types'

export function Upload() {
  useDocumentTitle('Upload')
  const { user, profile, initialising, refreshProfile } = useAuth()
  const navigate = useNavigate()

  const [count, setCount] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!user) return
    let active = true
    countGhostsForUser(user.id)
      .then((value) => {
        if (active) setCount(value)
      })
      .catch(() => {
        if (active) setCount(null)
      })
    return () => {
      active = false
    }
  }, [user])

  if (initialising) {
    return (
      <div className="page">
        <p className="page-note" role="status">
          Restoring your session...
        </p>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="page">
        <h1 className="page-title">Upload ghost</h1>
        <p className="page-note" style={{ margin: '10px 0 16px' }}>
          Uploading needs an account, so each ghost has an author and downloads can be credited.
          Downloading never does.
        </p>
        <p style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-primary" to="/login">
            Sign in
          </Link>
          <Link className="btn" to="/register">
            Join
          </Link>
        </p>
      </div>
    )
  }

  const atLimit = count !== null && count >= GHOST_LIMIT

  async function handleSubmit(values: GhostFormValues, file: File | null) {
    if (!user || !file) return
    setSubmitting(true)
    setError(null)
    try {
      const id = await createGhost({
        userId: user.id,
        title: values.title,
        description: values.description || null,
        isTas: values.isTas,
        moonshineVersion: values.moonshineVersion || null,
        tags: values.tags,
        file,
      })
      await refreshProfile()
      navigate(`/ghost/${id}`)
    } catch (err) {
      setError(friendlyError(err, 'The ghost could not be uploaded. Nothing was saved.'))
      setSubmitting(false)
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Upload ghost</h1>
        <span className="page-note">
          Ghosts: {count === null ? '—' : formatNumber(count)} / {GHOST_LIMIT}
        </span>
      </div>

      {atLimit && (
        <Notice tone="warn">
          This account holds the maximum of {GHOST_LIMIT} ghosts. Delete one from{' '}
          <Link to={profile ? `/profile/${profile.username}` : '/settings'}>your profile</Link> to make
          room. The limit is enforced by the database, so it applies to every route into the archive.
        </Notice>
      )}

      {error && <Notice tone="error">{error}</Notice>}

      <div className="form-narrow" style={{ marginTop: 18 }}>
        <GhostForm
          mode="create"
          submitting={submitting}
          disabled={atLimit}
          submitLabel="Upload ghost"
          onSubmit={handleSubmit}
        />
      </div>
    </div>
  )
}
