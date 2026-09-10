import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Notice } from '../components/Notices'
import { useAuth } from '../lib/auth'
import { isUsernameAvailable } from '../lib/profiles'
import { friendlyError } from '../lib/errors'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { validateEmail, validatePassword, validateUsername } from '../utils/validation'

export function Register() {
  useDocumentTitle('Join')
  const { signUp } = useAuth()
  const navigate = useNavigate()

  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [verificationSent, setVerificationSent] = useState(false)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const next: Record<string, string> = {}
    const usernameError = validateUsername(username)
    if (usernameError) next.username = usernameError
    const emailError = validateEmail(email)
    if (emailError) next.email = emailError
    const passwordError = validatePassword(password)
    if (passwordError) next.password = passwordError
    setErrors(next)
    setFormError(null)
    if (Object.keys(next).length > 0) return

    setSubmitting(true)
    try {
      // Checked up front for a clear message; uniqueness itself is enforced by
      // a case-insensitive unique index in the database.
      const available = await isUsernameAvailable(username)
      if (!available) {
        setErrors({ username: 'That username is taken.' })
        setSubmitting(false)
        return
      }

      const { needsVerification } = await signUp(email, password, username)
      if (needsVerification) {
        setVerificationSent(true)
        setSubmitting(false)
      } else {
        navigate('/', { replace: true })
      }
    } catch (err) {
      setFormError(friendlyError(err, 'That account could not be created.'))
      setSubmitting(false)
    }
  }

  if (verificationSent) {
    return (
      <div className="page form-narrow">
        <h1 className="page-title">Check your email</h1>
        <p className="page-note" style={{ marginTop: 10 }}>
          A verification link is on its way to {email}. Open it to activate the account, then sign in.
        </p>
        <p style={{ marginTop: 16 }}>
          <Link className="btn" to="/login">
            Go to sign in
          </Link>
        </p>
      </div>
    )
  }

  return (
    <div className="page form-narrow">
      <h1 className="page-title">Join the archive</h1>
      <p className="page-note" style={{ margin: '8px 0 18px' }}>
        An account lets you upload ghosts and have your downloads counted.
      </p>

      {formError && <Notice tone="error">{formError}</Notice>}

      <form onSubmit={handleSubmit} noValidate style={{ marginTop: 14 }}>
        <div className="field">
          <label className="field-label" htmlFor="register-username">
            Username
          </label>
          <input
            id="register-username"
            className="input"
            value={username}
            maxLength={24}
            autoComplete="username"
            onChange={(e) => setUsername(e.target.value)}
            aria-invalid={Boolean(errors.username)}
            disabled={submitting}
          />
          <span className="field-hint">
            3–24 characters: letters, numbers, hyphens, underscores. This becomes your profile address.
          </span>
          {errors.username && <span className="field-error">{errors.username}</span>}
        </div>

        <div className="field">
          <label className="field-label" htmlFor="register-email">
            Email
          </label>
          <input
            id="register-email"
            className="input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={Boolean(errors.email)}
            disabled={submitting}
          />
          {errors.email && <span className="field-error">{errors.email}</span>}
        </div>

        <div className="field">
          <label className="field-label" htmlFor="register-password">
            Password
          </label>
          <input
            id="register-password"
            className="input"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={Boolean(errors.password)}
            disabled={submitting}
          />
          <span className="field-hint">At least 8 characters.</span>
          {errors.password && <span className="field-error">{errors.password}</span>}
        </div>

        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? 'Creating account...' : 'Create account'}
        </button>
      </form>

      <p className="page-note" style={{ marginTop: 20 }}>
        <Link to="/login">Already registered?</Link>
      </p>
    </div>
  )
}
