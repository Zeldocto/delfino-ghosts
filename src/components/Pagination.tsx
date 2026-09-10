import { formatNumber } from '../utils/format'

interface PaginationProps {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
}

export function Pagination({ page, pageSize, total, onPageChange }: PaginationProps) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const first = total === 0 ? 0 : page * pageSize + 1
  const last = Math.min(total, (page + 1) * pageSize)

  return (
    <div className="listing-foot">
      <span>
        {total === 0
          ? 'No entries'
          : `${formatNumber(first)}\u2013${formatNumber(last)} of ${formatNumber(total)}`}
      </span>
      {pages > 1 && (
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => onPageChange(page - 1)}
            disabled={page === 0}
          >
            Previous
          </button>
          <span aria-live="polite">
            Page {page + 1} of {formatNumber(pages)}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => onPageChange(page + 1)}
            disabled={page + 1 >= pages}
          >
            Next
          </button>
        </span>
      )}
    </div>
  )
}
