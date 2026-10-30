// SPDX-License-Identifier: GPL-3.0-or-later
//
// This file is a port of scripts/validate_ghost.py from the Moonshine project
// (https://github.com/panther03/moonshine), which is licensed under the GNU
// General Public License version 3. As a derivative work, this file is
// distributed under the same licence: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. It is distributed WITHOUT ANY WARRANTY; without even the
// implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See
// <https://www.gnu.org/licenses/gpl-3.0.html>.
//
// Only this file carries the GPL; the rest of Delfino Ghosts is unaffected.

/**
 * Server-side validator for canonical Moonshine SGHF ghosts, V3 through V9.
 *
 * This is a line-for-line port of Moonshine's host validator
 * `scripts/validate_ghost.py` (snapshot "Moonshine PR27, 2026-10-24", sha256
 * 8edcddd717cb985fcd088d34fd6e39e15ea588b579a9b4c3499b81123837ed0e). The check
 * order, error classes and messages are kept identical so the two can be
 * compared byte-for-byte by `supabase/tests/moonshine/validator_parity.test.ts`.
 * Do not "improve" a rule here without the matching upstream change: the point
 * of this file is that it agrees with the game's reference validator.
 *
 * It never modifies the input. Only `validateGhost` is the upstream contract;
 * `summarizeForCatalogue` adds the service's own fields on top of it.
 */

export const VALIDATOR_ID = 'delfino-sghf-validator/1 (port of validate_ghost.py @ moonshine-pr27)'

const GHOST_MAGIC = 0x53474846 // SGHF
const GHOST_VERSION_V3 = 3
const GHOST_VERSION_V4 = 4
const GHOST_VERSION_V5 = 5
const GHOST_VERSION_V6 = 6
const GHOST_VERSION_V7 = 7
const GHOST_VERSION_V8 = 8
const GHOST_VERSION_V9 = 9
export const SUPPORTED_VERSIONS = [3, 4, 5, 6, 7, 8, 9] as const
const V6_MAX_INPUT_COUNT = 36_000
const V6_MAX_DURATION_QF = 71_928
const V6_MAX_SAMPLE_COUNT = 17_983
const GHOST_HEADER_SIZE = 0x100
const CHECKSUM_CRC32 = 1

const REGION_GAME_IDS: Record<number, number> = {
  0: 0x474d534a, // GMSJ
  1: 0x474d5345, // GMSE
  2: 0x474d5350, // GMSP
}
const REGION_NAMES: Record<number, string> = { 0: 'jp', 1: 'us', 2: 'pal' }
const PROFILE_COUNT = 4
const MAX_DURATION_QF = 107_892
const QF_MAX = 0x7fffffff
const MIN_SAMPLE_COUNT = 2
const MAX_SAMPLE_COUNT = 26_974
const SAMPLE_SIZE = 16
const MAX_POSITION_FIXED = 8_000_000
const ANIMATION_ID_MAX = 335
const ANIMATION_PHASE_MAX = 4095
const ANIMATION_RESERVED_MASK = 0x7
const V3_SEGMENT_TABLE_OFFSET = 0x100
const V3_SEGMENT_TABLE_SIZE = 0x800
const V3_SAMPLE_DATA_OFFSET = 0x900
const V3_MAX_GHOST_FILE_SIZE = 0x69ee0
const V4_MAX_SEGMENTS = 64
const V4_SEGMENT_SIZE = 0x20
const V4_MAX_GHOST_FILE_SIZE = V3_MAX_GHOST_FILE_SIZE
const V4_ANIMATION_PHASE_SHIFT = 7
const V4_ANIMATION_PHASE_MAX = 255
const V4_YOSHI_SHIFT = 4
const V4_YOSHI_MASK = 0x7
const V4_YOSHI_UNKNOWN = 5
const V4_HELD_INDEX_MASK = 0xf
const V4_HELD_UNKNOWN = 0xf
const V4_ATTACHMENT_DESCRIPTOR_COUNT = 7
const V4_ATTACHMENT_DESCRIPTOR_SIZE = 6
const V4_ATTACHMENT_HELD_OVERFLOW = 0x0001
const V4_ATTACHMENT_FLAGS = V4_ATTACHMENT_HELD_OVERFLOW
const V5_MAX_INPUT_COUNT = 54_000
// The Python validator allows 8 splits; doc/ghost_format.md says 0-6 for V5.
// Kept at the validator's value so the two agree; see MOONSHINE-INTEGRATION.md.
const V5_MAX_SPLIT_COUNT = 8
const V5_MAX_GHOST_FILE_SIZE = V4_MAX_GHOST_FILE_SIZE + 32 + 54_000 * 16 + V5_MAX_SPLIT_COUNT * 12
export const VALIDATOR_MAX_FILE_SIZE = V5_MAX_GHOST_FILE_SIZE
const RESULT_QF_NONE = 0xffffffff
const RECORDING_POSE_QF = 2
const CODEC_RAW = 0
const CODEC_POSE_ATTACHMENTS = 1
const SUPPORTED_REQUIRED_FEATURES_V3 = 0
const SUPPORTED_REQUIRED_FEATURES_V4 = 0x00000001
const RUN_ASSISTED = 0x00000001
const RUN_TAS = 0x00000020
const ROUTE_FLAGS_V1 = 0x03
const ROUTE_INTERNAL_SCENE = 0x01
const ROUTE_PARENT_START = 0x02
const ROUTE_PARENT_NONE = 0xff
const ROUTE_VARIANT_NONE = -1
const ROUTE_AREA_MAX = 0x3c
const ROUTE_EPISODE_MAX = 9
const ROUTE_VARIANT_MAX = 255
const PORTABLE_ROUTE_PARENTS: Record<number, number> = {
  0x00: 0xff, 0x01: 0xff, 0x02: 0xff, 0x03: 0xff,
  0x04: 0xff, 0x05: 0xff, 0x06: 0xff, 0x07: 0x06,
  0x08: 0xff, 0x09: 0xff, 0x0d: 0x05, 0x0e: 0x06,
  0x10: 0x09, 0x14: 0xff, 0x15: 0xff, 0x16: 0xff,
  0x17: 0xff, 0x18: 0xff, 0x1d: 0xff, 0x1e: 0x03,
  0x1f: 0x09, 0x20: 0x04, 0x21: 0x04, 0x28: 0x06,
  0x29: 0x05, 0x2a: 0x08, 0x2c: 0x09, 0x2e: 0x02,
  0x2f: 0x02, 0x30: 0x03, 0x32: 0x05, 0x33: 0x06,
  0x34: 0xff, 0x37: 0x02, 0x38: 0x06, 0x39: 0x09,
  0x3a: 0x05, 0x3b: 0x03, 0x3c: 0xff,
}

const AUTHOR_SIZE = 24
const NAME_SIZE = 48
const PROFILE_NAME_SIZE = 16

/** Required-feature bits, named after the SUSAMUNE_GHOST_REQUIRED_* macros. */
export const FEATURE_BITS: [number, string][] = [
  [0x01, 'extended_codec'],
  [0x02, 'teaching'],
  [0x04, 'fludd'],
  [0x08, 'visual_v7'],
  [0x10, 'camera'],
  [0x20, 'initial_rng'],
]

/** Advisory run flags, named after the SUSAMUNE_GHOST_RUN_* macros. */
export const RUN_FLAG_BITS: [number, string][] = [
  [0x01, 'assisted'],
  [0x02, 'savestate_used'],
  [0x04, 'fast_forward_used'],
  [0x08, 'incomplete'],
  [0x10, 'custom_route'],
  [0x20, 'tas'],
]
const KNOWN_RUN_FLAGS = 0x3f

// --- errors ------------------------------------------------------------------

/** The bytes are corrupt or violate a bounded format invariant. */
export class FormatError extends Error {
  kind: 'invalid' | 'unsupported_version' | 'unsupported_feature' = 'invalid'
  constructor(message: string) {
    super(message)
    this.name = 'FormatError'
  }
}

/** The magic is known, but this reader must not interpret the version. */
export class UnsupportedVersion extends FormatError {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedVersion'
    this.kind = 'unsupported_version'
  }
}

/** The version is known, but required decoding semantics are unknown. */
export class UnsupportedFeature extends FormatError {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedFeature'
    this.kind = 'unsupported_feature'
  }
}

function require(condition: boolean, message: string): void {
  if (!condition) throw new FormatError(message)
}

// --- byte helpers ------------------------------------------------------------

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

/** Reflected CRC-32/ISO-HDLC, i.e. zlib's crc32. */
export function crc32(data: Uint8Array): number {
  const table = crcTable()
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xff]
  return (crc ^ 0xffffffff) >>> 0
}

function crc32Zeroed(data: Uint8Array, ...ranges: [number, number][]): number {
  const work = new Uint8Array(data)
  for (const [start, end] of ranges) {
    require(0 <= start && start <= end && end <= work.length, 'checksum field outside file')
    work.fill(0, start, end)
  }
  return crc32(work)
}

/** Python slice semantics: clamps, never throws. */
function slice(data: Uint8Array, start: number, end?: number): Uint8Array {
  const length = data.length
  const s = Math.max(0, Math.min(start, length))
  const e = end === undefined ? length : Math.max(s, Math.min(end, length))
  return data.subarray(s, e)
}

function u8(data: Uint8Array, offset: number): number {
  return data[offset]
}
function u16(data: Uint8Array, offset: number): number {
  return (data[offset] << 8) | data[offset + 1]
}
function s16(data: Uint8Array, offset: number): number {
  const value = u16(data, offset)
  return value & 0x8000 ? value - 0x10000 : value
}
function u32(data: Uint8Array, offset: number): number {
  return ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>> 0
}
function s32(data: Uint8Array, offset: number): number {
  return u32(data, offset) | 0
}
function u24(data: Uint8Array, offset: number): number {
  return (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2]
}
function signedBe24(data: Uint8Array, offset: number): number {
  require(offset + 3 <= data.length, 'truncated signed BE24')
  const value = u24(data, offset)
  return value & 0x800000 ? value - 0x1000000 : value
}
function anyNonzero(data: Uint8Array): boolean {
  for (let i = 0; i < data.length; i++) if (data[i] !== 0) return true
  return false
}
function hex(value: number, width: number): string {
  return value.toString(16).padStart(width, '0')
}

// --- field validators --------------------------------------------------------

function text(
  raw: Uint8Array,
  offset: number,
  capacity: number,
  length: number,
  label: string,
  required = false,
): string {
  require(length <= capacity, `${label} length exceeds ${capacity}`)
  const field = slice(raw, offset, offset + capacity)
  require(field.length === capacity, `truncated ${label}`)
  require(!anyNonzero(field.subarray(length)), `nonzero bytes after ${label}`)
  if (required) require(length !== 0, `empty ${label}`)
  const valueBytes = field.subarray(0, length)
  let printable = true
  for (let i = 0; i < valueBytes.length; i++) {
    if (valueBytes[i] < 0x20 || valueBytes[i] > 0x7e) printable = false
  }
  require(printable, `${label} is not printable ASCII`)
  const value = String.fromCharCode(...valueBytes)
  require(!value.includes('/') && !value.includes('\\'), `unsafe character in ${label}`)
  return value
}

function gameRegion(gameId: number, region: number, revision = 0): string {
  require(region in REGION_GAME_IDS, `invalid region ${region}`)
  require(gameId === REGION_GAME_IDS[region], 'game id does not match region')
  require(revision === 0, `unsupported disc revision ${revision}`)
  return REGION_NAMES[region]
}

export interface Route {
  area: number
  episode: number
  parent_area: number
  flags: number
  variant: number
}

function validateRoute(
  area: number,
  episode: number,
  parentArea: number,
  flags: number,
  variant: number,
  label: string,
): void {
  require(area <= ROUTE_AREA_MAX, `${label} area outside V1 bounds`)
  require(episode <= ROUTE_EPISODE_MAX, `${label} episode outside V1 bounds`)
  require(parentArea === ROUTE_PARENT_NONE || parentArea <= ROUTE_AREA_MAX, `${label} parent area outside V1 bounds`)
  require((flags & ~ROUTE_FLAGS_V1) === 0, `${label} has unknown V1 flags`)
  const hasParent = parentArea !== ROUTE_PARENT_NONE
  require((flags & ROUTE_PARENT_START) === 0 || hasParent, `${label} parent-start flag has no parent area`)
  require(Boolean(flags & ROUTE_INTERNAL_SCENE) === hasParent, `${label} internal-scene flag disagrees with parent area`)
  require(ROUTE_VARIANT_NONE <= variant && variant <= ROUTE_VARIANT_MAX, `${label} variant outside V1 bounds`)
}

function validatePortableRoute(route: Route, label: string): void {
  const area = route.area
  require(area in PORTABLE_ROUTE_PARENTS, `${label} area has no cross-region meaning`)
  const expectedParent = PORTABLE_ROUTE_PARENTS[area]
  require(route.parent_area === expectedParent, `${label} parent differs across regions`)
  if (expectedParent === ROUTE_PARENT_NONE) {
    require(route.flags === 0, `${label} standalone route has internal flags`)
  } else {
    require(Boolean(route.flags & ROUTE_INTERNAL_SCENE), `${label} child route lacks internal flag`)
    require(!(route.flags & ~(ROUTE_INTERNAL_SCENE | ROUTE_PARENT_START)), `${label} child route has unknown flags`)
  }
}

function sameRoute(a: Route, b: Route): boolean {
  return (
    a.area === b.area &&
    a.episode === b.episode &&
    a.parent_area === b.parent_area &&
    a.flags === b.flags &&
    a.variant === b.variant
  )
}

// --- sections ----------------------------------------------------------------

export interface Segment {
  first_sample: number
  sample_count: number
  start_qf: number
  end_qf: number
  route: Route
}

export interface Split {
  qf: number
  schema: number
  route: number
  endpoint: number
}

export interface Teaching {
  input_count: number
  splits: Split[]
  input_truncated: boolean
}

export interface Camera {
  sample_count: number
  truncated: boolean
}

function validateCamera(data: Uint8Array, segments: Segment[]): Camera {
  require(data.length >= 32, 'truncated camera header')
  const magic = u32(data, 0)
  const version = u16(data, 4)
  const size = u16(data, 6)
  const count = u32(data, 8)
  const flags = u32(data, 12)
  const checksum = u32(data, 16)
  const r0 = u32(data, 20)
  const r1 = u32(data, 24)
  const r2 = u32(data, 28)
  require(magic === 0x53474341 && version === 1 && size === 32, 'invalid camera header')
  require(count <= 5312 && data.length === 32 + count * 24, 'camera count/size mismatch')
  require(!(flags & ~1) && !(r0 || r1 || r2), 'unknown camera flags/reserved')
  require(crc32(data.subarray(32)) === checksum, 'camera checksum mismatch')
  let previousQf: number | null = null
  let previousSegment: number | null = null
  for (let index = 0; index < count; index++) {
    const sample = data.subarray(32 + index * 24, 56 + index * 24)
    const qf = u32(sample, 0)
    const quaternion = [s16(sample, 13), s16(sample, 15), s16(sample, 17), s16(sample, 19)]
    const fov = u16(sample, 21)
    const segment = sample[23] & 63
    require(!(sample[23] & 128) && segment < segments.length, 'invalid camera segment')
    require(segments[segment].start_qf <= qf && qf <= segments[segment].end_qf, 'camera timestamp outside segment')
    require(256 <= fov && fov <= 179 * 256, 'invalid camera field of view')
    const norm = quaternion.reduce((sum, v) => sum + v * v, 0)
    require(1073479689 <= norm && norm <= 1073879689, 'invalid camera quaternion')
    if (previousQf !== null && previousSegment !== null) {
      require(
        segment >= previousSegment && qf >= previousQf && (segment !== previousSegment || qf !== previousQf),
        'unordered camera samples',
      )
    }
    require(!(previousSegment === null || segment !== previousSegment) || Boolean(sample[23] & 64), 'missing camera cut marker')
    previousQf = qf
    previousSegment = segment
  }
  return { sample_count: count, truncated: Boolean(flags & 1) }
}

function validateTeaching(data: Uint8Array, startQf: number, endQf: number, ghostVersion = 5): Teaching {
  require(data.length >= 32, 'truncated teaching header')
  const magic = u32(data, 0)
  const version = u16(data, 4)
  const headerSize = u16(data, 6)
  const inputs = u32(data, 8)
  const splits = u32(data, 12)
  const flags = u32(data, 16)
  const checksum = u32(data, 20)
  const r0 = u32(data, 24)
  const r1 = u32(data, 28)
  const fludd = ghostVersion >= 6
  const stride = fludd ? 24 : 16
  require(
    magic === 0x53475449 && version === (ghostVersion >= 7 ? 3 : fludd ? 2 : 1) && headerSize === 32,
    'invalid teaching header',
  )
  require(inputs <= (fludd ? V6_MAX_INPUT_COUNT : V5_MAX_INPUT_COUNT) && splits <= V5_MAX_SPLIT_COUNT, 'teaching count exceeds bound')
  require(!(flags & ~1) && r0 === 0 && r1 === 0, 'unknown teaching flags/reserved')
  require(data.length === 32 + inputs * stride + splits * 12, 'teaching size mismatch')
  require(crc32(data.subarray(32)) === checksum, 'teaching checksum mismatch')
  let previous: number | null = null
  for (let index = 0; index < inputs; index++) {
    const offset = 32 + index * stride
    const qf = u32(data, offset)
    const buttons = u16(data, offset + 4)
    require(startQf <= qf && qf <= endQf && (previous === null || qf > previous), 'input timestamps outside timeline or unordered')
    require(!(buttons & ~0x1f7f) && data[offset + 15] === 0, 'input reserved button/flag bits')
    if (fludd) {
      const visual = data.subarray(offset + 16, offset + 24)
      let mode = visual[0]
      const pitch = ((visual[5] & 15) << 8) | visual[6]
      if (ghostVersion >= 7 && mode & 0x80) {
        require(
          !(mode & ~0xb0) &&
            visual[1] < 26 &&
            (!(mode & 0x20) || Boolean(mode & 0x10)) &&
            (!visual[4] || visual[1] === 15) &&
            (visual[5] === 0 || visual[5] === 3 || visual[5] === 4) &&
            (Boolean(visual[5]) || !visual[6]),
          'invalid Yoshi observation',
        )
      } else {
        if (ghostVersion >= 7 && mode & 0x20) {
          require(Boolean(mode & 16) && !(mode & 7), 'invalid burst observation')
          mode &= ~0x20
        }
        require(
          !mode
            ? !anyNonzero(visual)
            : !(mode & ~0x1f) &&
                Boolean(mode & 8) &&
                (mode & 7) <= 5 &&
                (Boolean(mode & 16) || visual[7] === 0) &&
                (pitch <= 1024 || pitch >= 3072),
          'invalid FLUDD observation',
        )
      }
    }
    previous = qf
  }
  const result: Split[] = []
  previous = null
  let identity: [number, number] | null = null
  for (let index = 0; index < splits; index++) {
    const offset = 32 + inputs * stride + index * 12
    const qf = u32(data, offset)
    const schema = u32(data, offset + 4)
    const route = u16(data, offset + 8)
    const endpoint = u8(data, offset + 10)
    const reserved = u8(data, offset + 11)
    require(startQf <= qf && qf <= endQf && (previous === null || qf >= previous), 'split timestamps outside timeline or unordered')
    require(schema !== 0 && route !== 0xffff && endpoint === index && reserved === 0, 'invalid split identity/ordinal')
    require(identity === null || (identity[0] === schema && identity[1] === route), 'mixed split schemas/routes')
    result.push({ qf, schema, route, endpoint })
    identity = [schema, route]
    previous = qf
  }
  return { input_count: inputs, splits: result, input_truncated: Boolean(flags & 1) }
}

// --- the canonical ghost -----------------------------------------------------

export interface ValidatedGhost {
  kind: 'ghost'
  teaching: Teaching
  camera: Camera | null
  initial_rng: { seed: number; provenance: 'first_recorded_pose' } | null
  version: number
  file_size: number
  file_checksum: number
  payload_checksum: number
  required_features: number
  run_flags: number
  game_id: string
  region: string
  source_profile: number
  route: Route
  result_qf: number | null
  start_qf: number
  end_qf: number
  duration_qf: number
  sample_count: number
  segment_count: number
  segments: Segment[]
  attachment_flags: number
  attachment_descriptors: { object_id: string; name_key: string }[]
  /** u64; kept as a decimal string because it can exceed 2^53. */
  created_unix: string
  ghost_id: string
  portable_filename: string
  author: string
  name: string
  profile_name: string
}

/** Mirrors validate_ghost.py `validate_ghost`. Throws FormatError or a subclass. */
export function validateGhost(data: Uint8Array): ValidatedGhost {
  require(data.length >= 8, 'truncated ghost prefix')
  require(u32(data, 0) === GHOST_MAGIC, 'bad ghost magic')
  let version = u16(data, 4)
  if (!(SUPPORTED_VERSIONS as readonly number[]).includes(version)) {
    throw new UnsupportedVersion(`unsupported ghost version ${version}; reader supports 3 through 9`)
  }
  require(data.length >= GHOST_HEADER_SIZE, 'truncated ghost header')
  version = u16(data, 4)
  const headerSize = u16(data, 6)
  const fileSize = u32(data, 8)
  const fileChecksum = u32(data, 12)
  const headerChecksum = u32(data, 16)
  const payloadChecksum = u32(data, 20)
  const requiredFeatures = u32(data, 24)
  const runFlags = u32(data, 28)
  const gameId = u32(data, 32)
  const discRevision = u8(data, 36)
  const region = u8(data, 37)
  const sourceProfile = u8(data, 38)
  const recordingMode = u8(data, 39)
  const sampleCodec = u8(data, 40)
  const sampleStride = u8(data, 41)
  const sampleIntervalQf = u16(data, 42)
  const routeArea = u8(data, 44)
  const routeEpisode = u8(data, 45)
  const routeParentArea = u8(data, 46)
  const routeFlags = u8(data, 47)
  const routeVariant = s32(data, 48)
  const resultQf = u32(data, 52)
  const startQf = u32(data, 56)
  const endQf = u32(data, 60)
  const durationQf = u32(data, 64)
  const sampleCount = u32(data, 68)
  const payloadSize = u32(data, 72)
  const createdHi = u32(data, 76)
  const createdLo = u32(data, 80)
  const ghostIdHi = u32(data, 84)
  const ghostIdLo = u32(data, 88)
  const authorLength = u8(data, 92)
  const nameLength = u8(data, 93)
  const profileNameLength = u8(data, 94)
  const checksumKind = u8(data, 95)

  require(headerSize === GHOST_HEADER_SIZE, 'invalid ghost header size')
  require(fileSize === data.length, 'ghost file size does not match bytes')
  require(fileSize <= (version >= 5 ? V5_MAX_GHOST_FILE_SIZE : V4_MAX_GHOST_FILE_SIZE), 'ghost exceeds canonical file limit')
  if (checksumKind !== CHECKSUM_CRC32) {
    throw new UnsupportedFeature(`unsupported checksum kind ${checksumKind}`)
  }

  const expectedHeaderCrc = crc32Zeroed(data.subarray(0, headerSize), [12, 20])
  require(headerChecksum === expectedHeaderCrc, 'ghost header checksum mismatch')
  const expectedFileCrc = crc32Zeroed(data, [12, 16])
  require(fileChecksum === expectedFileCrc, 'ghost file checksum mismatch')

  const supportedFeatures =
    version === GHOST_VERSION_V9 ? 63
    : version === GHOST_VERSION_V8 ? 31
    : version === GHOST_VERSION_V7 ? 15
    : version === GHOST_VERSION_V6 ? 7
    : version === GHOST_VERSION_V5 ? 3
    : version === GHOST_VERSION_V4 ? SUPPORTED_REQUIRED_FEATURES_V4
    : SUPPORTED_REQUIRED_FEATURES_V3
  if ((requiredFeatures & ~supportedFeatures) >>> 0) {
    throw new UnsupportedFeature(`unsupported required features 0x${hex(requiredFeatures, 8)}`)
  }
  require(version < GHOST_VERSION_V4 || requiredFeatures === supportedFeatures, 'V4 attachment codec lacks its required feature')
  require(recordingMode === RECORDING_POSE_QF, 'unsupported recording mode')
  const expectedCodec = version >= GHOST_VERSION_V4 ? CODEC_POSE_ATTACHMENTS : CODEC_RAW
  require(sampleCodec === expectedCodec, 'unsupported sample codec')
  require(sampleStride === SAMPLE_SIZE, 'invalid sample stride')
  require(sampleIntervalQf === 4, 'invalid sample interval')
  require(!(runFlags & RUN_TAS) || Boolean(runFlags & RUN_ASSISTED), 'TAS ghost must be marked assisted')
  require(sourceProfile < PROFILE_COUNT || sourceProfile === 5, 'invalid source profile')
  const regionName = gameRegion(gameId, region, discRevision)
  validateRoute(routeArea, routeEpisode, routeParentArea, routeFlags, routeVariant, 'route')

  require(
    MIN_SAMPLE_COUNT <= sampleCount && sampleCount <= (version >= 6 ? V6_MAX_SAMPLE_COUNT : MAX_SAMPLE_COUNT),
    'sample count outside canonical bounds',
  )
  require(0 < durationQf && durationQf <= (version >= 6 ? V6_MAX_DURATION_QF : MAX_DURATION_QF), 'ghost duration outside its version limit')
  require(startQf <= QF_MAX && endQf <= QF_MAX, 'ghost QFT boundary exceeds signed runtime range')
  require(endQf >= startQf, 'ghost QFT boundaries regress')
  require(durationQf === endQf - startQf, 'duration does not match QFT boundaries')
  const author = text(data, 96, AUTHOR_SIZE, authorLength, 'author')
  const name = text(data, 120, NAME_SIZE, nameLength, 'name', true)
  const profileName = text(data, 168, PROFILE_NAME_SIZE, profileNameLength, 'profile name')
  if (resultQf !== RESULT_QF_NONE) {
    require(startQf <= resultQf && resultQf <= endQf, 'QFT result is outside recording boundaries')
  }

  const payload = slice(data, headerSize, fileSize)
  require(payloadChecksum === crc32(payload), 'ghost payload checksum mismatch')
  const segments: Segment[] = []

  const attachmentDescriptors: { object_id: string; name_key: string }[] = []
  let attachmentFlags = 0
  const segmentCount = u16(data, 184)
  const segmentSize = u16(data, 186)
  const segmentTableOffset = u32(data, 188)
  const segmentTableSize = u32(data, 192)
  const sampleDataOffset = u32(data, 196)
  const sampleDataSize = u32(data, 200)
  const segmentTableChecksum = u32(data, 204)
  if (version === GHOST_VERSION_V3) {
    require(!anyNonzero(data.subarray(208, 256)), 'nonzero V3 extension reserved bytes')
  } else {
    const attachmentCount = u8(data, 208)
    const attachmentSize = u8(data, 209)
    attachmentFlags = u16(data, 210)
    const attachmentReserved = u16(data, 212)
    require(attachmentCount <= V4_ATTACHMENT_DESCRIPTOR_COUNT, 'V4 attachment descriptor count outside bounds')
    require(attachmentSize === V4_ATTACHMENT_DESCRIPTOR_SIZE, 'invalid V4 attachment descriptor size')
    require(!(attachmentFlags & ~V4_ATTACHMENT_FLAGS), 'unknown V4 attachment flags')
    require(attachmentReserved === 0, 'nonzero V4 attachment reserved field')
    const descriptors: [number, number][] = []
    for (let index = 0; index < V4_ATTACHMENT_DESCRIPTOR_COUNT; index++) {
      descriptors.push([u32(data, 214 + index * 6), u16(data, 218 + index * 6)])
    }
    for (let index = 0; index < descriptors.length; index++) {
      const [objectId, nameKey] = descriptors[index]
      if (index < attachmentCount) {
        require(objectId !== 0 || nameKey !== 0, `V4 attachment descriptor ${index} is empty`)
        require(
          !descriptors.slice(0, index).some(([o, n]) => o === objectId && n === nameKey),
          `V4 attachment descriptor ${index} is duplicated`,
        )
        attachmentDescriptors.push({ object_id: hex(objectId, 8), name_key: hex(nameKey, 4) })
      } else {
        require(objectId === 0 && nameKey === 0, 'nonzero unused V4 attachment descriptor')
      }
    }
  }

  const label = `V${version}`
  require(1 <= segmentCount && segmentCount <= V4_MAX_SEGMENTS, `${label} segment count outside bounds`)
  require(segmentSize === V4_SEGMENT_SIZE, `invalid ${label} segment descriptor size`)
  require(
    segmentTableOffset === V3_SEGMENT_TABLE_OFFSET &&
      segmentTableSize === V3_SEGMENT_TABLE_SIZE &&
      sampleDataOffset === V3_SAMPLE_DATA_OFFSET,
    `invalid ${label} payload offsets`,
  )
  require(sampleDataSize === sampleCount * sampleStride, `${label} sample-data size does not match sample count`)
  let teaching: Teaching = { input_count: 0, splits: [], input_truncated: false }
  require(payloadSize === fileSize - headerSize, `${label} payload size disagrees with file`)
  const poseEnd = sampleDataOffset + sampleDataSize
  let teachingEnd = fileSize
  if (version >= GHOST_VERSION_V5) {
    if (version >= GHOST_VERSION_V8) {
      require(fileSize - poseEnd >= 32, 'truncated V8 teaching header')
      const inputs = u32(data, poseEnd + 8)
      const splits = u32(data, poseEnd + 12)
      require(inputs <= V6_MAX_INPUT_COUNT && splits <= V5_MAX_SPLIT_COUNT, 'V8 teaching count exceeds bound')
      teachingEnd = poseEnd + 32 + inputs * 24 + splits * 12
      require(teachingEnd <= fileSize, 'truncated V8 teaching data')
    }
    teaching = validateTeaching(slice(data, poseEnd, teachingEnd), startQf, endQf, version)
  } else {
    require(fileSize === poseEnd, `${label} ghost contains trailing or missing bytes`)
  }

  const table = slice(data, segmentTableOffset, sampleDataOffset)
  require(table.length === V3_SEGMENT_TABLE_SIZE, `truncated ${label} segment table`)
  require(segmentTableChecksum === crc32(table), `${label} segment table checksum mismatch`)
  require(!anyNonzero(table.subarray(segmentCount * segmentSize)), `nonzero unused ${label} segment descriptors`)
  const sampleData = slice(data, sampleDataOffset, poseEnd)

  let expectedSample = 0
  let previousEnd: number | null = null
  let initialRng: { seed: number; provenance: 'first_recorded_pose' } | null = null
  for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex++) {
    const offset = segmentIndex * segmentSize
    const firstSample = u32(table, offset)
    const segmentSamples = u32(table, offset + 4)
    const segmentStart = u32(table, offset + 8)
    const segmentEnd = u32(table, offset + 12)
    const segmentVariant = s32(table, offset + 16)
    const segmentArea = u8(table, offset + 20)
    const segmentEpisode = u8(table, offset + 21)
    const segmentParent = u8(table, offset + 22)
    const segmentFlags = u8(table, offset + 23)
    const reserved0 = u32(table, offset + 24)
    const reserved1 = u32(table, offset + 28)
    require(firstSample === expectedSample, `segment ${segmentIndex} sample range is not contiguous`)
    require(segmentSamples >= 1 && expectedSample + segmentSamples <= sampleCount, `segment ${segmentIndex} sample count is invalid`)
    require(
      segmentStart <= QF_MAX && segmentEnd <= QF_MAX && segmentEnd >= segmentStart,
      `segment ${segmentIndex} QFT range is invalid`,
    )
    if (previousEnd !== null) {
      require(segmentStart >= previousEnd, `segment ${segmentIndex} overlaps prior QFT range`)
    }
    validateRoute(segmentArea, segmentEpisode, segmentParent, segmentFlags, segmentVariant, `segment ${segmentIndex} route`)
    if (version === GHOST_VERSION_V9 && segmentIndex === 0) {
      require(reserved1 === 1, 'invalid initial RNG provenance')
      initialRng = { seed: reserved0, provenance: 'first_recorded_pose' }
    } else {
      require(reserved0 === 0 && reserved1 === 0, `segment ${segmentIndex} reserved fields are nonzero`)
    }
    segments.push({
      first_sample: firstSample,
      sample_count: segmentSamples,
      start_qf: segmentStart,
      end_qf: segmentEnd,
      route: {
        area: segmentArea,
        episode: segmentEpisode,
        parent_area: segmentParent,
        flags: segmentFlags,
        variant: segmentVariant,
      },
    })
    expectedSample += segmentSamples
    previousEnd = segmentEnd
  }

  require(expectedSample === sampleCount, `${label} segments do not cover every sample`)
  require(
    segments[0].start_qf === startQf && segments[segments.length - 1].end_qf === endQf,
    `${label} segments do not span header QFT boundaries`,
  )
  const headerRoute: Route = {
    area: routeArea,
    episode: routeEpisode,
    parent_area: routeParentArea,
    flags: routeFlags,
    variant: routeVariant,
  }
  require(sameRoute(segments[0].route, headerRoute), `${label} first segment route differs from header`)
  if (resultQf !== RESULT_QF_NONE) {
    const last = segments[segments.length - 1]
    require(last.start_qf <= resultQf && resultQf <= last.end_qf, `QFT result is outside final ${label} segment`)
  }

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    const segment = segments[segmentIndex]
    let elapsed = 0
    const first = segment.first_sample
    const count = segment.sample_count
    for (let localIndex = 0; localIndex < count; localIndex++) {
      const index = first + localIndex
      const offset = index * SAMPLE_SIZE
      require(0 <= offset && offset + SAMPLE_SIZE <= sampleData.length, 'truncated pose sample')
      const deltaQf = u16(sampleData, offset + 2)
      const x = signedBe24(sampleData, offset + 4)
      const y = signedBe24(sampleData, offset + 7)
      const z = signedBe24(sampleData, offset + 10)
      const pose = u24(sampleData, offset + 13)
      const animationId = pose >> 15
      if (version === GHOST_VERSION_V3) {
        const reserved = pose & ANIMATION_RESERVED_MASK
        void ((pose >> 3) & ANIMATION_PHASE_MAX)
        require(reserved === 0, `sample ${index} animation reserved bits are nonzero`)
      } else {
        void ((pose >> V4_ANIMATION_PHASE_SHIFT) & V4_ANIMATION_PHASE_MAX)
        const yoshi = (pose >> V4_YOSHI_SHIFT) & V4_YOSHI_MASK
        const held = pose & V4_HELD_INDEX_MASK
        require(yoshi <= V4_YOSHI_UNKNOWN, `sample ${index} Yoshi state is invalid`)
        require(
          held === 0 ||
            held <= attachmentDescriptors.length ||
            (held === V4_HELD_UNKNOWN && Boolean(attachmentFlags & V4_ATTACHMENT_HELD_OVERFLOW)),
          `sample ${index} held descriptor index is invalid`,
        )
      }
      require(
        Math.abs(x) <= MAX_POSITION_FIXED && Math.abs(y) <= MAX_POSITION_FIXED && Math.abs(z) <= MAX_POSITION_FIXED,
        `sample ${index} position outside canonical bounds`,
      )
      require(animationId <= ANIMATION_ID_MAX, `sample ${index} animation id outside bounds`)
      if (localIndex === 0) {
        require(deltaQf === 0, `segment ${segmentIndex} first delta is nonzero`)
      } else {
        const shortTerminal = localIndex + 1 === count && 0 < deltaQf && deltaQf < sampleIntervalQf
        require(deltaQf >= sampleIntervalQf || shortTerminal, `sample ${index} has an invalid short delta`)
        elapsed += deltaQf
      }
      require(elapsed <= segment.end_qf - segment.start_qf, `segment ${segmentIndex} sample timeline overruns`)
    }
    require(elapsed === segment.end_qf - segment.start_qf, `segment ${segmentIndex} duration differs from samples`)
  }

  require(ghostIdHi !== 0 || ghostIdLo !== 0, 'zero ghost id')
  const ghostId = hex(ghostIdHi, 8) + hex(ghostIdLo, 8)
  const createdUnix = ((BigInt(createdHi) << 32n) | BigInt(createdLo)).toString()
  const camera = version >= GHOST_VERSION_V8 ? validateCamera(slice(data, teachingEnd), segments) : null
  return {
    kind: 'ghost',
    teaching,
    camera,
    initial_rng: version === GHOST_VERSION_V9 ? initialRng : null,
    version,
    file_size: fileSize,
    file_checksum: fileChecksum,
    payload_checksum: payloadChecksum,
    required_features: requiredFeatures,
    run_flags: runFlags,
    game_id: hex(gameId, 8),
    region: regionName,
    source_profile: sourceProfile,
    route: headerRoute,
    result_qf: resultQf === RESULT_QF_NONE ? null : resultQf,
    start_qf: startQf,
    end_qf: endQf,
    duration_qf: durationQf,
    sample_count: sampleCount,
    segment_count: segments.length,
    segments,
    attachment_flags: attachmentFlags,
    attachment_descriptors: attachmentDescriptors,
    created_unix: createdUnix,
    ghost_id: ghostId,
    portable_filename: `g_${ghostId}.smsghost`,
    author,
    name,
    profile_name: profileName,
  }
}

/** Mirrors `validate_imported_ghost`: true when every segment route is portable. */
export function isPortableAcrossRegions(ghost: ValidatedGhost): boolean {
  try {
    ghost.segments.forEach((segment, index) => validatePortableRoute(segment.route, `segment ${index} route`))
    return true
  } catch (err) {
    if (err instanceof FormatError) return false
    throw err
  }
}

// --- service catalogue fields ------------------------------------------------

/**
 * The service's own size ceiling for files it accepts from and advertises to
 * Moonshine: 100 MiB, the same value as the website's limit (MAX_GHOST_BYTES
 * in ghost_paths.ts and src/types/index.ts, and the ghosts_file_size_range
 * CHECK from 0015), so the website and the API share one limit.
 *
 * This is not a format rule. validateGhost() above still enforces Moonshine's
 * own canonical file limit (V5_MAX_GHOST_FILE_SIZE, 1,298,016 bytes under the
 * PR27 spec), so today no file over that passes as `compatible`; anything
 * larger is `invalid` rather than `too_large`. Raise the format limit only by
 * porting an upstream validator change.
 */
export const MOONSHINE_MAX_FILE_BYTES = 104_857_600

export type CatalogueStatus = 'compatible' | 'invalid' | 'unsupported' | 'too_large'

export interface ValidationOutcome {
  status: CatalogueStatus
  /** Validator message, or null when compatible. */
  detail: string | null
  /** Machine-readable reason. */
  code: 'ok' | 'invalid_ghost' | 'unsupported_version' | 'unsupported_feature' | 'too_large'
  ghost: ValidatedGhost | null
}

/** Runs the reference rules plus the service's size ceiling. Never throws on bad bytes. */
export function classifyGhost(data: Uint8Array): ValidationOutcome {
  if (data.length > MOONSHINE_MAX_FILE_BYTES) {
    return {
      status: 'too_large',
      code: 'too_large',
      detail: `file is ${data.length} bytes; this service accepts at most ${MOONSHINE_MAX_FILE_BYTES}`,
      ghost: null,
    }
  }
  try {
    const ghost = validateGhost(data)
    return { status: 'compatible', code: 'ok', detail: null, ghost }
  } catch (err) {
    if (!(err instanceof FormatError)) throw err
    if (err.kind === 'invalid') return { status: 'invalid', code: 'invalid_ghost', detail: err.message, ghost: null }
    return { status: 'unsupported', code: err.kind, detail: err.message, ghost: null }
  }
}

export function featureNames(bits: number): string[] {
  return FEATURE_BITS.filter(([bit]) => bits & bit).map(([, name]) => name)
}

/** Stable, display-free route identity: area.episode.parent.flags.variant (hex area/parent/flags). */
export function routeKey(route: Route): string {
  return `${hex(route.area, 2)}.${route.episode}.${hex(route.parent_area, 2)}.${hex(route.flags, 2)}.${route.variant}`
}

export function gameIdAscii(hexId: string): string {
  let out = ''
  for (let i = 0; i < 8; i += 2) out += String.fromCharCode(parseInt(hexId.slice(i, i + 2), 16))
  return out
}

/**
 * Columns written to public.ghost_moonshine_index for a compatible file. Kept
 * flat so SQL can filter on them; the API reshapes them into nested JSON.
 */
export function indexFields(ghost: ValidatedGhost): Record<string, unknown> {
  return {
    format_version: ghost.version,
    required_features: ghost.required_features,
    run_flags: ghost.run_flags,
    unknown_run_flags: (ghost.run_flags & ~KNOWN_RUN_FLAGS) >>> 0,
    game_id: gameIdAscii(ghost.game_id),
    region: ghost.region,
    source_profile: ghost.source_profile,
    profile_name: ghost.profile_name,
    route_area: ghost.route.area,
    route_episode: ghost.route.episode,
    route_parent_area: ghost.route.parent_area,
    route_flags: ghost.route.flags,
    route_variant: ghost.route.variant,
    route_key: routeKey(ghost.route),
    portable: isPortableAcrossRegions(ghost),
    result_qf: ghost.result_qf,
    start_qf: ghost.start_qf,
    end_qf: ghost.end_qf,
    duration_qf: ghost.duration_qf,
    sample_count: ghost.sample_count,
    segment_count: ghost.segment_count,
    input_count: ghost.teaching.input_count,
    split_count: ghost.teaching.splits.length,
    camera_sample_count: ghost.camera ? ghost.camera.sample_count : null,
    initial_rng_seed: ghost.initial_rng ? ghost.initial_rng.seed : null,
    file_crc32: hex(ghost.file_checksum, 8).toUpperCase(),
    header_ghost_id: ghost.ghost_id,
    created_unix: ghost.created_unix === '0' ? null : ghost.created_unix,
    header_name: ghost.name,
    header_author: ghost.author,
  }
}
