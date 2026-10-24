import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Notice } from '../components/Notices'
import { useAuth } from '../lib/auth'
import { decideLink, linkErrorMessage, lookupLinkCode, type PendingLink } from '../lib/moonshine'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { formatLongDate } from '../utils/format'

type Stage = 'enter' | 'checking' | 'confirm' | 'deciding' | 'approved' | 'denied'

/** Normalises what people type: "bcdf ghjk" -> "BCDF-GHJK". */
function tidyCode(raw: string): string {
  const letters = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
  return letters.length > 4 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : letters
}

/**
 * Approves a device (a Wii or a Dolphin companion running Moonshine) that is
 * showing a link code. The device never sees the player's password; it gets a
 * token that only works for Moonshine uploads and can be revoked in Settings.
 */
export function LinkDevice() {
  useDocumentTitle('Link a device')
  const { profile } = useAuth()
  const [params] = useSearchParams()
  const [code, setCode] = useState(() => tidyCode(params.get('code') ?? ''))
  const [stage, setStage] = useState<Stage>('enter')
  const [pending, setPending] = useState<PendingLink | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function check(value: string) {
    setStage('checking')
    setError(null)
    try {
      setPending(await lookupLinkCode(value))
      setStage('confirm')
    } catch (err) {
      setError(linkErrorMessage(err))
      setStage('enter')
    }
  }

  // Arriving from the QR code or the full link: look the code up straight away.
  useEffect(() => {
    const initial = tidyCode(params.get('code') ?? '')
    if (initial.length === 9) void check(initial)
    // Only on first render; later lookups come from the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function decide(approve: boolean) {
    setStage('deciding')
    setError(null)
    try {
      await decideLink(code, approve)
      setStage(approve ? 'approved' : 'denied')
    } catch (err) {
      setError(linkErrorMessage(err))
      setStage('enter')
    }
  }

  return (
    <div className="page form-narrow">
      <h1 className="page-title">Link a device</h1>
      <p className="page-note" style={{ margin: '8px 0 18px' }}>
        Lets Moonshine on your Wii or in Dolphin upload ghosts to your account
        {profile ? <> (<strong>{profile.username}</strong>)</> : null}. You never type your
        password on the device.
      </p>

      {error && <Notice tone="error">{error}</Notice>}

      {(stage === 'enter' || stage === 'checking') && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (code.length === 9) void check(code)
            else setError('Codes are eight letters, like BCDF-GHJK.')
          }}
          noValidate
          style={{ marginTop: 14 }}
        >
          <div className="field">
            <label className="field-label" htmlFor="link-code">
              Code shown on the device
            </label>
            <input
              id="link-code"
              className="input"
              value={code}
              onChange={(e) => setCode(tidyCode(e.target.value))}
              placeholder="BCDF-GHJK"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              disabled={stage === 'checking'}
              style={{ letterSpacing: '0.15em', textTransform: 'uppercase' }}
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={stage === 'checking'}>
            {stage === 'checking' ? 'Checking...' : 'Continue'}
          </button>
        </form>
      )}

      {(stage === 'confirm' || stage === 'deciding') && pending && (
        <div style={{ marginTop: 14 }}>
          <dl className="kv" style={{ marginBottom: 18 }}>
            <dt>Device</dt>
            <dd>
              {pending.client_name}
              {pending.client_version ? ` ${pending.client_version}` : ''}
            </dd>
            <dt>Code</dt>
            <dd>{code}</dd>
            <dt>Requested</dt>
            <dd>{formatLongDate(pending.requested_at)}</dd>
          </dl>
          <p className="prose" style={{ marginBottom: 14 }}>
            Only approve this if the same code is on your screen right now. The device will be able
            to upload ghosts as you until you unlink it in Settings.
          </p>
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="button" className="btn btn-primary" onClick={() => decide(true)} disabled={stage === 'deciding'}>
              {stage === 'deciding' ? 'Saving...' : 'Approve'}
            </button>
            <button type="button" className="btn" onClick={() => decide(false)} disabled={stage === 'deciding'}>
              Deny
            </button>
          </div>
        </div>
      )}

      {stage === 'approved' && (
        <Notice tone="ok">
          Linked. The device will finish connecting by itself within a few seconds. You can unlink
          it any time from <Link to="/settings">Settings</Link>.
        </Notice>
      )}
      {stage === 'denied' && <Notice>Denied. The device was not linked.</Notice>}
    </div>
  )
}
