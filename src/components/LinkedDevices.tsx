import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Notice } from './Notices'
import { listLinkedDevices, revokeLinkedDevice, type LinkedDevice } from '../lib/moonshine'
import { friendlyError } from '../lib/errors'
import { formatLongDate } from '../utils/format'

/** Settings section: devices that can upload as this account, with unlink. */
export function LinkedDevices() {
  const [devices, setDevices] = useState<LinkedDevice[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    listLinkedDevices()
      .then((rows) => {
        if (active) setDevices(rows)
      })
      .catch((err) => {
        if (active) setError(friendlyError(err, 'Linked devices could not be loaded.'))
      })
    return () => {
      active = false
    }
  }, [])

  async function unlink(id: string) {
    setBusy(id)
    setError(null)
    try {
      await revokeLinkedDevice(id)
      setDevices((rows) => (rows ?? []).filter((row) => row.id !== id))
    } catch (err) {
      setError(friendlyError(err, 'That device could not be unlinked.'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <div className="section-rule">
        <h2>Linked devices</h2>
      </div>
      <p className="page-note" style={{ marginTop: 12 }}>
        Wii or Dolphin setups running Moonshine that can upload ghosts as you. To add one, choose
        the link option in Moonshine and enter its code at <Link to="/link">/link</Link>.
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      {devices === null && !error && (
        <p className="page-note" role="status">
          Loading...
        </p>
      )}
      {devices && devices.length === 0 && <p className="page-note">No devices are linked.</p>}
      {devices && devices.length > 0 && (
        <dl className="kv" style={{ marginTop: 12 }}>
          {devices.map((device) => (
            <div key={device.id} style={{ display: 'contents' }}>
              <dt>
                {device.client_name}
                {device.client_version ? ` ${device.client_version}` : ''}
              </dt>
              <dd style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="page-note">
                  {device.linked_at ? `linked ${formatLongDate(device.linked_at)}` : 'approved, not yet connected'}
                  {device.last_used_at ? ` · last used ${formatLongDate(device.last_used_at)}` : ''}
                </span>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => unlink(device.id)}
                  disabled={busy === device.id}
                >
                  {busy === device.id ? 'Unlinking...' : 'Unlink'}
                </button>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </>
  )
}
