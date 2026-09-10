import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { DropZone } from '../components/DropZone'
import { UploadQueue, type QueueEntry } from '../components/UploadQueue'
import { Notice } from '../components/Notices'
import type { GhostFormValues } from '../components/GhostForm'
import { countGhostsForUser, createGhost } from '../lib/ghosts'
import { validateGhostFile, suggestMetadata } from '../lib/ghost'
import { friendlyError } from '../lib/errors'
import { useAuth } from '../lib/auth'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { formatNumber, pluralize } from '../utils/format'
import { parseTags } from '../utils/validation'
import { parseTimeInput } from '../utils/time'
import { GHOST_EXTENSION, GHOST_LIMIT } from '../types'

function emptyValues(): GhostFormValues {
  return { title: '', description: '', level: '', time: '', isTas: false, moonshineVersion: '', tags: [] }
}

export function Upload() {
  useDocumentTitle('Upload')
  const { user, profile, initialising, refreshProfile } = useAuth()
  const navigate = useNavigate()

  const [count, setCount] = useState<number | null>(null)
  const [entries, setEntries] = useState<QueueEntry[]>([])
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [finished, setFinished] = useState(false)
  const keySeed = useRef(0)

  useEffect(() => {
    if (!user) return
    let active = true
    countGhostsForUser(user.id)
      .then((value) => {
        if (active) setCount(value)
      })
      .catch(() => {
        if (active) setCount(null)
      })
    return () => {
      active = false
    }
  }, [user])

  const updateEntry = useCallback((key: string, patch: Partial<QueueEntry>) => {
    setEntries((current) => current.map((e) => (e.key === key ? { ...e, ...patch } : e)))
  }, [])

  const changeValues = useCallback((key: string, patch: Partial<GhostFormValues>) => {
    setEntries((current) =>
      current.map((e) => (e.key === key ? { ...e, values: { ...e.values, ...patch } } : e)),
    )
  }, [])

  const toggleExpand = useCallback((key: string) => {
    setEntries((current) => current.map((e) => (e.key === key ? { ...e, expanded: !e.expanded } : e)))
  }, [])

  const removeEntry = useCallback((key: string) => {
    setEntries((current) => current.filter((e) => e.key !== key))
  }, [])

  const inspect = useCallback(
    async (entry: QueueEntry) => {
      const result = await validateGhostFile(entry.file)
      const values = emptyValues()

      if (result.parsed) {
        const suggestion = suggestMetadata(result.parsed, entry.file.name)
        values.title = suggestion.title ?? ''
        values.level = suggestion.level ?? ''
        values.time = suggestion.time ?? ''
        values.moonshineVersion = suggestion.moonshineVersion ?? ''
        values.tags = suggestion.tags ?? []
      }
      if (!values.title) {
        values.title = entry.file.name.replace(/\.smsghost$/i, '').replace(/_+/g, ' ').trim()
      }

      updateEntry(entry.key, {
        status: result.ok ? 'ready' : 'invalid',
        errors: result.errors,
        warnings: result.warnings,
        values,
      })
    },
    [updateEntry],
  )

  /**
   * Files land as `checking` immediately so a twenty-file drop feels instant,
   * then each is parsed and pre-filled in the background.
   */
  const addFiles = useCallback(
    (files: File[]) => {
      setFinished(false)
      setError(null)

      const ghostFiles = files.filter((f) => f.name.toLowerCase().endsWith(GHOST_EXTENSION))
      const skipped = files.length - ghostFiles.length
      if (skipped > 0) {
        setError(`Ignored ${skipped} ${pluralize(skipped, 'file')} that did not end in ${GHOST_EXTENSION}.`)
      }
      if (ghostFiles.length === 0) return

      setEntries((current) => {
        const seen = new Set(current.map((e) => `${e.file.name}:${e.file.size}`))
        const fresh: QueueEntry[] = []

        for (const file of ghostFiles) {
          const signature = `${file.name}:${file.size}`
          if (seen.has(signature)) continue
          seen.add(signature)
          keySeed.current += 1
          fresh.push({
            key: `q${keySeed.current}`,
            file,
            status: 'checking',
            errors: [],
            warnings: [],
            values: emptyValues(),
            expanded: false,
          })
        }

        // Kick off validation outside the updater so it stays a pure function.
        queueMicrotask(() => {
          for (const entry of fresh) void inspect(entry)
        })

        return [...current, ...fresh]
      })
    },
    [inspect],
  )

  const readyEntries = entries.filter((e) => e.status === 'ready' || e.status === 'error')
  const doneCount = entries.filter((e) => e.status === 'done').length
  const remaining = count === null ? null : Math.max(0, GHOST_LIMIT - count)
  const atLimit = remaining === 0
  const overLimit = remaining !== null && readyEntries.length > remaining
  const missingTitles = readyEntries.filter((e) => !e.values.title.trim()).length
  const missingDetails = readyEntries.filter(
    (e) => !e.values.level.trim() || parseTimeInput(e.values.time) === null,
  ).length

  /**
   * Uploaded one at a time rather than in parallel: per-row status stays
   * honest, Storage is not hit with a burst of concurrent writes, and running
   * into the 200-ghost limit part way through stops cleanly with everything
   * before it already saved.
   */
  async function handleUploadAll() {
    if (!user) return
    setUploading(true)
    setError(null)
    setFinished(false)

    const targets = entries.filter((e) => e.status === 'ready' || e.status === 'error')
    const succeeded: string[] = []

    for (const entry of targets) {
      const title = entry.values.title.trim()
      const level = entry.values.level.trim()
      const timeMs = parseTimeInput(entry.values.time)

      const problems: string[] = []
      if (!title) problems.push('Give this ghost a title.')
      if (!level) problems.push('Say which level this ghost is for.')
      if (entry.values.time.trim() && timeMs === null) {
        problems.push('That time is not readable. Use 14.387 or 1:23.456.')
      } else if (!entry.values.time.trim()) {
        problems.push('Add the time this ghost gets.')
      }
      if (problems.length > 0) {
        updateEntry(entry.key, { status: 'error', errors: problems })
        continue
      }

      updateEntry(entry.key, { status: 'uploading', errors: [], message: undefined })

      try {
        const id = await createGhost({
          userId: user.id,
          title,
          description: entry.values.description.trim() || null,
          level,
          timeMs,
          isTas: entry.values.isTas,
          moonshineVersion: entry.values.moonshineVersion.trim() || null,
          tags: parseTags(entry.values.tags.join(', ')),
          file: entry.file,
        })
        succeeded.push(id)
        updateEntry(entry.key, { status: 'done', ghostId: id, expanded: false, errors: [], warnings: [] })
      } catch (err) {
        const message = friendlyError(err, 'This ghost could not be uploaded.')
        updateEntry(entry.key, { status: 'error', errors: [message] })

        // The archive-side limit is fatal for the rest of the run.
        if (message.includes(`${GHOST_LIMIT}-ghost limit`)) {
          setError(`Stopped at the ${GHOST_LIMIT}-ghost limit. Everything before it was saved.`)
          break
        }
      }
    }

    if (succeeded.length > 0) {
      await refreshProfile()
      setCount((c) => (c === null ? c : c + succeeded.length))
    }

    setUploading(false)
    setFinished(true)

    // A single ghost is almost always headed straight to its own page.
    if (targets.length === 1 && succeeded.length === 1) {
      navigate(`/ghost/${succeeded[0]}`)
    }
  }

  if (initialising) {
    return (
      <div className="page">
        <p className="page-note" role="status">
          Restoring your session...
        </p>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="page">
        <h1 className="page-title">Upload ghosts</h1>
        <p className="page-note" style={{ margin: '10px 0 16px' }}>
          Uploading needs an account, so each ghost has an author and downloads can be credited.
          Downloading never does.
        </p>
        <p style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-primary" to="/login">
            Sign in
          </Link>
          <Link className="btn" to="/register">
            Join
          </Link>
        </p>
      </div>
    )
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Upload ghosts</h1>
        <span className="page-note">
          Ghosts: {count === null ? '\u2014' : formatNumber(count)} / {GHOST_LIMIT}
        </span>
      </div>

      {atLimit && (
        <Notice tone="warn">
          This account holds the maximum of {GHOST_LIMIT} ghosts. Delete one from{' '}
          <Link to={profile ? `/profile/${profile.username}` : '/settings'}>your profile</Link> to make
          room. The limit is enforced by the database, so it applies to every route into the archive.
        </Notice>
      )}

      {error && <Notice tone="error">{error}</Notice>}

      <div style={{ marginTop: 16 }}>
        <DropZone
          onFiles={addFiles}
          disabled={atLimit || uploading}
          hint={
            remaining === null
              ? `Any number of ${GHOST_EXTENSION} files, up to 2 MB each.`
              : `Any number of ${GHOST_EXTENSION} files, up to 2 MB each. Room for ${formatNumber(remaining)} more.`
          }
        />
      </div>

      {overLimit && (
        <div style={{ marginTop: 12 }}>
          <Notice tone="warn">
            {formatNumber(readyEntries.length)} queued but only {formatNumber(remaining ?? 0)}{' '}
            {pluralize(remaining ?? 0, 'slot')} left. Uploading stops when the limit is reached.
          </Notice>
        </div>
      )}

      {entries.length > 0 && (
        <>
          <div className="queue-bar">
            <span className="page-note">
              {formatNumber(readyEntries.length)} ready
              {doneCount > 0 && ` \u00b7 ${formatNumber(doneCount)} uploaded`}
              {missingTitles > 0 && ` \u00b7 ${formatNumber(missingTitles)} missing a title`}
              {missingDetails > 0 && ` \u00b7 ${formatNumber(missingDetails)} missing level or time`}
            </span>

            <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-sm"
                disabled={uploading || readyEntries.length === 0}
                onClick={() =>
                  setEntries((current) =>
                    current.map((e) =>
                      e.status === 'ready' || e.status === 'error'
                        ? { ...e, values: { ...e.values, isTas: true } }
                        : e,
                    ),
                  )
                }
              >
                Mark all TAS
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={uploading}
                onClick={() =>
                  setEntries((current) =>
                    current.filter((e) => e.status !== 'done' && e.status !== 'invalid'),
                  )
                }
              >
                Clear finished
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={uploading}
                onClick={() => setEntries([])}
              >
                Clear all
              </button>
            </span>
          </div>

          <UploadQueue
            entries={entries}
            onChange={changeValues}
            onToggleExpand={toggleExpand}
            onRemove={removeEntry}
          />

          <div className="queue-submit">
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleUploadAll}
              disabled={uploading || readyEntries.length === 0 || atLimit}
            >
              {uploading
                ? 'Uploading...'
                : readyEntries.length === 1
                  ? 'Upload ghost'
                  : `Upload ${formatNumber(readyEntries.length)} ghosts`}
            </button>

            {finished && !uploading && doneCount > 0 && (
              <span className="page-note">
                {formatNumber(doneCount)} {pluralize(doneCount, 'ghost')} uploaded.{' '}
                <Link to={profile ? `/profile/${profile.username}` : '/browse'}>
                  See them on your profile
                </Link>
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}
