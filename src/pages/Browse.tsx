import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { GhostList } from '../components/GhostList'
import { SearchBar } from '../components/SearchBar'
import { SortSelector } from '../components/SortSelector'
import { LevelSelector } from '../components/LevelSelector'
import { Pagination } from '../components/Pagination'
import { Notice } from '../components/Notices'
import { fetchLevelsInUse, listGhosts } from '../lib/ghosts'
import { friendlyError } from '../lib/errors'
import { useDebounced } from '../hooks/useDebounced'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { PAGE_SIZE, SORT_OPTIONS, type GhostListing, type LevelFacet, type SortKey } from '../types'

function readSort(value: string | null): SortKey {
  const match = SORT_OPTIONS.find((option) => option.value === value)
  return match ? match.value : 'recent'
}

export function Browse() {
  useDocumentTitle('Browse')
  const [params, setParams] = useSearchParams()

  const sort = readSort(params.get('sort'))
  const level = params.get('level') ?? ''
  const page = Math.max(0, Number(params.get('page') ?? '0') || 0)
  const [query, setQuery] = useState(params.get('q') ?? '')
  const search = useDebounced(query, 300)

  const [ghosts, setGhosts] = useState<GhostListing[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [levels, setLevels] = useState<LevelFacet[]>([])
  const [levelsLoading, setLevelsLoading] = useState(true)

  // Keep the URL in step with the search box so results stay shareable.
  useEffect(() => {
    const next = new URLSearchParams(params)
    const current = next.get('q') ?? ''
    if (current === search) return
    if (search) next.set('q', search)
    else next.delete('q')
    next.delete('page')
    setParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  // Fetched once: the list of levels changes far more slowly than the listing.
  useEffect(() => {
    let active = true
    fetchLevelsInUse()
      .then((result) => {
        if (active) setLevels(result)
      })
      .catch(() => {
        if (active) setLevels([])
      })
      .finally(() => {
        if (active) setLevelsLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)

    listGhosts({ search, sort, level: level || undefined, page, pageSize: PAGE_SIZE })
      .then((result) => {
        if (!active) return
        setGhosts(result.ghosts)
        setTotal(result.total)
      })
      .catch((err) => {
        if (!active) return
        setGhosts([])
        setTotal(0)
        setError(friendlyError(err, 'The archive could not be loaded. Try again in a moment.'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [search, sort, level, page])

  function updateParam(key: string, value: string | null) {
    const next = new URLSearchParams(params)
    if (value === null) next.delete(key)
    else next.set(key, value)
    if (key !== 'page') next.delete('page')
    setParams(next)
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Ghosts</h1>
      </div>

      <div className="toolbar">
        <SearchBar value={query} onChange={setQuery} />
        <LevelSelector
          value={level}
          levels={levels}
          loading={levelsLoading}
          onChange={(value) => updateParam('level', value || null)}
        />
        <SortSelector value={sort} onChange={(value) => updateParam('sort', value)} />
      </div>

      {level && (
        <p className="filter-note">
          Showing <strong>{level}</strong> only.{' '}
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => updateParam('level', null)}>
            Clear filter
          </button>
        </p>
      )}

      {error && <Notice tone="error">{error}</Notice>}

      <GhostList
        ghosts={ghosts}
        loading={loading}
        emptyMessage={
          search && level
            ? `No ${level} ghosts match "${search}".`
            : search
              ? `No ghosts match "${search}". Try a level name, a category or an author.`
              : level
                ? `No ghosts uploaded for ${level} yet.`
                : 'The archive is empty. Upload the first ghost.'
        }
      />

      {!loading && (
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={total}
          onPageChange={(next) => updateParam('page', String(next))}
        />
      )}
    </div>
  )
}
