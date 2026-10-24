/**
 * GhostParser
 * ---------------------------------------------------------------------------
 * Reads the header of the canonical `SGHF` file Moonshine writes for a
 * `.smsghost`. Offsets follow Moonshine's own specification
 * (include/susamune/ghost_format.h and doc/ghost_format.md, snapshot PR27,
 * 2026-10-24); see MOONSHINE-INTEGRATION.md.
 *
 * This is upload-form assistance only. It checks the header fields and the
 * three CRCs so the uploader gets fast feedback, and reads the labels used to
 * pre-fill the form. Full structural validation - the part that decides
 * whether a ghost may be offered to Moonshine - runs on the server
 * (supabase/functions/_shared/ghost_format.ts). Files this parser does not
 * recognise still upload to the archive and are stored byte-for-byte.
 */

export const GHOST_MAGIC = 'SGHF'

/** SGHF versions Moonshine's reference validator reads (V1/V2 were test-only). */
export const KNOWN_VERSIONS = [3, 4, 5, 6, 7, 8, 9]

const HEADER_SIZE = 0x100
const OFF_VERSION = 0x04 // u16
const OFF_HEADER_SIZE = 0x06 // u16
const OFF_FILE_SIZE = 0x08
const OFF_FILE_CRC = 0x0c // CRC-32 of the file with this word zeroed
const OFF_HEADER_CRC = 0x10 // CRC-32 of the header with 0x0c..0x14 zeroed
const OFF_PAYLOAD_CRC = 0x14 // CRC-32 of [0x100, fileSize)
const OFF_GAME_ID = 0x20
const OFF_AUTHOR_LEN = 0x5c
const OFF_NAME_LEN = 0x5d
const OFF_PROFILE_NAME_LEN = 0x5e
const OFF_AUTHOR = 0x60 // 24 bytes
const OFF_NAME = 0x78 // 48 bytes, e.g. "Bianco Hills 3 - 0:37.337"
const OFF_PROFILE_NAME = 0xa8 // 16 bytes, e.g. "Any percent"

export interface ParsedGhost {
  magic: string
  /** SGHF format version (not the Moonshine release number). */
  version: number
  versionLabel: string
  /** Size the file claims to be, in bytes. */
  declaredSize: number
  /** Actual byte length of what we were handed. */
  actualSize: number
  /** GameCube game id, e.g. GMSJ (Super Mario Sunshine, JP). */
  gameId: string
  /** The ghost's name field; Moonshine writes "<level> - <time>". */
  title: string | null
  /** The source profile's name, e.g. "Any percent". */
  category: string | null
  author: string | null
  payloadOffset: number
  payloadSize: number
  /** True for a version Moonshine's validator reads. */
  recognisedVersion: boolean
  crcVerified: boolean
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

/** CRC32 (IEEE) over a byte range, optionally treating a span of bytes as zero. */
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

/** Length-delimited printable ASCII, or null if the field is empty or malformed. */
function readText(bytes: Uint8Array, offset: number, capacity: number, length: number): string | null {
  if (length === 0 || length > capacity || offset + capacity > bytes.length) return null
  let out = ''
  for (let i = offset; i < offset + length; i++) {
    const c = bytes[i]
    if (c < 0x20 || c > 0x7e) return null
    out += String.fromCharCode(c)
  }
  return out.trim() || null
}

function readMagic(bytes: Uint8Array): string {
  return String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
}

export class GhostFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GhostFormatError'
  }
}

/** Parses a `.smsghost` header. Throws GhostFormatError on a non-ghost. */
export function parseGhost(buffer: ArrayBuffer): ParsedGhost {
  const bytes = new Uint8Array(buffer)
  if (bytes.length < HEADER_SIZE) {
    throw new GhostFormatError('This file is too small to be a Moonshine ghost.')
  }

  const view = new DataView(buffer)
  const magic = readMagic(bytes)
  if (magic !== GHOST_MAGIC) {
    throw new GhostFormatError('This is not a Moonshine ghost file.')
  }

  const version = view.getUint16(OFF_VERSION, false)
  const recognisedVersion = KNOWN_VERSIONS.includes(version) && view.getUint16(OFF_HEADER_SIZE, false) === HEADER_SIZE
  const declaredSize = view.getUint32(OFF_FILE_SIZE, false)
  const gameId = readText(bytes, OFF_GAME_ID, 4, 4) ?? ''

  const fileCrcOk = crc32(bytes, OFF_FILE_CRC, 4) === view.getUint32(OFF_FILE_CRC, false)
  const headerCrcOk = crc32(bytes.subarray(0, HEADER_SIZE), OFF_FILE_CRC, 8) === view.getUint32(OFF_HEADER_CRC, false)
  const payloadCrcOk = crc32(bytes.subarray(HEADER_SIZE)) === view.getUint32(OFF_PAYLOAD_CRC, false)

  return {
    magic,
    version,
    versionLabel: `V${version}`,
    declaredSize,
    actualSize: bytes.length,
    gameId,
    title: readText(bytes, OFF_NAME, 48, bytes[OFF_NAME_LEN]),
    category: readText(bytes, OFF_PROFILE_NAME, 16, bytes[OFF_PROFILE_NAME_LEN]),
    author: readText(bytes, OFF_AUTHOR, 24, bytes[OFF_AUTHOR_LEN]),
    payloadOffset: HEADER_SIZE,
    payloadSize: bytes.length - HEADER_SIZE,
    recognisedVersion,
    crcVerified: fileCrcOk && headerCrcOk && payloadCrcOk,
  }
}

export async function parseGhostFile(file: File): Promise<ParsedGhost> {
  return parseGhost(await file.arrayBuffer())
}
