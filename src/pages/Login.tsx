import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Notice } from '../components/Notices'
import { useAuth } from '../lib/auth'
import { friendlyError } from '../lib/errors'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { validateEmail } from '../utils/validation'

export function Login() {
  useDocumentTitle('Sign in')
  const { signIn } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const from = (location.state as { from?: string } | null)?.from

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const emailError = validateEmail(email)
    if (emailError) {
      setError(emailError)
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await signIn(email, password)
      navigate(from && from !== '/login' ? from : '/', { replace: true })
    } catch (err) {
      setError(friendlyError(err, 'Could not sign you in.'))
      setSubmitting(false)
    }
  }

  return (
    <div className="page form-narrow">
      <h1 className="page-title">Sign in</h1>
      <p className="page-note" style={{ margin: '8px 0 18px' }}>
        {from
          ? 'That page needs an account.'
          : 'You only need an account to upload, and to have your downloads counted.'}
      </p>

      {error && <Notice tone="error">{error}</Notice>}

      <form onSubmit={handleSubmit} noValidate style={{ marginTop: 14 }}>
        <div className="field">
          <label className="field-label" htmlFor="login-email">
            Email
          </label>
          <input
            id="login-email"
            className="input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="login-password">
            Password
          </label>
          <input
            id="login-password"
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
          />
        </div>

        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? 'Signing in...' : 'Sign in'}
        </button>
      </form>

      <p className="page-note" style={{ marginTop: 20, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <Link to="/register">Create an account</Link>
        <Link to="/reset-password">Forgot your password?</Link>
      </p>
    </div>
  )
}
