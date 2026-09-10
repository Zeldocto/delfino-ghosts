import { Link } from 'react-router-dom'
import { useDocumentTitle } from '../hooks/useDocumentTitle'

export function NotFound() {
  useDocumentTitle('Not found')
  return (
    <div className="page">
      <h1 className="page-title">Nothing at this address</h1>
      <p className="page-note" style={{ marginTop: 8 }}>
        The page you asked for is not part of the archive.
      </p>
      <p style={{ marginTop: 14, display: 'flex', gap: 8 }}>
        <Link className="btn btn-primary" to="/browse">
          Browse ghosts
        </Link>
        <Link className="btn" to="/">
          Front page
        </Link>
      </p>
    </div>
  )
}
