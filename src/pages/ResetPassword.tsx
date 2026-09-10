import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Notice } from '../components/Notices'
import { useAuth } from '../lib/auth'
import { friendlyError } from '../lib/errors'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { validateEmail, validatePassword } from '../utils/validation'

/**
 * Two states in one route: asking for a reset link, and — once Supabase has
 * signed the visitor in from that link — choosing the new password.
 */
export function ResetPassword() {
  useDocumentTitle('Reset password')
  const { requestPasswordReset, updatePassword, recoveryMode, user } = useAuth()
  const navigate = useNavigate()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const settingNewPassword = recoveryMode && Boolean(user)

  async function handleRequest(event: React.FormEvent) {
    event.preventDefault()
    const emailError = validateEmail(email)
    if (emailError) {
      setError(emailError)
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await requestPasswordReset(email)
      setSent(true)
    } catch (err) {
      setError(friendlyError(err, 'That reset link could not be sent.'))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleUpdate(event: React.FormEvent) {
    event.preventDefault()
    const passwordError = validatePassword(password)
    if (passwordError) {
      setError(passwordError)
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await updatePassword(password)
      navigate('/', { replace: true })
    } catch (err) {
      setError(friendlyError(err, 'That password could not be saved.'))
      setSubmitting(false)
    }
  }

  if (settingNewPassword) {
    return (
      <div className="page form-narrow">
        <h1 className="page-title">Choose a new password</h1>
        {error && <Notice tone="error">{error}</Notice>}
        <form onSubmit={handleUpdate} noValidate style={{ marginTop: 16 }}>
          <div className="field">
            <label className="field-label" htmlFor="new-password">
              New password
            </label>
            <input
              id="new-password"
              className="input"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
            />
            <span className="field-hint">At least 8 characters.</span>
          </div>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? 'Saving...' : 'Save password'}
          </button>
        </form>
      </div>
    )
  }

  if (sent) {
    return (
      <div className="page form-narrow">
        <h1 className="page-title">Check your email</h1>
        <p className="page-note" style={{ marginTop: 10 }}>
          If an account uses {email}, a reset link is on its way. Open it and you will be brought back
          here to set a new password.
        </p>
      </div>
    )
  }

  return (
    <div className="page form-narrow">
      <h1 className="page-title">Reset password</h1>
      <p className="page-note" style={{ margin: '8px 0 16px' }}>
        Enter the address you registered with.
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      <form onSubmit={handleRequest} noValidate>
        <div className="field">
          <label className="field-label" htmlFor="reset-email">
            Email
          </label>
          <input
            id="reset-email"
            className="input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? 'Sending...' : 'Send reset link'}
        </button>
      </form>
      <p className="page-note" style={{ marginTop: 20 }}>
        <Link to="/login">Back to sign in</Link>
      </p>
    </div>
  )
}
