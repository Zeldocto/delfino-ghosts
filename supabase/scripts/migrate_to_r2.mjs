#!/usr/bin/env node
/**
 * One-off: copy every object in the Supabase Storage bucket `ghosts` into the
 * S3-compatible archive bucket (Cloudflare R2) under the same key, so
 * existing ghosts.file_path values keep working unchanged.
 *
 *   node supabase/scripts/migrate_to_r2.mjs --dry-run   # report only
 *   node supabase/scripts/migrate_to_r2.mjs             # copy
 *
 * Configuration comes from environment variables, never arguments, so keys
 * stay out of shell history:
 *
 *   SUPABASE_URL              https://<ref>.supabase.co
 *   SUPABASE_PUBLISHABLE_KEY  the public anon/publishable key (the bucket is public)
 *   S3_ENDPOINT               https://<account-id>.r2.cloudflarestorage.com
 *   S3_BUCKET                 the R2 bucket name
 *   S3_REGION                 optional, default "auto"
 *   S3_ACCESS_KEY_ID          an R2 API token with write access to that bucket
 *   S3_SECRET_ACCESS_KEY
 *
 * Safe to re-run: a key already in R2 with the same size is skipped. Every
 * copy is read back from R2 and compared by size and sha256; a copy that fails
 * that check is removed from R2 again so the next run retries it. This script
 * NEVER deletes or modifies anything in Supabase; remove the old bucket by
 * hand once you have checked the result.
 */
import { createHash } from 'node:crypto'
import { AwsClient } from 'aws4fetch'

const dryRun = process.argv.includes('--dry-run')
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('usage: node supabase/scripts/migrate_to_r2.mjs [--dry-run]   (configuration via environment, see the file header)')
  process.exit(0)
}

const env = (name, fallback) => {
  const value = process.env[name] ?? fallback
  if (!value) {
    console.error(`missing environment variable ${name} (see the header of this script)`)
    process.exit(1)
  }
  return value
}
const supabaseUrl = env('SUPABASE_URL').replace(/\/+$/, '')
const publishableKey = env('SUPABASE_PUBLISHABLE_KEY')
const endpoint = env('S3_ENDPOINT').replace(/\/+$/, '')
const bucket = env('S3_BUCKET')
const aws = new AwsClient({
  accessKeyId: env('S3_ACCESS_KEY_ID'),
  secretAccessKey: env('S3_SECRET_ACCESS_KEY'),
  service: 's3',
  region: env('S3_REGION', 'auto'),
  retries: 3,
})

const SOURCE_BUCKET = 'ghosts'
const encodeKey = (key) => key.split('/').map(encodeURIComponent).join('/')
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const r2Url = (key) => `${endpoint}/${encodeURIComponent(bucket)}/${encodeKey(key)}`
const supabaseHeaders = { apikey: publishableKey, authorization: `Bearer ${publishableKey}` }

/** Lists one folder level of the Supabase bucket, all pages. */
async function listLevel(prefix) {
  const out = []
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(`${supabaseUrl}/storage/v1/object/list/${SOURCE_BUCKET}`, {
      method: 'POST',
      headers: { ...supabaseHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }),
    })
    if (!res.ok) throw new Error(`listing ${prefix || '/'} failed: ${res.status} ${await res.text()}`)
    const page = await res.json()
    out.push(...page)
    if (page.length < 1000) return out
  }
}

/** Every object key in the bucket with its recorded size. Folders have id null. */
async function listAll(prefix = '') {
  const objects = []
  for (const entry of await listLevel(prefix)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.id === null) objects.push(...(await listAll(path)))
    else objects.push({ key: path, size: Number(entry.metadata?.size ?? -1) })
  }
  return objects
}

async function r2Head(key) {
  const res = await aws.fetch(r2Url(key), { method: 'HEAD' })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`R2 HEAD ${key}: ${res.status}`)
  return Number(res.headers.get('content-length'))
}

async function copy(object) {
  const source = await fetch(`${supabaseUrl}/storage/v1/object/public/${SOURCE_BUCKET}/${encodeKey(object.key)}`)
  if (!source.ok) throw new Error(`download failed: ${source.status}`)
  const bytes = new Uint8Array(await source.arrayBuffer())
  if (object.size >= 0 && bytes.length !== object.size) {
    throw new Error(`Supabase returned ${bytes.length} bytes, its listing says ${object.size}`)
  }
  const digest = sha256(bytes)

  // No If-None-Match here: a re-run must be able to replace a partial copy.
  const put = await aws.fetch(r2Url(object.key), {
    method: 'PUT',
    body: bytes,
    headers: { 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=3600' },
  })
  if (!put.ok) throw new Error(`R2 PUT: ${put.status} ${await put.text()}`)

  // Read back through the signed API, not the public URL, so no CDN cache is involved.
  const back = await aws.fetch(r2Url(object.key))
  if (!back.ok) throw new Error(`R2 read-back: ${back.status}`)
  const copied = new Uint8Array(await back.arrayBuffer())
  const problem =
    copied.length !== bytes.length ? `size mismatch after copy: ${copied.length} != ${bytes.length}`
    : sha256(copied) !== digest ? 'sha256 mismatch after copy'
    : null
  if (problem) {
    // Remove the bad *R2* copy, or a same-size corrupt object would be skipped
    // on the next run. The Supabase original is never touched.
    await aws.fetch(r2Url(object.key), { method: 'DELETE' }).catch(() => {})
    throw new Error(`${problem}; the R2 copy was removed so a re-run retries it`)
  }
  return { bytes: bytes.length, sha256: digest }
}

/** ghosts.file_path values, read through the public REST API like moonshine_backfill.mjs. */
async function rowPaths() {
  const paths = []
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(`${supabaseUrl}/rest/v1/ghosts?select=file_path&order=created_at.asc&limit=1000&offset=${offset}`, {
      headers: supabaseHeaders,
    })
    if (!res.ok) throw new Error(`listing ghosts failed: ${res.status} ${await res.text()}`)
    const page = await res.json()
    paths.push(...page.map((row) => row.file_path))
    if (page.length < 1000) return paths
  }
}

console.log(`${dryRun ? '[dry run] ' : ''}Supabase ${supabaseUrl} bucket "${SOURCE_BUCKET}" -> ${endpoint}/${bucket}`)
const objects = await listAll()
console.log(`${objects.length} objects in the Supabase bucket`)

const tally = { copied: 0, would_copy: 0, skipped: 0, failed: 0 }
for (const object of objects) {
  try {
    const existing = await r2Head(object.key)
    if (existing !== null && existing === object.size) {
      tally.skipped++
      continue
    }
    if (dryRun) {
      tally.would_copy++
      console.log(`would copy ${object.key} (${object.size} bytes${existing !== null ? `; R2 has ${existing}` : ''})`)
      continue
    }
    const result = await copy(object)
    tally.copied++
    console.log(`copied ${object.key} ${result.bytes} bytes sha256 ${result.sha256}`)
  } catch (err) {
    tally.failed++
    console.error(`FAILED ${object.key}: ${err.message}`)
  }
}

const keys = new Set(objects.map((o) => o.key))
const orphanRows = (await rowPaths()).filter((path) => !keys.has(path))
console.log(tally)
if (orphanRows.length) {
  console.log(`${orphanRows.length} ghosts rows point at keys that are not in the Supabase bucket (not copied, nothing to copy):`)
  for (const path of orphanRows) console.log(`  ${path}`)
}
if (tally.failed) {
  console.error(`${tally.failed} object(s) failed. Fix the cause and re-run; finished copies are skipped.`)
  process.exit(1)
}
