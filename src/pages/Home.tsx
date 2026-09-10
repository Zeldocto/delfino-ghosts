import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { GhostList } from '../components/GhostList'
import { AuthorName } from '../components/AuthorName'
import { Notice } from '../components/Notices'
import { listGhosts } from '../lib/ghosts'
import { fetchCommunityStats } from '../lib/community'
import { friendlyError } from '../lib/errors'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { formatNumber } from '../utils/format'
import type { CommunityStats, GhostListing } from '../types'

/** Front page of an archive: a short masthead, then straight into the shelves. */
export function Home() {
  useDocumentTitle(null)
  const [ghosts, setGhosts] = useState<GhostListing[]>([])
  const [stats, setStats] = useState<CommunityStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true

    // Only the first page of ghosts is fetched, never the whole archive.
    Promise.all([listGhosts({ sort: 'recent', pageSize: 10 }), fetchCommunityStats()])
      .then(([listing, communityStats]) => {
        if (!active) return
        setGhosts(listing.ghosts)
        setStats(communityStats)
      })
      .catch((err) => {
        if (active) setError(friendlyError(err, 'The archive could not be reached.'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [])

  return (
    <div>
      <section className="home-hero">
        <h1 className="home-title">DELFINO GHOSTS</h1>
        <p className="home-sub">
          A community archive for Moonshine ghosts. Browse the shelf, take what you need — no account
          required to download.
        </p>
        <div className="home-actions">
          <Link className="btn btn-primary" to="/browse">
            Browse ghosts
          </Link>
          <Link className="btn" to="/upload">
            Upload ghost
          </Link>
        </div>
      </section>

      {error && (
        <div style={{ marginTop: 16 }}>
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      <section>
        <div className="section-rule">
          <h2>Recently uploaded</h2>
          <Link to="/browse" className="page-note">
            All ghosts
          </Link>
        </div>
        <div style={{ marginTop: 10 }}>
          <GhostList
            ghosts={ghosts}
            loading={loading}
            emptyMessage="No ghosts yet. The first upload starts the archive."
          />
        </div>
      </section>

      <section style={{ paddingBottom: 60 }}>
        <div className="section-rule">
          <h2>Community</h2>
          <Link to="/community" className="page-note">
            Full rankings
          </Link>
        </div>
        <div className="stat-grid" style={{ marginTop: 12 }}>
          <div className="stat">
            <div className="stat-value">
              {stats?.mdp ? (
                <AuthorName username={stats.mdp.username} />
              ) : (
                <span className="cell-dim">Unclaimed</span>
              )}
            </div>
            <div className="stat-label">Most Download Player</div>
          </div>
          <div className="stat">
            <div className="stat-value">{formatNumber(stats?.total_ghosts ?? 0)}</div>
            <div className="stat-label">Ghosts archived</div>
          </div>
          <div className="stat">
            <div className="stat-value">{formatNumber(stats?.total_downloads ?? 0)}</div>
            <div className="stat-label">Counted downloads</div>
          </div>
          <div className="stat">
            <div className="stat-value">{formatNumber(stats?.total_users ?? 0)}</div>
            <div className="stat-label">Runners registered</div>
          </div>
        </div>
      </section>
    </div>
  )
}
