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
 *
 * TAS runs carry a prefix, "TAS Bianco Hills 4 - 1:00.794". The prefix becomes
 * the TAS flag rather than part of the level, so the level filter groups TAS
 * and RTA ghosts for the same stage together.
 */
export function splitRunLabel(label: string): { level: string | null; time: string | null; isTas: boolean } {
  let text = label.trim()
  const tasPrefix = /^TAS\b[\s:-]*/i.exec(text)
  const isTas = tasPrefix !== null
  if (tasPrefix) text = text.slice(tasPrefix[0].length)

  const match = /^(.*?)\s*[-\u2013\u2014]\s*((?:\d+:)?(?:\d+:)?\d+(?:\.\d{1,3})?)$/.exec(text)
  if (!match) return { level: null, time: null, isTas }

  const level = match[1].trim()
  const ms = parseTimeInput(match[2])
  return { level: level || null, time: ms === null ? null : formatTime(ms), isTas }
}

/**
 * The time in a filename is the displayed clock time with the punctuation
 * removed, not a millisecond count: `1:00.794` is written `100794`. The two
 * readings only agree under a minute, which is why the original 37-second
 * sample never showed the difference. Verified against
 * 2026_10_13_BH4_100794[208BB539], whose run label reads 1:00.794.
 *
 * Digits are read from the right: three of milliseconds, two of seconds, then
 * minutes, and anything beyond two minute digits is hours.
 */
export function decodeFilenameTime(digits: string): number | null {
  if (!/^\d{3,9}$/.test(digits)) return null
  const millis = Number(digits.slice(-3))
  const seconds = Number(digits.slice(-5, -3) || '0')
  const rest = digits.slice(0, -5)
  const minutes = Number(rest.slice(-2) || '0')
  const hours = Number(rest.slice(0, -2) || '0')

  // A seconds or minutes field of 60+ cannot be a clock reading.
  if (seconds > 59 || (hours > 0 && minutes > 59)) return null

  const ms = ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis
  return ms > 0 && ms <= 86_400_000 ? ms : null
}

/**
 * Filenames are date, level code, time, checksum. Moonshine has written the
 * checksum two ways:
 *
 *   2026_09_05_BH3_37337_CDDABF1F_.smsghost    (0.4)
 *   2026_10_13_AS1_45645[DE2C7FB6].smsghost    (0.6)
 *
 * Used when the run label is unavailable. Browsers may also append " (1)" to
 * a repeated download, which is dropped along with the bracketed checksum.
 */
export function readFilenameHints(filename: string): { level: string | null; time: string | null } {
  const stem = filename
    .replace(/\.smsghost$/i, '')
    .replace(/\s*\(\d+\)$/, '')
    .replace(/\s*\[[0-9A-Fa-f]+\]/g, '_')
  const parts = stem.split(/[_\s]+/).filter(Boolean)

  let level: string | null = null
  let time: string | null = null

  for (let i = 0; i < parts.length; i++) {
    const expanded = expandLevelCode(parts[i])
    if (expanded && !level) {
      level = expanded
      // The time normally follows the level code directly.
      const next = parts[i + 1]
      const ms = next ? decodeFilenameTime(next) : null
      if (ms !== null) time = formatTime(ms)
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
  const fromLabel = parsed.title ? splitRunLabel(parsed.title) : { level: null, time: null, isTas: false }
  const fromName = readFilenameHints(filename)
  const level = fromLabel.level ?? fromName.level
  const time = fromLabel.time ?? fromName.time
  if (level) suggestion.level = level.slice(0, 48)
  if (time) suggestion.time = time
  if (fromLabel.isTas) suggestion.isTas = true

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
