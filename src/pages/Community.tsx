import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AuthorName } from '../components/AuthorName'
import { Notice, ListingSkeleton, EmptyState } from '../components/Notices'
import { fetchCommunityStats, fetchTopPlayers } from '../lib/community'
import { friendlyError } from '../lib/errors'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { formatNumber, formatShortDate } from '../utils/format'
import type { CommunityStats, PlayerRanking } from '../types'

/** Statistics, not a feed. Rankings come straight from maintained aggregates. */
export function Community() {
  useDocumentTitle('Community')
  const [players, setPlayers] = useState<PlayerRanking[]>([])
  const [stats, setStats] = useState<CommunityStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    Promise.all([fetchTopPlayers(50), fetchCommunityStats()])
      .then(([ranking, communityStats]) => {
        if (!active) return
        setPlayers(ranking)
        setStats(communityStats)
      })
      .catch((err) => {
        if (active) setError(friendlyError(err, 'Community statistics could not be loaded.'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Community</h1>
        <span className="page-note">Ranked by total counted downloads across every ghost a runner has uploaded.</span>
      </div>

      {error && <Notice tone="error">{error}</Notice>}

      <div className="stat-grid" style={{ marginBottom: 8 }}>
        <div className="stat">
          <div className="stat-value">{formatNumber(stats?.total_ghosts ?? 0)}</div>
          <div className="stat-label">Ghosts</div>
        </div>
        <div className="stat">
          <div className="stat-value">{formatNumber(stats?.total_downloads ?? 0)}</div>
          <div className="stat-label">Downloads</div>
        </div>
        <div className="stat">
          <div className="stat-value">{formatNumber(stats?.total_users ?? 0)}</div>
          <div className="stat-label">Runners</div>
        </div>
        <div className="stat">
          <div className="stat-value">
            {stats?.mdp ? <AuthorName username={stats.mdp.username} /> : <span className="cell-dim">Unclaimed</span>}
          </div>
          <div className="stat-label">Most Download Player</div>
        </div>
      </div>

      <div className="section-rule">
        <h2>Most downloaded players</h2>
      </div>

      <div className="listing" style={{ marginTop: 10 }}>
        <div className="listing-head listing-head--rank" aria-hidden="true">
          <span />
          <span>Runner</span>
          <span className="cell-num">Ghosts</span>
          <span className="cell-num">Downloads</span>
        </div>
        {loading ? (
          <ListingSkeleton rows={8} />
        ) : players.length === 0 ? (
          <EmptyState>No ghosts have been uploaded yet.</EmptyState>
        ) : (
          players.map((player, index) => (
            <div className="rank-row" key={player.id}>
              <span className="rank-index">{index + 1}</span>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <AuthorName username={player.username} displayName={player.display_name} />
              </span>
              <span className="rank-ghosts cell-num cell-dim">{formatNumber(player.total_ghosts)}</span>
              <span className="cell-num">{formatNumber(player.total_downloads)}</span>
            </div>
          ))
        )}
      </div>

      <div className="section-rule">
        <h2>Archive notes</h2>
      </div>

      <dl className="kv" style={{ marginTop: 12 }}>
        <dt>Most downloaded ghost</dt>
        <dd>
          {stats?.top_ghost ? (
            <>
              <Link to={`/ghost/${stats.top_ghost.id}`}>{stats.top_ghost.title}</Link>{' '}
              <span className="cell-dim">
                — {formatNumber(stats.top_ghost.download_count)} by {stats.top_ghost.author}
              </span>
            </>
          ) : (
            <span className="cell-dim">Nothing yet</span>
          )}
        </dd>
        <dt>Most recent ghost</dt>
        <dd>
          {stats?.latest_ghost ? (
            <>
              <Link to={`/ghost/${stats.latest_ghost.id}`}>{stats.latest_ghost.title}</Link>{' '}
              <span className="cell-dim">
                — {formatShortDate(stats.latest_ghost.created_at)} by {stats.latest_ghost.author}
              </span>
            </>
          ) : (
            <span className="cell-dim">Nothing yet</span>
          )}
        </dd>
      </dl>
    </div>
  )
}
