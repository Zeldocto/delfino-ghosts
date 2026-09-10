import { GHOST_EXTENSION, MAX_GHOST_BYTES } from '../../types'
import { GhostFormatError, parseGhostFile, type ParsedGhost } from './GhostParser'

export interface ValidationResult {
  ok: boolean
  errors: string[]
  warnings: string[]
  parsed: ParsedGhost | null
}

/** Game ids for Super Mario Sunshine across regions. */
const KNOWN_GAME_IDS = new Set(['GMSJ', 'GMSE', 'GMSP'])

/**
 * Front-of-house validation. It exists to give the uploader a useful message
 * before anything is sent; it is not the security boundary. Storage enforces
 * the size ceiling and the .smsghost extension, and the database enforces
 * ownership, size and the 200-ghost limit regardless of what the browser does.
 */
export async function validateGhostFile(file: File): Promise<ValidationResult> {
  const errors: string[] = []
  const warnings: string[] = []

  if (!file.name.toLowerCase().endsWith(GHOST_EXTENSION)) {
    errors.push(`Ghosts are ${GHOST_EXTENSION} files. Pick the file Moonshine wrote.`)
    return { ok: false, errors, warnings, parsed: null }
  }

  if (file.size === 0) {
    errors.push('That file is empty.')
    return { ok: false, errors, warnings, parsed: null }
  }

  if (file.size > MAX_GHOST_BYTES) {
    errors.push(`Ghosts are limited to ${MAX_GHOST_BYTES / 1024 / 1024} MB. This one is larger.`)
    return { ok: false, errors, warnings, parsed: null }
  }

  let parsed: ParsedGhost
  try {
    parsed = await parseGhostFile(file)
  } catch (err) {
    errors.push(err instanceof GhostFormatError ? err.message : 'This file could not be read as a ghost.')
    return { ok: false, errors, warnings, parsed: null }
  }

  if (parsed.declaredSize !== parsed.actualSize) {
    errors.push('The ghost is truncated or padded: its recorded length does not match the file.')
  }

  if (!parsed.crcVerified) {
    if (parsed.recognisedVersion) {
      errors.push('The ghost failed its checksum. It is corrupted or has been edited.')
    } else {
      warnings.push('Checksums could not be confirmed for this container version.')
    }
  }

  if (!parsed.recognisedVersion) {
    warnings.push(
      `Container version ${parsed.versionLabel} is newer than this site knows about. ` +
        'The file uploads and downloads unchanged, but details may be missing.',
    )
  }

  if (parsed.gameId && !KNOWN_GAME_IDS.has(parsed.gameId)) {
    warnings.push(`Recorded against game id ${parsed.gameId}, which is not a Sunshine disc id.`)
  }

  if (parsed.payloadSize <= 0) {
    errors.push('The ghost contains no input data.')
  }

  return { ok: errors.length === 0, errors, warnings, parsed }
}
