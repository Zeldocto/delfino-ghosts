import { Link, Outlet } from 'react-router-dom'
import { Navbar, MOONSHINE_RELEASES_URL } from './Navbar'
import { Notice } from './Notices'
import { useStaff } from '../hooks/useStaff'

/** Tells a suspended account why nothing it tries to change will save. */
function SuspensionNotice() {
  const { suspended, suspensionReason } = useStaff()
  if (!suspended) return null
  return (
    <Notice tone="warn">
      Your account is suspended{suspensionReason ? `: ${suspensionReason}` : ''}. You can still browse and
      download, but you can&rsquo;t upload, edit or delete ghosts, change your profile, or link a device. You can
      still delete your account in <Link to="/settings">Settings</Link>. To ask about this, see the contact
      address in the <Link to="/privacy">Privacy Policy</Link>.
    </Notice>
  )
}

export function Layout() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Navbar />
      <main id="main" className="shell">
        <SuspensionNotice />
        <Outlet />
      </main>
      <footer className="footer">
        <div className="shell" style={{ display: 'flex', gap: 16, flexWrap: 'wrap', width: '100%' }}>
          <span>Delfino Ghosts — a community archive for Moonshine ghosts.</span>
          <span className="nav-spacer" />
          <Link to="/privacy">Privacy Policy</Link>
          <Link to="/about">About</Link>
          <a href={MOONSHINE_RELEASES_URL} target="_blank" rel="noopener noreferrer">
            Get Moonshine
          </a>
        </div>
      </footer>
    </>
  )
}
