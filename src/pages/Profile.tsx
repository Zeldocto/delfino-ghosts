import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { GhostList } from '../components/GhostList'
import { Pagination } from '../components/Pagination'
import { SortSelector } from '../components/SortSelector'
import { LevelSelector } from '../components/LevelSelector'
import { Notice } from '../components/Notices'
import { AuthorName } from '../components/AuthorName'
import { getProfileByUsername } from '../lib/profiles'
import { fetchLevelsInUse, listGhosts } from '../lib/ghosts'
import { friendlyError } from '../lib/errors'
import { useAuth } from '../lib/auth'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { formatMonthYear, formatNumber } from '../utils/format'
import {
  GHOST_LIMIT,
  PAGE_SIZE,
  readSort,
  type GhostListing,
  type LevelFacet,
  type Profile as ProfileRecord,
} from '../types'

export function Profile() {
  const { username = '' } = useParams()
  const { user } = useAuth()
  const [params, setParams] = useSearchParams()
  const sort = readSort(params.get('sort'))
  const level = params.get('level') ?? ''
  const page = Math.max(0, Number(params.get('page') ?? '0') || 0)

  const [profile, setProfile] = useState<ProfileRecord | null>(null)
  const [ghosts, setGhosts] = useState<GhostListing[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [ghostsLoading, setGhostsLoading] = useState(true)
  const [levels, setLevels] = useState<LevelFacet[]>([])
  const [levelsLoading, setLevelsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)

  useDocumentTitle(profile?.username ?? 'Profile')

  useEffect(() => {
    let active = true
    setLoading(true)
    setNotFound(false)
    setError(null)

    getProfileByUsername(username)
      .then((result) => {
        if (!active) return
        if (!result) setNotFound(true)
        else setProfile(result)
      })
      .catch((err) => {
        if (active) setError(friendlyError(err, 'This profile could not be loaded.'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [username])

  // Only this runner's levels, with this runner's counts.
  useEffect(() => {
    if (!profile) return
    let active = true
    setLevelsLoading(true)
    fetchLevelsInUse(profile.id)
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
  }, [profile])

  useEffect(() => {
    if (!profile) return
    let active = true
    setGhostsLoading(true)

    listGhosts({ userId: profile.id, sort, level: level || undefined, page, pageSize: PAGE_SIZE })
      .then((result) => {
        if (!active) return
        setGhosts(result.ghosts)
        setTotal(result.total)
      })
      .catch((err) => {
        if (active) setError(friendlyError(err, 'These ghosts could not be loaded.'))
      })
      .finally(() => {
        if (active) setGhostsLoading(false)
      })

    return () => {
      active = false
    }
  }, [profile, sort, level, page])

  function updateParam(key: string, value: string | null) {
    const next = new URLSearchParams(params)
    if (value === null) next.delete(key)
    else next.set(key, value)
    if (key !== 'page') next.delete('page')
    setParams(next)
  }

  if (loading) {
    return (
      <div className="page">
        <p className="page-note" role="status">
          Loading profile...
        </p>
      </div>
    )
  }

  if (notFound) {
    return (
      <div className="page">
        <h1 className="page-title">No such runner</h1>
        <p className="page-note" style={{ marginTop: 8 }}>
          Nobody is registered as &ldquo;{username}&rdquo;.
        </p>
        <p style={{ marginTop: 14 }}>
          <Link className="btn" to="/community">
            See who is here
          </Link>
        </p>
      </div>
    )
  }

  if (!profile) {
    return (
      <div className="page">
        <Notice tone="error">{error ?? 'This profile could not be loaded.'}</Notice>
      </div>
    )
  }

  const isSelf = user?.id === profile.id

  return (
    <div className="page">
      {error && <Notice tone="error">{error}</Notice>}

      <div className="profile-head">
        {profile.avatar_url ? (
          <img className="avatar" src={profile.avatar_url} alt="" loading="lazy" />
        ) : (
          <div className="avatar avatar-fallback" aria-hidden="true">
            {profile.username.slice(0, 1).toUpperCase()}
          </div>
        )}

        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="row-between">
            <h1 className="profile-name">
              <AuthorName username={profile.username} link={false} />
            </h1>
            {isSelf && (
              <Link className="btn btn-sm" to="/settings">
                Edit profile
              </Link>
            )}
          </div>

          {profile.display_name && <p className="page-note">{profile.display_name}</p>}
          {profile.bio && <p className="profile-bio">{profile.bio}</p>}

          <dl className="kv" style={{ marginTop: 10 }}>
            <dt>Joined</dt>
            <dd>{formatMonthYear(profile.created_at)}</dd>
            <dt>Ghosts</dt>
            <dd>
              {isSelf
                ? `${formatNumber(profile.total_ghosts)} / ${GHOST_LIMIT}`
                : formatNumber(profile.total_ghosts)}
            </dd>
            <dt>Total downloads</dt>
            <dd>{formatNumber(profile.total_downloads)}</dd>
          </dl>
        </div>
      </div>

      <div className="section-rule">
        <h2>Ghosts</h2>
      </div>

      <div className="toolbar" style={{ marginTop: 10 }}>
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

      <div>
        <GhostList
          ghosts={ghosts}
          loading={ghostsLoading}
          showAuthor={false}
          emptyMessage={
            level
              ? `No ${level} ghosts here.`
              : isSelf
                ? 'You have not uploaded a ghost yet.'
                : 'No ghosts uploaded yet.'
          }
        />
      </div>

      {!ghostsLoading && total > PAGE_SIZE && (
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
