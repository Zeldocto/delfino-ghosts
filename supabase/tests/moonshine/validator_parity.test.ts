/**
 * The TypeScript validator must agree with Moonshine's validate_ghost.py on
 * every input: same class (valid / invalid / unsupported), same message, and
 * the same parsed result for valid files.
 *
 *   MOONSHINE_VALIDATOR=../scripts/validate_ghost.py npm run test:moonshine
 *
 * Without MOONSHINE_VALIDATOR the parity checks are skipped, but the
 * standalone checks at the bottom still run. MOONSHINE_CORPUS_DIR may point at
 * a folder of real .smsghost files to include them as well (they are not
 * committed: they belong to the runners who recorded them).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { FormatError, classifyGhost, validateGhost } from '../../functions/_shared/ghost_format.ts'
import { buildGhost, finalize, refreshSegmentTableCrc } from './fixtures.ts'

const validatorPath = process.env.MOONSHINE_VALIDATOR ? resolve(process.env.MOONSHINE_VALIDATOR) : null
const corpusDir = process.env.MOONSHINE_CORPUS_DIR ? resolve(process.env.MOONSHINE_CORPUS_DIR) : null
const python = process.env.PYTHON ?? 'python'

interface Outcome {
  class: string
  message: string | null
  result: unknown
}

function tsOutcome(data: Uint8Array): Outcome {
  try {
    return { class: 'valid', message: null, result: validateGhost(data) }
  } catch (err) {
    if (!(err instanceof FormatError)) throw err
    return { class: err.kind, message: err.message, result: null }
  }
}

/** Deterministic PRNG so failures reproduce. */
function prng(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function mutations(name: string, base: Uint8Array): [string, Uint8Array][] {
  const out: [string, Uint8Array][] = [[name, base]]
  const set16 = (bytes: Uint8Array, offset: number, value: number) => {
    bytes[offset] = (value >> 8) & 0xff
    bytes[offset + 1] = value & 0xff
    return bytes
  }
  const set32 = (bytes: Uint8Array, offset: number, value: number) => {
    new DataView(bytes.buffer, bytes.byteOffset).setUint32(offset, value >>> 0)
    return bytes
  }

  for (const length of [0, 4, 7, 8, 100, 255, 256, 0x8ff, 0x900, base.length - 33, base.length - 1]) {
    if (length >= 0 && length < base.length) out.push([`${name}:trunc${length}`, base.slice(0, length)])
  }
  // Truncated but with a header that claims the shorter size and fresh CRCs.
  const short = base.slice(0, base.length - 16)
  set32(short, 8, short.length)
  set32(short, 72, short.length - 0x100)
  out.push([`${name}:trunc-consistent`, finalize(short)])
  const padded = new Uint8Array(base.length + 1)
  padded.set(base)
  out.push([`${name}:append`, padded])
  out.push([`${name}:append-consistent`, finalize(set32(set32(new Uint8Array(padded), 8, padded.length), 72, padded.length - 0x100))])
  for (const v of [0, 1, 2, 10, 0xffff]) out.push([`${name}:version${v}`, set16(new Uint8Array(base), 4, v)])
  for (const v of [3, 4, 5, 6, 7, 8, 9]) out.push([`${name}:as-v${v}`, finalize(set16(new Uint8Array(base), 4, v))])
  out.push([`${name}:feature64`, finalize(set32(new Uint8Array(base), 24, 64 | new DataView(base.buffer).getUint32(24)))])
  out.push([`${name}:feature-cleared`, finalize(set32(new Uint8Array(base), 24, 0))])
  out.push([`${name}:checksum-kind2`, finalize(Object.assign(new Uint8Array(base), { 95: 2 }))])
  out.push([`${name}:tas-unassisted`, finalize(set32(new Uint8Array(base), 28, 0x20))])
  out.push([`${name}:tas-assisted`, finalize(set32(new Uint8Array(base), 28, 0x21))])
  out.push([`${name}:unknown-run-flag`, finalize(set32(new Uint8Array(base), 28, 0x80000000))])
  out.push([`${name}:profile5`, finalize(Object.assign(new Uint8Array(base), { 38: 5 }))])
  out.push([`${name}:profile4`, finalize(Object.assign(new Uint8Array(base), { 38: 4 }))])
  out.push([`${name}:region-mismatch`, finalize(Object.assign(new Uint8Array(base), { 37: 1 }))])
  out.push([`${name}:slash-in-name`, finalize(Object.assign(new Uint8Array(base), { 120: 0x2f }))])
  out.push([`${name}:rng-provenance0`, finalize(refreshSegmentTableCrc(set32(new Uint8Array(base), 0x11c, 0)))])
  out.push([`${name}:rng-provenance2`, finalize(refreshSegmentTableCrc(set32(new Uint8Array(base), 0x11c, 2)))])

  const random = prng(base.length ^ 0x5eed)
  for (let i = 0; i < 40; i++) {
    const offset = Math.floor(random() * base.length)
    const bit = 1 << Math.floor(random() * 8)
    const raw = new Uint8Array(base)
    raw[offset] ^= bit
    out.push([`${name}:flip${offset}.${bit}`, raw])
    // Same flip with every CRC the tests know how to refresh, so deeper rules run.
    out.push([`${name}:flip${offset}.${bit}:crc`, finalize(refreshSegmentTableCrc(new Uint8Array(raw)))])
  }
  return out
}

function corpus(): [string, Uint8Array][] {
  const cases: [string, Uint8Array][] = []
  for (const version of [3, 4, 5, 6, 7, 8, 9]) {
    cases.push(...mutations(`v${version}`, buildGhost({ version })))
    cases.push(...mutations(`v${version}-2seg`, buildGhost({ version, segments: [6, 9], cameraSamples: 2 })))
  }
  cases.push(['v9-pal-noresult', buildGhost({ version: 9, region: 2, resultQf: null, splits: 0, inputs: 0, cameraSamples: 0 })])
  cases.push(['v5-8splits', buildGhost({ version: 5, splits: 8, inputs: 9, segments: [40] })])
  cases.push(['v5-9splits', buildGhost({ version: 5, splits: 9, inputs: 10, segments: [40] })])
  if (corpusDir) {
    for (const file of readdirSync(corpusDir).filter((f) => f.endsWith('.smsghost')).sort()) {
      const bytes = new Uint8Array(readFileSync(join(corpusDir, file)))
      cases.push(...mutations(`corpus/${file}`, bytes).slice(0, 12))
    }
  }
  return cases
}

test('TypeScript validator agrees with validate_ghost.py', { skip: !validatorPath && 'set MOONSHINE_VALIDATOR' }, () => {
  const cases = corpus()
  const dir = mkdtempSync(join(tmpdir(), 'sghf-parity-'))
  const paths = cases.map(([, bytes], index) => {
    const path = join(dir, `${index}.bin`)
    writeFileSync(path, bytes)
    return path
  })
  const oracleScript = resolve(import.meta.dirname, 'oracle.py')
  const results: Record<string, Outcome> = {}
  // Chunked so the command line stays under Windows' length limit.
  for (let i = 0; i < paths.length; i += 150) {
    const chunk = paths.slice(i, i + 150)
    const stdout = execFileSync(python, ['-I', oracleScript, validatorPath!, ...chunk], {
      maxBuffer: 256 * 1024 * 1024,
    })
    Object.assign(results, JSON.parse(stdout.toString()))
  }

  const classes: Record<string, number> = {}
  cases.forEach(([name, bytes], index) => {
    const expected = results[paths[index]]
    const actual = tsOutcome(bytes)
    classes[expected.class] = (classes[expected.class] ?? 0) + 1
    assert.equal(actual.class, expected.class, `${name}: class (python said ${expected.message})`)
    assert.equal(actual.message, expected.message, `${name}: message`)
    if (expected.result) assert.deepEqual(JSON.parse(JSON.stringify(actual.result)), expected.result, `${name}: result`)
  })
  // Guard against a corpus that never reaches the deep rules.
  assert.ok((classes.valid ?? 0) >= 14, `expected the clean fixtures to validate: ${JSON.stringify(classes)}`)
  assert.ok((classes.invalid ?? 0) > 200)
  assert.ok((classes.unsupported_version ?? 0) > 0 && (classes.unsupported_feature ?? 0) > 0)
  console.log(`parity: ${cases.length} inputs`, classes)
})

test('every fixture version validates and keeps its identity fields', () => {
  for (const version of [3, 4, 5, 6, 7, 8, 9]) {
    const ghost = validateGhost(buildGhost({ version }))
    assert.equal(ghost.version, version)
    assert.equal(ghost.ghost_id, '0123456789abcdef')
    assert.equal(ghost.initial_rng?.seed ?? null, version === 9 ? 0x2468ace0 : null)
    assert.equal(ghost.camera === null, version < 8)
  }
})

test('classifyGhost separates corrupt, unsupported and oversized input', () => {
  const good = buildGhost({ version: 9 })
  assert.equal(classifyGhost(good).status, 'compatible')

  const corrupt = new Uint8Array(good)
  corrupt[0x905] ^= 1
  assert.deepEqual([classifyGhost(corrupt).status, classifyGhost(corrupt).detail], ['invalid', 'ghost file checksum mismatch'])

  assert.equal(classifyGhost(good.slice(0, 200)).detail, 'truncated ghost header')

  const future = new Uint8Array(good)
  future[5] = 10
  assert.deepEqual([classifyGhost(future).status, classifyGhost(future).code], ['unsupported', 'unsupported_version'])

  const legacy = new Uint8Array(good)
  legacy[5] = 2
  assert.equal(classifyGhost(legacy).code, 'unsupported_version')

  const feature = finalize(Object.assign(new Uint8Array(good), { 27: 63 | 64 }))
  assert.equal(classifyGhost(feature).code, 'unsupported_feature')

  assert.equal(classifyGhost(new Uint8Array(104_857_601)).status, 'too_large')
  // Under the limit but over the format's own canonical maximum: invalid, not too_large.
  assert.equal(classifyGhost(new Uint8Array(1_298_017)).status, 'invalid')
})
