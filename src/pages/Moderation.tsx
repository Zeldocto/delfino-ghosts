import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AuthorName } from '../components/AuthorName'
import { Notice } from '../components/Notices'
import {
  listStaff,
  listSuspensions,
  recentModeration,
  retryFileRemoval,
  setModerator,
  unsuspendAccount,
  type ModerationEntry,
  type StaffMember,
  type Suspension,
} from '../lib/moderation'
import { friendlyError } from '../lib/errors'
import { useStaff } from '../hooks/useStaff'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { formatLongDate } from '../utils/format'
import { formatTime } from '../utils/time'

function Name({ username, displayName }: { username: string | null; displayName: string | null }) {
  return username ? <AuthorName username={username} displayName={displayName} /> : <span>someone</span>
}

const FIELD_LABELS: Record<string, string> = {
  title: 'title',
  description: 'description',
  level: 'level',
  time_ms: 'time',
  is_tas: 'TAS',
  moonshine_version: 'Moonshine version',
  tags: 'tags',
}

function formatValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (field === 'time_ms') return formatTime(value as number) || '—'
  if (field === 'is_tas') return value ? 'yes' : 'no'
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—'
  const text = String(value)
  return `“${text.length > 60 ? `${text.slice(0, 57)}...` : text}”`
}

function describe(entry: ModerationEntry) {
  const actor = <Name username={entry.actor_username} displayName={entry.actor_display_name} />
  const target = <Name username={entry.target_username} displayName={entry.target_display_name} />
  switch (entry.action) {
    case 'add_moderator':
      return <>{actor} made {target} a moderator</>
    case 'remove_moderator':
      return <>{actor} removed {target} as a moderator</>
    case 'suspend_account':
      return <>{actor} suspended {target}</>
    case 'unsuspend_account':
      return <>{actor} lifted {target}&rsquo;s suspension</>
    case 'edit_ghost':
      return (
        <>
          {actor} edited{' '}
          {entry.ghost_id ? <Link to={`/ghost/${entry.ghost_id}`}>&ldquo;{entry.ghost_title}&rdquo;</Link> : <>&ldquo;{entry.ghost_title}&rdquo;</>}{' '}
          by {target}
        </>
      )
    default:
      return (
        <>
          {actor} removed &ldquo;{entry.ghost_title}&rdquo; by {target}
        </>
      )
  }
}

/**
 * Staff page: who the moderators are, who is suspended and what staff have
 * done. The admin also adds and removes moderators here. Removing or editing a
 * ghost happens on the ghost's page; suspending, on the account's profile.
 */
export function Moderation() {
  useDocumentTitle('Moderation')
  const { isStaff, isAdmin, loading, refreshDirectory } = useStaff()

  const [staff, setStaff] = useState<StaffMember[] | null>(null)
  const [suspensions, setSuspensions] = useState<Suspension[] | null>(null)
  const [log, setLog] = useState<ModerationEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [newModerator, setNewModerator] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [deletedFiles, setDeletedFiles] = useState<Set<string>>(() => new Set())

  const reload = useCallback(async () => {
    const [nextStaff, nextSuspensions, nextLog] = await Promise.all([listStaff(), listSuspensions(), recentModeration(100)])
    setStaff(nextStaff)
    setSuspensions(nextSuspensions)
    setLog(nextLog)
  }, [])

  useEffect(() => {
    if (!isStaff) return
    reload().catch((err) => setError(friendlyError(err, 'Moderation data could not be loaded.')))
  }, [isStaff, reload])

  async function run(key: string, action: () => Promise<void>, fallback: string) {
    setBusy(key)
    setError(null)
    try {
      await action()
      await reload()
    } catch (err) {
      setError(friendlyError(err, fallback))
    } finally {
      setBusy(null)
    }
  }

  if (loading) {
    return (
      <div className="page">
        <p className="page-note" role="status">
          Loading...
        </p>
      </div>
    )
  }

  if (!isStaff) {
    return (
      <div className="page">
        <h1 className="page-title">Moderation</h1>
        <p className="page-note" style={{ marginTop: 8 }}>
          This page is for the archive&rsquo;s moderators.
        </p>
      </div>
    )
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Moderation</h1>
      </div>
      <p className="page-note">
        To edit or remove a ghost, open it. To suspend an account, open its profile. Every action is logged below,
        and only staff can see this page.
      </p>
      {error && <Notice tone="error">{error}</Notice>}

      <div className="section-rule">
        <h2>Staff</h2>
      </div>
      {staff === null && !error && (
        <p className="page-note" role="status">
          Loading...
        </p>
      )}
      {staff && (
        <dl className="kv" style={{ marginTop: 12 }}>
          {staff.map((member) => (
            <div key={member.user_id} style={{ display: 'contents' }}>
              <dt>
                <AuthorName username={member.username} displayName={member.display_name} />
              </dt>
              <dd style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="page-note">
                  {member.role === 'admin' ? 'Admin' : 'Moderator'} since {formatLongDate(member.granted_at)}
                </span>
                {isAdmin && member.role === 'moderator' && (
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    disabled={busy !== null}
                    onClick={() =>
                      run(
                        `staff:${member.username}`,
                        async () => {
                          await setModerator(member.username, false)
                          await refreshDirectory()
                        },
                        'That moderator could not be removed.',
                      )
                    }
                  >
                    {busy === `staff:${member.username}` ? 'Removing...' : 'Remove moderator'}
                  </button>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {isAdmin && (
        <form
          className="field"
          style={{ marginTop: 16 }}
          onSubmit={(e) => {
            e.preventDefault()
            const username = newModerator.trim()
            if (!username) return
            void run(
              'add',
              async () => {
                await setModerator(username, true)
                await refreshDirectory()
                setNewModerator('')
              },
              'That account could not be made a moderator.',
            )
          }}
        >
          <label className="field-label" htmlFor="new-moderator">
            Make someone a moderator
          </label>
          <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input
              id="new-moderator"
              className="input"
              style={{ maxWidth: 260 }}
              value={newModerator}
              maxLength={24}
              placeholder="username"
              onChange={(e) => setNewModerator(e.target.value)}
            />
            <button type="submit" className="btn" disabled={busy !== null || !newModerator.trim()}>
              {busy === 'add' ? 'Adding...' : 'Add moderator'}
            </button>
          </span>
          <span className="field-hint">
            Moderators can edit or remove any ghost and suspend accounts. Only you can add or remove moderators.
          </span>
        </form>
      )}

      <div className="section-rule">
        <h2>Suspended accounts</h2>
      </div>
      {suspensions && suspensions.length === 0 && <p className="page-note">No accounts are suspended.</p>}
      {suspensions && suspensions.length > 0 && (
        <dl className="kv" style={{ marginTop: 12 }}>
          {suspensions.map((s) => (
            <div key={s.user_id} style={{ display: 'contents' }}>
              <dt>
                <AuthorName username={s.username} displayName={s.display_name} />
              </dt>
              <dd style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="page-note">
                  since {formatLongDate(s.suspended_at)}
                  {s.suspended_by_username ? ` by ${s.suspended_by_username}` : ''}
                  {s.reason ? ` · ${s.reason}` : ''}
                </span>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy !== null}
                  onClick={() => run(`lift:${s.user_id}`, () => unsuspendAccount(s.username), 'The suspension could not be lifted.')}
                >
                  {busy === `lift:${s.user_id}` ? 'Saving...' : 'Lift suspension'}
                </button>
              </dd>
            </div>
          ))}
        </dl>
      )}

      <div className="section-rule">
        <h2>Recent actions</h2>
      </div>
      {log && log.length === 0 && <p className="page-note">Nothing has been moderated yet.</p>}
      {log && log.length > 0 && (
        <dl className="kv" style={{ marginTop: 12 }}>
          {log.map((entry) => (
            <div key={entry.id} style={{ display: 'contents' }}>
              <dt>{formatLongDate(entry.created_at)}</dt>
              <dd>
                {describe(entry)}
                {entry.reason && <span className="page-note"> &middot; {entry.reason}</span>}
                {entry.details && (
                  <span className="page-note" style={{ display: 'block' }}>
                    {Object.entries(entry.details)
                      .map(([field, change]) => `${FIELD_LABELS[field] ?? field}: ${formatValue(field, change.from)} → ${formatValue(field, change.to)}`)
                      .join('; ')}
                  </span>
                )}
                {entry.action === 'remove_ghost' && entry.file_path && (
                  <>
                    {' '}
                    {deletedFiles.has(entry.file_path) ? (
                      <span className="page-note">&middot; file deleted</span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-quiet btn-sm"
                        title="Use this if removing the ghost could not delete its file. Deleting twice is harmless."
                        disabled={busy !== null}
                        onClick={() => {
                          const path = entry.file_path as string
                          void run(
                            `file:${entry.id}`,
                            async () => {
                              await retryFileRemoval(path)
                              setDeletedFiles((done) => new Set(done).add(path))
                            },
                            'The file could not be deleted. Try again in a moment.',
                          )
                        }}
                      >
                        {busy === `file:${entry.id}` ? 'Deleting...' : 'Delete file again'}
                      </button>
                    )}
                  </>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}
