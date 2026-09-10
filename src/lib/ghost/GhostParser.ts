/**
 * GhostParser
 * ---------------------------------------------------------------------------
 * Reads the binary container Moonshine writes for a `.smsghost` file.
 *
 * The layout below was derived by inspecting a real ghost
 * (`2026_09_05_BH3_37337_CDDABF1F_.smsghost`). Two facts are verifiable rather
 * than guessed, and they are what the validator leans on:
 *
 *   - the word at 0x08 equals the file length in bytes
 *   - the word at 0x0C is CRC32 of the whole file with those four bytes zeroed
 *   - the word at 0x14 is CRC32 of the payload that begins at 0x100
 *
 * The string offsets (title, category) are inferred from a single sample and
 * are therefore held in a version-keyed profile. When Moonshine changes its
 * format, add a new entry to `PROFILES` — nothing outside this file needs to
 * know. Unknown versions still parse: they fall back to a profile that reads
 * only the fixed preamble and reports the rest as unavailable.
 */

export const GHOST_MAGIC = 'SGHF'

/** Offsets that have held across every observed revision of the container. */
const OFF_MAGIC = 0x00
const OFF_VERSION = 0x04
const OFF_DECLARED_SIZE = 0x08
const OFF_HEADER_CRC = 0x0c
const OFF_BUILD_ID = 0x10
const OFF_PAYLOAD_CRC = 0x14
const OFF_GAME_ID = 0x20

export interface GhostVersion {
  major: number
  minor: number
  patch: number
  raw: number
}

export interface ParsedGhost {
  magic: string
  version: GhostVersion
  versionLabel: string
  /** Size the file claims to be, in bytes. */
  declaredSize: number
  /** Actual byte length of what we were handed. */
  actualSize: number
  headerCrc: number
  payloadCrc: number
  buildId: number
  /** GameCube game id, e.g. GMSJ (Super Mario Sunshine, JP). */
  gameId: string
  /** Label Moonshine stored with the run, e.g. "Bianco Hills 3 - 0:37.337". */
  title: string | null
  /** Category label, e.g. "Any percent". */
  category: string | null
  payloadOffset: number
  payloadSize: number
  /** True when the version matched a profile we know the string layout for. */
  recognisedVersion: boolean
  crcVerified: boolean
}

interface FormatProfile {
  payloadOffset: number
  /** [offset, maxBytes] of the run label, or null when the layout is unknown. */
  title: [number, number] | null
  category: [number, number] | null
}

const FALLBACK_PROFILE: FormatProfile = {
  payloadOffset: 0x100,
  title: null,
  category: null,
}

/**
 * Keyed by `major.minor` of the container version word.
 * 0.4 is the revision produced by current Moonshine builds.
 */
const PROFILES: Record<string, FormatProfile> = {
  '0.4': {
    payloadOffset: 0x100,
    title: [0x78, 48],
    category: [0xa8, 16],
  },
}

// --- CRC32 -----------------------------------------------------------------

let CRC_TABLE: Uint32Array | null = null

function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  CRC_TABLE = table
  return table
}

/** CRC32 (IEEE) over a byte range, optionally treating four bytes as zero. */
export function crc32(bytes: Uint8Array, skipStart = -1, skipLength = 0): number {
  const table = crcTable()
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    const inSkip = skipStart >= 0 && i >= skipStart && i < skipStart + skipLength
    const byte = inSkip ? 0 : bytes[i]
    crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff]
  }
  return (crc ^ 0xffffffff) >>> 0
}

// --- Reading ---------------------------------------------------------------

function readAscii(bytes: Uint8Array, offset: number, maxLength: number): string | null {
  if (offset + maxLength > bytes.length) return null
  let end = offset
  const limit = offset + maxLength
  while (end < limit && bytes[end] !== 0x00) end++
  if (end === offset) return null
  let out = ''
  for (let i = offset; i < end; i++) {
    const c = bytes[i]
    // Printable ASCII only. Anything else means we are not looking at a string.
    if (c < 0x20 || c > 0x7e) return null
    out += String.fromCharCode(c)
  }
  return out.trim() || null
}

export class GhostFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GhostFormatError'
  }
}

/** Parses a `.smsghost` container. Throws GhostFormatError on a non-ghost. */
export function parseGhost(buffer: ArrayBuffer): ParsedGhost {
  const bytes = new Uint8Array(buffer)
  if (bytes.length < 0x100) {
    throw new GhostFormatError('This file is too small to be a Moonshine ghost.')
  }

  const view = new DataView(buffer)
  const magic = readAscii(bytes, OFF_MAGIC, 4)
  if (magic !== GHOST_MAGIC) {
    throw new GhostFormatError('This is not a Moonshine ghost file.')
  }

  const rawVersion = view.getUint32(OFF_VERSION, false)
  const version: GhostVersion = {
    major: (rawVersion >>> 24) & 0xff,
    minor: (rawVersion >>> 16) & 0xff,
    patch: (rawVersion >>> 8) & 0xff,
    raw: rawVersion,
  }
  const versionKey = `${version.major}.${version.minor}`
  const profile = PROFILES[versionKey] ?? FALLBACK_PROFILE
  const recognisedVersion = versionKey in PROFILES

  const declaredSize = view.getUint32(OFF_DECLARED_SIZE, false)
  const headerCrc = view.getUint32(OFF_HEADER_CRC, false)
  const buildId = view.getUint32(OFF_BUILD_ID, false)
  const payloadCrc = view.getUint32(OFF_PAYLOAD_CRC, false)
  const gameId = readAscii(bytes, OFF_GAME_ID, 4) ?? ''

  const payloadOffset = Math.min(profile.payloadOffset, bytes.length)
  const payloadSize = bytes.length - payloadOffset

  const headerCrcOk = crc32(bytes, OFF_HEADER_CRC, 4) === headerCrc
  const payloadCrcOk = crc32(bytes.subarray(payloadOffset)) === payloadCrc

  return {
    magic,
    version,
    versionLabel: `${version.major}.${version.minor}.${version.patch}`,
    declaredSize,
    actualSize: bytes.length,
    headerCrc,
    payloadCrc,
    buildId,
    gameId,
    title: profile.title ? readAscii(bytes, profile.title[0], profile.title[1]) : null,
    category: profile.category ? readAscii(bytes, profile.category[0], profile.category[1]) : null,
    payloadOffset,
    payloadSize,
    recognisedVersion,
    crcVerified: headerCrcOk && payloadCrcOk,
  }
}

export async function parseGhostFile(file: File): Promise<ParsedGhost> {
  return parseGhost(await file.arrayBuffer())
}
