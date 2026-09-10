import type { ParsedGhost } from './GhostParser'
import { parseTimeInput, formatTime } from '../../utils/time'
import { expandLevelCode } from '../../utils/levels'

/** Metadata the app keeps about a ghost, separate from the container itself. */
export interface GhostMetadataInput {
  title: string
  description: string
  level: string
  /** As typed by the uploader; converted to milliseconds on save. */
  time: string
  isTas: boolean
  moonshineVersion: string
  tags: string[]
}

export const EMPTY_METADATA: GhostMetadataInput = {
  title: '',
  description: '',
  level: '',
  time: '',
  isTas: false,
  moonshineVersion: '',
  tags: [],
}

/**
 * Moonshine writes its run label as "<level> - <time>", e.g.
 * "Bianco Hills 3 - 0:37.337". Split it so the upload form arrives filled in.
 */
export function splitRunLabel(label: string): { level: string | null; time: string | null } {
  const match = /^(.*?)\s*[-\u2013\u2014]\s*((?:\d+:)?(?:\d+:)?\d+(?:\.\d{1,3})?)$/.exec(label.trim())
  if (!match) return { level: null, time: null }

  const level = match[1].trim()
  const ms = parseTimeInput(match[2])
  return { level: level || null, time: ms === null ? null : formatTime(ms) }
}

/**
 * Filenames look like 2026_09_05_BH3_37337_CDDABF1F_.smsghost - date, level
 * code, milliseconds, checksum. Used when the run label is unavailable.
 */
export function readFilenameHints(filename: string): { level: string | null; time: string | null } {
  const stem = filename.replace(/\.smsghost$/i, '')
  const parts = stem.split('_').filter(Boolean)

  let level: string | null = null
  let time: string | null = null

  for (let i = 0; i < parts.length; i++) {
    const expanded = expandLevelCode(parts[i])
    if (expanded && !level) {
      level = expanded
      // Milliseconds normally follow the level code directly.
      const next = parts[i + 1]
      if (next && /^\d{3,8}$/.test(next)) {
        const ms = Number(next)
        if (ms > 0 && ms <= 86_400_000) time = formatTime(ms)
      }
    }
  }

  return { level, time }
}

/**
 * Suggests form values from a parsed container so the upload form arrives
 * pre-filled. Everything here is a suggestion the uploader can overwrite.
 */
export function suggestMetadata(parsed: ParsedGhost, filename: string): Partial<GhostMetadataInput> {
  const suggestion: Partial<GhostMetadataInput> = {}

  if (parsed.title) {
    suggestion.title = parsed.title.slice(0, 100)
  } else {
    const stem = filename.replace(/\.smsghost$/i, '').replace(/_+/g, ' ').trim()
    if (stem) suggestion.title = stem.slice(0, 100)
  }

  if (parsed.recognisedVersion) suggestion.moonshineVersion = parsed.versionLabel

  // Level and time come from the run label when present, otherwise from the
  // filename Moonshine generated.
  const fromLabel = parsed.title ? splitRunLabel(parsed.title) : { level: null, time: null }
  const fromName = readFilenameHints(filename)
  const level = fromLabel.level ?? fromName.level
  const time = fromLabel.time ?? fromName.time
  if (level) suggestion.level = level.slice(0, 48)
  if (time) suggestion.time = time

  const tags: string[] = []
  if (parsed.category) {
    const tag = parsed.category.toLowerCase().replace(/[^a-z0-9 _-]/g, '').trim()
    if (tag) tags.push(tag.slice(0, 24))
  }
  if (tags.length) suggestion.tags = tags

  return suggestion
}

/** Human-readable facts shown next to the file picker after a file is chosen. */
export function describeParsedGhost(parsed: ParsedGhost): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [
    { label: 'Container', value: `${parsed.magic} v${parsed.versionLabel}` },
    { label: 'Game', value: parsed.gameId || 'unknown' },
  ]
  if (parsed.title) rows.push({ label: 'Recorded as', value: parsed.title })
  if (parsed.category) rows.push({ label: 'Category', value: parsed.category })
  rows.push({
    label: 'Integrity',
    value: parsed.crcVerified ? 'CRC32 checks passed' : 'CRC32 could not be confirmed',
  })
  return rows
}
