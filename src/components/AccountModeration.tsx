import { useCallback, useEffect, useState } from 'react'
import { Notice } from './Notices'
import {
  fetchAccountStatus,
  MAX_REASON_LENGTH,
  suspendAccount,
  unsuspendAccount,
  type AccountStatus,
} from '../lib/moderation'
import { friendlyError } from '../lib/errors'
import { formatLongDate } from '../utils/format'

/** Staff-only panel on someone else's profile: their suspension, with suspend and restore. */
export function AccountModeration({ userId, username }: { userId: string; username: string }) {
  const [status, setStatus] = useState<AccountStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setStatus(await fetchAccountStatus(userId))
  }, [userId])

  useEffect(() => {
    load().catch((err) => setError(friendlyError(err, 'This account’s moderation status could not be loaded.')))
  }, [load])

  async function act(action: () => Promise<void>, fallback: string) {
    setBusy(true)
    setError(null)
    try {
      await action()
      await load()
      setConfirming(false)
      setReason('')
    } catch (err) {
      setError(friendlyError(err, fallback))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <p className="page-note" style={{ marginBottom: 8 }}>
        <strong>Moderation</strong> (only staff see this)
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      {status === null && !error && (
        <p className="page-note" role="status">
          Loading...
        </p>
      )}

      {status?.role && <p className="page-note">This account is staff, so it cannot be suspended.</p>}

      {status && !status.role && status.suspended && (
        <>
          <p className="page-note">
            Suspended {status.suspended_at ? formatLongDate(status.suspended_at) : ''}
            {status.suspended_by_username ? ` by ${status.suspended_by_username}` : ''}
            {status.reason ? `: ${status.reason}` : '.'} They can browse and download but not upload, edit,
            delete or link devices.
          </p>
          <button
            type="button"
            className="btn btn-sm"
            style={{ marginTop: 8 }}
            disabled={busy}
            onClick={() => act(() => unsuspendAccount(username), 'The suspension could not be lifted.')}
          >
            {busy ? 'Saving...' : 'Lift suspension'}
          </button>
        </>
      )}

      {status && !status.role && !status.suspended && !confirming && (
        <button type="button" className="btn btn-sm btn-danger" onClick={() => setConfirming(true)}>
          Suspend account
        </button>
      )}

      {status && !status.role && !status.suspended && confirming && (
        <form
          className="field"
          onSubmit={(e) => {
            e.preventDefault()
            void act(() => suspendAccount(username, reason), 'This account could not be suspended.')
          }}
        >
          <label className="field-label" htmlFor="suspend-reason">
            Reason (shown to {username}, optional)
          </label>
          <input
            id="suspend-reason"
            className="input"
            value={reason}
            maxLength={MAX_REASON_LENGTH}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. repeated junk uploads"
            autoFocus
          />
          <span className="field-hint">
            They keep their ghosts and can still browse, download and delete their account, but cannot change
            anything until the suspension is lifted.
          </span>
          <span style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button type="submit" className="btn btn-sm btn-danger" disabled={busy}>
              {busy ? 'Suspending...' : 'Suspend'}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </button>
          </span>
        </form>
      )}
    </div>
  )
}
