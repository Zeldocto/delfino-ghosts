import { Link } from 'react-router-dom'
import { formatBytes } from '../utils/format'
import { LEVEL_SUGGESTIONS } from '../utils/levels'
import { validateTimeInput } from '../utils/time'
import type { GhostFormValues } from './GhostForm'

export type QueueStatus = 'checking' | 'ready' | 'invalid' | 'uploading' | 'done' | 'error'

export interface QueueEntry {
  key: string
  file: File
  status: QueueStatus
  errors: string[]
  warnings: string[]
  values: GhostFormValues
  expanded: boolean
  ghostId?: string
  message?: string
}

const STATUS_LABEL: Record<QueueStatus, string> = {
  checking: 'checking',
  ready: 'ready',
  invalid: 'rejected',
  uploading: 'uploading',
  done: 'uploaded',
  error: 'failed',
}

interface QueueItemProps {
  entry: QueueEntry
  onChange: (key: string, patch: Partial<GhostFormValues>) => void
  onToggleExpand: (key: string) => void
  onRemove: (key: string) => void
}

function QueueItem({ entry, onChange, onToggleExpand, onRemove }: QueueItemProps) {
  const locked = entry.status === 'uploading' || entry.status === 'done'
  const inputId = `title-${entry.key}`

  return (
    <div className="queue-item" data-status={entry.status}>
      <div className="queue-head">
        <span className={`queue-status queue-status-${entry.status}`}>{STATUS_LABEL[entry.status]}</span>

        <span className="queue-title-cell">
          <label className="sr-only" htmlFor={inputId}>
            Title for {entry.file.name}
          </label>
          {entry.status === 'done' && entry.ghostId ? (
            <Link to={`/ghost/${entry.ghostId}`} className="ghost-title">
              {entry.values.title}
            </Link>
          ) : (
            <input
              id={inputId}
              className="input"
              value={entry.values.title}
              maxLength={100}
              disabled={locked || entry.status === 'invalid'}
              placeholder="Title"
              onChange={(e) => onChange(entry.key, { title: e.target.value })}
            />
          )}
        </span>

        <span className="queue-level-cell">
          <label className="sr-only" htmlFor={`level-${entry.key}`}>
            Level for {entry.file.name}
          </label>
          <input
            id={`level-${entry.key}`}
            className="input"
            list="delfino-levels"
            value={entry.values.level}
            maxLength={48}
            disabled={locked || entry.status === 'invalid'}
            placeholder="Level"
            onChange={(e) => onChange(entry.key, { level: e.target.value })}
          />
        </span>

        <span className="queue-time-cell">
          <label className="sr-only" htmlFor={`time-${entry.key}`}>
            Time for {entry.file.name}
          </label>
          <input
            id={`time-${entry.key}`}
            className="input"
            value={entry.values.time}
            maxLength={12}
            inputMode="decimal"
            disabled={locked || entry.status === 'invalid'}
            placeholder="Time"
            aria-invalid={Boolean(validateTimeInput(entry.values.time))}
            onChange={(e) => onChange(entry.key, { time: e.target.value })}
          />
        </span>

        <label className="checkbox queue-tas">
          <input
            type="checkbox"
            checked={entry.values.isTas}
            disabled={locked || entry.status === 'invalid'}
            onChange={(e) => onChange(entry.key, { isTas: e.target.checked })}
          />
          <span>TAS</span>
        </label>

        <span className="queue-actions">
          {entry.status !== 'invalid' && entry.status !== 'done' && (
            <button
              type="button"
              className="btn btn-sm btn-quiet"
              onClick={() => onToggleExpand(entry.key)}
              aria-expanded={entry.expanded}
            >
              {entry.expanded ? 'Less' : 'Details'}
            </button>
          )}
          {!locked && (
            <button
              type="button"
              className="btn btn-sm btn-quiet"
              onClick={() => onRemove(entry.key)}
              aria-label={`Remove ${entry.file.name} from the queue`}
            >
              Remove
            </button>
          )}
        </span>
      </div>

      <p className="queue-file">
        {entry.file.name} · {formatBytes(entry.file.size)}
        {entry.message ? ` · ${entry.message}` : ''}
      </p>

      {validateTimeInput(entry.values.time) && entry.status !== 'invalid' && (
        <p className="queue-message queue-message-error">{validateTimeInput(entry.values.time)}</p>
      )}

      {entry.errors.map((message) => (
        <p className="queue-message queue-message-error" key={message} role="alert">
          {message}
        </p>
      ))}
      {entry.warnings.map((message) => (
        <p className="queue-message queue-message-warn" key={message}>
          {message}
        </p>
      ))}

      {entry.expanded && entry.status !== 'invalid' && (
        <div className="queue-detail">
          <div className="field">
            <label className="field-label" htmlFor={`desc-${entry.key}`}>
              Description
            </label>
            <textarea
              id={`desc-${entry.key}`}
              className="textarea"
              style={{ minHeight: 70 }}
              value={entry.values.description}
              maxLength={2000}
              disabled={locked}
              onChange={(e) => onChange(entry.key, { description: e.target.value })}
            />
          </div>

          <div className="queue-detail-row">
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="field-label" htmlFor={`ver-${entry.key}`}>
                Moonshine version
              </label>
              <input
                id={`ver-${entry.key}`}
                className="input"
                value={entry.values.moonshineVersion}
                maxLength={32}
                disabled={locked}
                onChange={(e) => onChange(entry.key, { moonshineVersion: e.target.value })}
              />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="field-label" htmlFor={`tags-${entry.key}`}>
                Tags
              </label>
              <input
                id={`tags-${entry.key}`}
                className="input"
                value={entry.values.tags.join(', ')}
                disabled={locked}
                placeholder="any percent, bianco hills"
                onChange={(e) =>
                  onChange(entry.key, { tags: e.target.value.split(',').map((t) => t.trim()) })
                }
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

interface UploadQueueProps {
  entries: QueueEntry[]
  onChange: (key: string, patch: Partial<GhostFormValues>) => void
  onToggleExpand: (key: string) => void
  onRemove: (key: string) => void
}

export function UploadQueue({ entries, onChange, onToggleExpand, onRemove }: UploadQueueProps) {
  if (entries.length === 0) return null

  return (
    <div className="queue" aria-label="Upload queue">
      <datalist id="delfino-levels">
        {LEVEL_SUGGESTIONS.map((name) => (
          <option value={name} key={name} />
        ))}
      </datalist>
      {entries.map((entry) => (
        <QueueItem
          key={entry.key}
          entry={entry}
          onChange={onChange}
          onToggleExpand={onToggleExpand}
          onRemove={onRemove}
        />
      ))}
    </div>
  )
}
