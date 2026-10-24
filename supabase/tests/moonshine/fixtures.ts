/**
 * Builds synthetic canonical SGHF ghosts from the layout in Moonshine's
 * doc/ghost_format.md, so the tests never need a real runner's recording.
 * Every builder output is checked against Moonshine's own validator in
 * validator_parity.test.ts; a fixture that the reference rejects is a bug here.
 */
import { crc32 } from '../../functions/_shared/ghost_format.ts'

export interface FixtureOptions {
  version?: number
  region?: number // 0 jp, 1 us, 2 pal
  sourceProfile?: number
  runFlags?: number
  area?: number
  episode?: number
  /** Samples per segment. Two entries make a two-segment ghost with a gap. */
  segments?: number[]
  inputs?: number
  splits?: number
  cameraSamples?: number
  name?: string
  author?: string
  profileName?: string
  ghostId?: [number, number]
  rngSeed?: number
  resultQf?: number | null
}

const GAME_IDS = [0x474d534a, 0x474d5345, 0x474d5350]
const FEATURES: Record<number, number> = { 3: 0, 4: 1, 5: 3, 6: 7, 7: 15, 8: 31, 9: 63 }

function put32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value >>> 0, false)
}

function ascii(bytes: Uint8Array, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i)
}

export function buildGhost(options: FixtureOptions = {}): Uint8Array {
  const version = options.version ?? 9
  const region = options.region ?? 0
  const segmentSizes = options.segments ?? [12]
  const name = options.name ?? 'Bianco Hills 3 - 0:37.337'
  const author = options.author ?? 'tester'
  const profileName = options.profileName ?? 'Any percent'
  const inputCount = version >= 5 ? (options.inputs ?? 5) : 0
  const splitCount = version >= 5 ? (options.splits ?? 2) : 0
  const cameraCount = version >= 8 ? (options.cameraSamples ?? 3) : 0

  // Timeline: each segment's samples are 4 QF apart, with a 100 QF gap between segments.
  const segments: { first: number; count: number; start: number; end: number }[] = []
  let qf = 0
  let first = 0
  for (const count of segmentSizes) {
    const start = qf
    const end = start + (count - 1) * 4
    segments.push({ first, count, start, end })
    first += count
    qf = end + 100
  }
  const sampleCount = first
  const startQf = segments[0].start
  const endQf = segments[segments.length - 1].end

  const sampleDataSize = sampleCount * 16
  const inputStride = version >= 6 ? 24 : 16
  const teachingSize = version >= 5 ? 32 + inputCount * inputStride + splitCount * 12 : 0
  const cameraSize = version >= 8 ? 32 + cameraCount * 24 : 0
  const fileSize = 0x900 + sampleDataSize + teachingSize + cameraSize

  const bytes = new Uint8Array(fileSize)
  const view = new DataView(bytes.buffer)

  // Header ----------------------------------------------------------------
  ascii(bytes, 0, 'SGHF')
  view.setUint16(4, version)
  view.setUint16(6, 0x100)
  put32(view, 8, fileSize)
  put32(view, 24, FEATURES[version])
  put32(view, 28, options.runFlags ?? 0)
  put32(view, 32, GAME_IDS[region] ?? 0x474d534a)
  bytes[36] = 0
  bytes[37] = region
  bytes[38] = options.sourceProfile ?? 0
  bytes[39] = 2 // raw pose/QFT
  bytes[40] = version >= 4 ? 1 : 0
  bytes[41] = 16
  view.setUint16(42, 4)
  bytes[44] = options.area ?? 0x02
  bytes[45] = options.episode ?? 2
  bytes[46] = 0xff
  bytes[47] = 0
  view.setInt32(48, -1)
  const resultQf = options.resultQf === undefined ? endQf : options.resultQf
  put32(view, 52, resultQf === null ? 0xffffffff : resultQf)
  put32(view, 56, startQf)
  put32(view, 60, endQf)
  put32(view, 64, endQf - startQf)
  put32(view, 68, sampleCount)
  put32(view, 72, fileSize - 0x100)
  put32(view, 76, 0)
  put32(view, 80, 1_760_000_000)
  const [idHi, idLo] = options.ghostId ?? [0x01234567, 0x89abcdef]
  put32(view, 84, idHi)
  put32(view, 88, idLo)
  bytes[92] = author.length
  bytes[93] = name.length
  bytes[94] = profileName.length
  bytes[95] = 1 // CRC-32
  ascii(bytes, 96, author)
  ascii(bytes, 120, name)
  ascii(bytes, 168, profileName)
  view.setUint16(184, segments.length)
  view.setUint16(186, 0x20)
  put32(view, 188, 0x100)
  put32(view, 192, 0x800)
  put32(view, 196, 0x900)
  put32(view, 200, sampleDataSize)
  if (version >= 4) {
    bytes[208] = 0 // attachment count
    bytes[209] = 6 // attachment size
  }

  // Segment table ---------------------------------------------------------
  segments.forEach((segment, index) => {
    const offset = 0x100 + index * 0x20
    put32(view, offset, segment.first)
    put32(view, offset + 4, segment.count)
    put32(view, offset + 8, segment.start)
    put32(view, offset + 12, segment.end)
    view.setInt32(offset + 16, -1)
    bytes[offset + 20] = options.area ?? 0x02
    bytes[offset + 21] = options.episode ?? 2
    bytes[offset + 22] = 0xff
    bytes[offset + 23] = 0
    if (version === 9 && index === 0) {
      put32(view, offset + 24, options.rngSeed ?? 0x2468ace0)
      put32(view, offset + 28, 1)
    }
  })
  put32(view, 204, crc32(bytes.subarray(0x100, 0x900)))

  // Pose samples ----------------------------------------------------------
  let sample = 0
  for (const segment of segments) {
    for (let local = 0; local < segment.count; local++) {
      const offset = 0x900 + sample * 16
      view.setInt16(offset, 1000 + sample)
      view.setUint16(offset + 2, local === 0 ? 0 : 4)
      const x = (sample * 8) & 0xffffff
      bytes[offset + 4] = x >> 16
      bytes[offset + 5] = (x >> 8) & 0xff
      bytes[offset + 6] = x & 0xff
      const animation = version === 3 ? (12 << 15) | (100 << 3) : (12 << 15) | (100 << 7)
      bytes[offset + 13] = animation >> 16
      bytes[offset + 14] = (animation >> 8) & 0xff
      bytes[offset + 15] = animation & 0xff
      sample++
    }
  }

  // Teaching section (SGTI) ------------------------------------------------
  let cursor = 0x900 + sampleDataSize
  if (version >= 5) {
    const base = cursor
    ascii(bytes, base, 'SGTI')
    view.setUint16(base + 4, version >= 7 ? 3 : version >= 6 ? 2 : 1)
    view.setUint16(base + 6, 32)
    put32(view, base + 8, inputCount)
    put32(view, base + 12, splitCount)
    for (let i = 0; i < inputCount; i++) {
      const offset = base + 32 + i * inputStride
      put32(view, offset, startQf + i * 4)
      view.setUint16(offset + 4, 0x0100) // A button
    }
    for (let i = 0; i < splitCount; i++) {
      const offset = base + 32 + inputCount * inputStride + i * 12
      put32(view, offset, Math.min(startQf + (i + 1) * 8, endQf))
      put32(view, offset + 4, 0xc0ffee01)
      view.setUint16(offset + 8, 7)
      bytes[offset + 10] = i
    }
    put32(view, base + 20, crc32(bytes.subarray(base + 32, base + teachingSize)))
    cursor = base + teachingSize
  }

  // Camera section (SGCA) --------------------------------------------------
  if (version >= 8) {
    const base = cursor
    put32(view, base, 0x53474341)
    view.setUint16(base + 4, 1)
    view.setUint16(base + 6, 32)
    put32(view, base + 8, cameraCount)
    for (let i = 0; i < cameraCount; i++) {
      const offset = base + 32 + i * 24
      put32(view, offset, startQf + i * 4)
      view.setInt16(offset + 13, 32767) // unit quaternion (w)
      view.setUint16(offset + 21, 60 * 256) // 60 degree FOV
      bytes[offset + 23] = i === 0 ? 64 : 0 // segment 0, cut marker on the first sample
    }
    put32(view, base + 16, crc32(bytes.subarray(base + 32, base + cameraSize)))
  }

  return finalize(bytes)
}

/** Recomputes payload, header and file CRCs in the order the spec requires. */
export function finalize(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 0x100) return bytes
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  put32(view, 20, crc32(bytes.subarray(0x100)))
  const header = new Uint8Array(bytes.subarray(0, 0x100))
  header.fill(0, 12, 20)
  put32(view, 16, crc32(header))
  const whole = new Uint8Array(bytes)
  whole.fill(0, 12, 16)
  put32(view, 12, crc32(whole))
  return bytes
}

/** Recomputes the segment-table CRC (header 0xcc) before finalize(). */
export function refreshSegmentTableCrc(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length >= 0x900) put32(view, 204, crc32(bytes.subarray(0x100, 0x900)))
  return bytes
}
