import { GhostRow } from './GhostRow'
import { EmptyState, ListingSkeleton } from './Notices'
import type { GhostListing } from '../types'

interface GhostListProps {
  ghosts: GhostListing[]
  loading?: boolean
  showAuthor?: boolean
  emptyMessage?: string
  /** Column labels; hidden on narrow screens where rows fold. */
  headings?: boolean
}

/** The archive's primary UI. Used unchanged by Browse, Home and profiles. */
export function GhostList({
  ghosts,
  loading = false,
  showAuthor = true,
  emptyMessage = 'Nothing here yet.',
  headings = true,
}: GhostListProps) {
  return (
    <div className="listing">
      {headings && (
        <div className="listing-head" aria-hidden="true">
          <span />
          <span>Ghost</span>
          <span>{showAuthor ? 'Author' : 'Version'}</span>
          <span className="cell-num">Downloads</span>
          <span className="cell-num">Uploaded</span>
          <span />
        </div>
      )}

      {loading ? (
        <ListingSkeleton />
      ) : ghosts.length === 0 ? (
        <EmptyState>{emptyMessage}</EmptyState>
      ) : (
        ghosts.map((ghost) => <GhostRow key={ghost.id} ghost={ghost} showAuthor={showAuthor} />)
      )}
    </div>
  )
}
