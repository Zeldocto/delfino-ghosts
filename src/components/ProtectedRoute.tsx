import { Navigate, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '../lib/auth'

/**
 * Gates routes that need an account. This is a convenience, not a security
 * boundary — every protected action is also refused by RLS.
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, initialising } = useAuth()
  const location = useLocation()

  if (initialising) {
    return (
      <p className="page-note" role="status">
        Restoring your session...
      </p>
    )
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname, reason: 'auth' }} />
  }

  return <>{children}</>
}
