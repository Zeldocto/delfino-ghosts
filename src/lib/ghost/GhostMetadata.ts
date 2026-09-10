import type { ParsedGhost } from './GhostParser'

/** Metadata the app keeps about a ghost, separate from the container itself. */
export interface GhostMetadataInput {
  title: string
  description: string
  isTas: boolean
  moonshineVersion: string
  tags: string[]
}

export const EMPTY_METADATA: GhostMetadataInput = {
  title: '',
  description: '',
  isTas: false,
  moonshineVersion: '',
  tags: [],
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
  if (parsed.category) rows.push({ label: 'Category', value: parsed.category })
  rows.push({
    label: 'Integrity',
    value: parsed.crcVerified ? 'CRC32 checks passed' : 'CRC32 could not be confirmed',
  })
  return rows
}
