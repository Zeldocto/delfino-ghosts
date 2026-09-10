import { Link, Outlet } from 'react-router-dom'
import { Navbar, MOONSHINE_RELEASES_URL } from './Navbar'

export function Layout() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Navbar />
      <main id="main" className="shell">
        <Outlet />
      </main>
      <footer className="footer">
        <div className="shell" style={{ display: 'flex', gap: 16, flexWrap: 'wrap', width: '100%' }}>
          <span>Delfino Ghosts — a community archive for Moonshine ghosts.</span>
          <span className="nav-spacer" />
          <Link to="/about">About</Link>
          <a href={MOONSHINE_RELEASES_URL} target="_blank" rel="noopener noreferrer">
            Get Moonshine
          </a>
        </div>
      </footer>
    </>
  )
}
