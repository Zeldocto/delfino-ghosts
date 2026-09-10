import { Link } from 'react-router-dom'
import { AuthorName } from './AuthorName'
import { TasIndicator } from './TasIndicator'
import { DownloadButton } from './DownloadButton'
import { formatNumber, formatShortDate, pluralize } from '../utils/format'
import { formatTime } from '../utils/time'
import type { GhostListing } from '../types'

interface GhostRowProps {
  ghost: GhostListing
  /** Profile pages already state the author. */
  showAuthor?: boolean
}

export function GhostRow({ ghost, showAuthor = true }: GhostRowProps) {
  return (
    <div className="ghost-row">
      <span className="cell-tas">
        <TasIndicator isTas={ghost.is_tas} />
      </span>

      <span className="cell-title">
        <Link to={`/ghost/${ghost.id}`} className="ghost-title">
          {ghost.title}
        </Link>
      </span>

      <span className="cell-level cell-dim">{ghost.level ?? ''}</span>

      <span className="cell-time cell-num cell-dim">{formatTime(ghost.time_ms)}</span>

      <span className="cell-author cell-dim">
        {showAuthor ? (
          <AuthorName username={ghost.author_username} displayName={ghost.author_display_name} />
        ) : (
          ghost.moonshine_version ?? ''
        )}
      </span>

      <span className="cell-downloads cell-num cell-dim">{formatNumber(ghost.download_count)}</span>

      <span className="cell-date cell-num cell-dim">{formatShortDate(ghost.created_at)}</span>

      {/* Folded mobile layout puts author, count and date on one line. */}
      <span className="cell-meta">
        {ghost.level && `${ghost.level} \u00b7 `}
        {ghost.time_ms !== null && `${formatTime(ghost.time_ms)} \u00b7 `}
        {showAuthor && (
          <>
            <AuthorName username={ghost.author_username} displayName={ghost.author_display_name} />
            {' \u00b7 '}
          </>
        )}
        {formatNumber(ghost.download_count)} {pluralize(ghost.download_count, 'download')}
        {' \u00b7 '}
        {formatShortDate(ghost.created_at)}
      </span>

      <span className="row-actions">
        <DownloadButton ghost={ghost} />
      </span>
    </div>
  )
}
