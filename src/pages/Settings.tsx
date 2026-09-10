import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Notice } from '../components/Notices'
import { useAuth } from '../lib/auth'
import { isUsernameAvailable, updateProfile } from '../lib/profiles'
import { friendlyError } from '../lib/errors'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { validateUsername } from '../utils/validation'
import { describeAvatarUrl, normalizeAvatarUrl } from '../utils/avatar'
import { formatNumber } from '../utils/format'
import { GHOST_LIMIT } from '../types'

export function Settings() {
  useDocumentTitle('Settings')
  const { profile, profileLoading, refreshProfile } = useAuth()

  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [avatarUrl, setAvatarUrl] = useState('')
  const [bio, setBio] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [avatarFailed, setAvatarFailed] = useState(false)

  useEffect(() => {
    if (!profile) return
    setUsername(profile.username)
    setDisplayName(profile.display_name ?? '')
    setAvatarUrl(profile.avatar_url ?? '')
    setBio(profile.bio ?? '')
  }, [profile])

  if (profileLoading || !profile) {
    return (
      <div className="page">
        <p className="page-note" role="status">
          Loading your profile...
        </p>
      </div>
    )
  }

  const avatarHint = describeAvatarUrl(avatarUrl)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!profile) return

    const next: Record<string, string> = {}
    const usernameError = validateUsername(username)
    if (usernameError) next.username = usernameError
    const trimmedAvatar = avatarUrl.trim()
    if (trimmedAvatar) {
      if (!/^https:\/\/[^\s<>"]+$/.test(trimmedAvatar)) {
        next.avatarUrl = 'Avatar addresses must start with https:// and contain no spaces.'
      } else if (trimmedAvatar.length > 400) {
        next.avatarUrl = 'That address is too long (400 characters maximum).'
      }
    }
    if (bio.length > 500) next.bio = 'Bios are at most 500 characters.'
    setErrors(next)
    setFormError(null)
    setSaved(false)
    if (Object.keys(next).length > 0) return

    setSubmitting(true)
    try {
      if (username.toLowerCase() !== profile.username.toLowerCase()) {
        const available = await isUsernameAvailable(username)
        if (!available) {
          setErrors({ username: 'That username is taken.' })
          setSubmitting(false)
          return
        }
      }

      await updateProfile(profile.id, {
        username: username.trim(),
        display_name: displayName.trim() || null,
        avatar_url: trimmedAvatar || null,
        bio: bio.trim() || null,
      })
      await refreshProfile()
      setSaved(true)
    } catch (err) {
      setFormError(friendlyError(err, 'Your profile could not be saved.'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Profile settings</h1>
        <span className="page-note">
          Ghosts: {formatNumber(profile.total_ghosts)} / {GHOST_LIMIT} · Downloads:{' '}
          {formatNumber(profile.total_downloads)}
        </span>
      </div>

      {formError && <Notice tone="error">{formError}</Notice>}
      {saved && <Notice tone="ok">Profile saved.</Notice>}

      <div className="form-narrow" style={{ marginTop: 16 }}>
        <form onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label className="field-label" htmlFor="settings-username">
              Username
            </label>
            <input
              id="settings-username"
              className="input"
              value={username}
              maxLength={24}
              onChange={(e) => setUsername(e.target.value)}
              disabled={submitting}
            />
            <span className="field-hint">Your profile lives at /profile/{username || 'username'}</span>
            {errors.username && <span className="field-error">{errors.username}</span>}
          </div>

          <div className="field">
            <label className="field-label" htmlFor="settings-display">
              Display name
            </label>
            <input
              id="settings-display"
              className="input"
              value={displayName}
              maxLength={40}
              onChange={(e) => setDisplayName(e.target.value)}
              disabled={submitting}
            />
            <span className="field-hint">Optional. Shown instead of your username in listings.</span>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="settings-avatar">
              Avatar URL
            </label>
            <input
              id="settings-avatar"
              className="input"
              value={avatarUrl}
              onChange={(e) => {
                setAvatarUrl(e.target.value)
                setAvatarFailed(false)
              }}
              onBlur={(e) => setAvatarUrl(normalizeAvatarUrl(e.target.value))}
              placeholder="https://i.imgur.com/example.jpg"
              disabled={submitting}
            />
            <span className="field-hint">
              A direct link to the image file, not the page it sits on — it normally ends in .jpg or
              .png. On Imgur, right-click the image and copy the image address; on ImgBB, use the
              link labelled &ldquo;Direct link&rdquo;.
            </span>
            {errors.avatarUrl && <span className="field-error">{errors.avatarUrl}</span>}
            {!errors.avatarUrl && avatarHint && <span className="field-hint">{avatarHint}</span>}

            {avatarUrl.trim() && !errors.avatarUrl && (
              <span className="avatar-preview">
                {avatarFailed ? (
                  <span className="field-error">
                    That link did not load as an image. Check it opens the picture directly in a new
                    tab.
                  </span>
                ) : (
                  <img
                    className="avatar"
                    src={avatarUrl.trim()}
                    alt="Avatar preview"
                    onError={() => setAvatarFailed(true)}
                    onLoad={() => setAvatarFailed(false)}
                  />
                )}
              </span>
            )}
          </div>

          <div className="field">
            <label className="field-label" htmlFor="settings-bio">
              About
            </label>
            <textarea
              id="settings-bio"
              className="textarea"
              value={bio}
              maxLength={500}
              onChange={(e) => setBio(e.target.value)}
              disabled={submitting}
            />
            <span className="field-hint">{bio.length} / 500</span>
            {errors.bio && <span className="field-error">{errors.bio}</span>}
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? 'Saving...' : 'Save profile'}
            </button>
            <Link className="btn" to={`/profile/${profile.username}`}>
              View profile
            </Link>
          </div>
        </form>
      </div>
    </div>
  )
}
