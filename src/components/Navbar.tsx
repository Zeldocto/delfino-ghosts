import { Link, NavLink, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { useAuth } from '../lib/auth'
import { ThemeToggle } from './ThemeToggle'

export const MOONSHINE_RELEASES_URL = 'https://github.com/panther03/moonshine/releases/'

export function Navbar() {
  const { user, profile, signOut } = useAuth()
  const navigate = useNavigate()
  const [signingOut, setSigningOut] = useState(false)

  async function handleSignOut() {
    setSigningOut(true)
    try {
      await signOut()
      navigate('/')
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <header className="masthead">
      <div className="shell">
        <div className="masthead-top">
          <Link to="/" className="wordmark">
            <span className="wordmark-name">DELFINO GHOSTS</span>
            <span className="wordmark-sub">A Moonshine ghost archive</span>
          </Link>
        </div>

        <nav className="nav" aria-label="Main">
          <NavLink to="/" className="nav-link" end>
            Delfino
          </NavLink>
          <NavLink to="/upload" className="nav-link">
            Upload
          </NavLink>
          <NavLink to="/browse" className="nav-link">
            Browse
          </NavLink>
          <NavLink to="/community" className="nav-link">
            Community
          </NavLink>
          <NavLink to="/about" className="nav-link">
            About
          </NavLink>
          <a
            className="nav-link"
            href={MOONSHINE_RELEASES_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            Moonshine
            <span className="sr-only"> (opens on GitHub)</span>
          </a>

          <span className="nav-spacer" />

          <span className="nav-aux">
            <ThemeToggle />
            {user ? (
              <>
                <span className="nav-user">{profile?.username ?? 'Signed in'}</span>
                <NavLink to={profile ? `/profile/${profile.username}` : '/settings'} className="nav-link">
                  Profile
                </NavLink>
                <button
                  type="button"
                  className="btn btn-quiet btn-sm"
                  onClick={handleSignOut}
                  disabled={signingOut}
                >
                  {signingOut ? 'Signing out...' : 'Log out'}
                </button>
              </>
            ) : (
              <>
                <NavLink to="/login" className="nav-link">
                  Sign in
                </NavLink>
                <NavLink to="/register" className="nav-link">
                  Join
                </NavLink>
              </>
            )}
          </span>
        </nav>
      </div>
    </header>
  )
}
