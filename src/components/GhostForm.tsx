import { useId, useState } from 'react'
import { Notice } from './Notices'
import { validateGhostFile, describeParsedGhost, suggestMetadata } from '../lib/ghost'
import type { ParsedGhost } from '../lib/ghost'
import { parseTags, validateDescription, validateTitle } from '../utils/validation'
import { formatBytes } from '../utils/format'
import { GHOST_EXTENSION } from '../types'

export interface GhostFormValues {
  title: string
  description: string
  isTas: boolean
  moonshineVersion: string
  tags: string[]
}

interface GhostFormProps {
  mode: 'create' | 'edit'
  initial?: Partial<GhostFormValues>
  /** Filename of the ghost already attached, shown in edit mode. */
  existingFilename?: string
  submitting: boolean
  submitLabel: string
  disabled?: boolean
  onSubmit: (values: GhostFormValues, file: File | null) => void | Promise<void>
}

export function GhostForm({
  mode,
  initial,
  existingFilename,
  submitting,
  submitLabel,
  disabled = false,
  onSubmit,
}: GhostFormProps) {
  const ids = {
    title: useId(),
    description: useId(),
    version: useId(),
    tags: useId(),
    file: useId(),
  }

  const [title, setTitle] = useState(initial?.title ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [isTas, setIsTas] = useState(initial?.isTas ?? false)
  const [moonshineVersion, setMoonshineVersion] = useState(initial?.moonshineVersion ?? '')
  const [tagInput, setTagInput] = useState((initial?.tags ?? []).join(', '))

  const [file, setFile] = useState<File | null>(null)
  const [parsed, setParsed] = useState<ParsedGhost | null>(null)
  const [fileErrors, setFileErrors] = useState<string[]>([])
  const [fileWarnings, setFileWarnings] = useState<string[]>([])
  const [checkingFile, setCheckingFile] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files?.[0] ?? null
    setFile(null)
    setParsed(null)
    setFileErrors([])
    setFileWarnings([])
    if (!picked) return

    setCheckingFile(true)
    const result = await validateGhostFile(picked)
    setCheckingFile(false)
    setFileErrors(result.errors)
    setFileWarnings(result.warnings)
    setParsed(result.parsed)

    if (!result.ok) return
    setFile(picked)

    // Pre-fill from the container, without overwriting anything already typed.
    if (result.parsed) {
      const suggestion = suggestMetadata(result.parsed, picked.name)
      if (suggestion.title && !title.trim()) setTitle(suggestion.title)
      if (suggestion.moonshineVersion && !moonshineVersion.trim()) {
        setMoonshineVersion(suggestion.moonshineVersion)
      }
      if (suggestion.tags?.length && !tagInput.trim()) setTagInput(suggestion.tags.join(', '))
    }
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const errors: Record<string, string> = {}

    const titleError = validateTitle(title)
    if (titleError) errors.title = titleError

    const descriptionError = validateDescription(description)
    if (descriptionError) errors.description = descriptionError

    if (mode === 'create' && !file) errors.file = 'Choose the ghost file to upload.'

    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) return

    void onSubmit(
      {
        title: title.trim(),
        description: description.trim(),
        isTas,
        moonshineVersion: moonshineVersion.trim(),
        tags: parseTags(tagInput),
      },
      file,
    )
  }

  const busy = submitting || disabled

  return (
    <form onSubmit={handleSubmit} noValidate>
      <div className="field">
        <label className="field-label" htmlFor={ids.title}>
          Title
        </label>
        <input
          id={ids.title}
          className="input"
          value={title}
          maxLength={100}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Bianco Hills 3 - 0:37.337"
          aria-invalid={Boolean(fieldErrors.title)}
          disabled={busy}
        />
        {fieldErrors.title && <span className="field-error">{fieldErrors.title}</span>}
      </div>

      <div className="field">
        <label className="field-label" htmlFor={ids.description}>
          Description
        </label>
        <textarea
          id={ids.description}
          className="textarea"
          value={description}
          maxLength={2000}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Route notes, setup, what makes this ghost useful to follow."
          disabled={busy}
        />
        <span className="field-hint">{description.length} / 2000</span>
        {fieldErrors.description && <span className="field-error">{fieldErrors.description}</span>}
      </div>

      <div className="field">
        <label className="checkbox">
          <input type="checkbox" checked={isTas} onChange={(e) => setIsTas(e.target.checked)} disabled={busy} />
          <span>
            TAS
            <span className="field-hint" style={{ display: 'block' }}>
              Mark this if the run was produced with tools rather than played by hand.
            </span>
          </span>
        </label>
      </div>

      <div className="field">
        <label className="field-label" htmlFor={ids.version}>
          Moonshine version
        </label>
        <input
          id={ids.version}
          className="input"
          value={moonshineVersion}
          maxLength={32}
          onChange={(e) => setMoonshineVersion(e.target.value)}
          placeholder="0.4.1"
          disabled={busy}
        />
        <span className="field-hint">Optional. Filled in from the file when it can be read.</span>
      </div>

      <div className="field">
        <label className="field-label" htmlFor={ids.tags}>
          Tags
        </label>
        <input
          id={ids.tags}
          className="input"
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          placeholder="any percent, bianco hills, shine 3"
          disabled={busy}
        />
        <span className="field-hint">Optional. Comma separated, up to eight.</span>
      </div>

      <div className="field">
        <label className="field-label" htmlFor={ids.file}>
          Ghost file
        </label>
        <input
          id={ids.file}
          className="input"
          type="file"
          accept={GHOST_EXTENSION}
          onChange={handleFileChange}
          disabled={busy}
          aria-describedby={`${ids.file}-hint`}
        />
        <span className="field-hint" id={`${ids.file}-hint`}>
          {mode === 'edit'
            ? `Currently ${existingFilename}. Choose a file only if you want to replace it.`
            : `A single ${GHOST_EXTENSION} file, up to 2 MB.`}
        </span>
        {fieldErrors.file && <span className="field-error">{fieldErrors.file}</span>}
      </div>

      {checkingFile && <p className="page-note">Checking file...</p>}

      {fileErrors.map((message) => (
        <Notice tone="error" key={message}>
          {message}
        </Notice>
      ))}
      {fileWarnings.map((message) => (
        <Notice tone="warn" key={message}>
          {message}
        </Notice>
      ))}

      {file && parsed && (
        <div className="panel" style={{ margin: '12px 0 18px' }}>
          <dl className="kv">
            <dt>File</dt>
            <dd>
              {file.name} ({formatBytes(file.size)})
            </dd>
            {describeParsedGhost(parsed).map((row) => (
              <div key={row.label} style={{ display: 'contents' }}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <button type="submit" className="btn btn-primary" disabled={busy}>
        {submitting ? 'Working...' : submitLabel}
      </button>
    </form>
  )
}
