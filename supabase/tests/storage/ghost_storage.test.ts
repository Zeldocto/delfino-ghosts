/**
 * Tests for the ghost-storage Edge Function: the real handler, the real SQL
 * from every migration (PGlite), the real aws4fetch signer, and an in-memory
 * stand-in for the S3 bucket. Nothing here touches a real project or bucket.
 *
 *   npm run test:storage
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AwsClient } from 'aws4fetch'
import { createDatabase } from '../moonshine/harness.ts'
import { createHandler, PRESIGN_TTL_S } from '../../functions/ghost-storage/app.ts'
import { createS3, publicObjectUrl } from '../../functions/_shared/s3.ts'
import { MAX_GHOST_BYTES, safeFilename } from '../../functions/_shared/ghost_paths.ts'
import { MOONSHINE_MAX_FILE_BYTES } from '../../functions/_shared/ghost_format.ts'
import { MAX_GHOST_BYTES as WEBSITE_MAX_GHOST_BYTES } from '../../../src/types/index.ts'

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const ENDPOINT = 'https://account.r2.cloudflarestorage.com'
const BUCKET = 'ghosts'

/** An S3 bucket in memory, reached through real signed requests. */
function memoryBucket() {
  const objects = new Map<string, Uint8Array>()
  const requests: Request[] = []
  const keyOf = (url: string) => {
    const path = new URL(url).pathname
    const prefix = `/${BUCKET}/`
    assert.ok(path.startsWith(prefix), path)
    return path.slice(prefix.length).split('/').map(decodeURIComponent).join('/')
  }
  const fetchImpl = (async (input: Request) => {
    requests.push(input)
    assert.match(input.headers.get('authorization') ?? '', /^AWS4-HMAC-SHA256 Credential=test-key\//)
    const key = keyOf(input.url)
    const stored = objects.get(key)
    switch (input.method) {
      case 'HEAD':
        return stored ? new Response(null, { status: 200, headers: { 'content-length': String(stored.length) } }) : new Response(null, { status: 404 })
      case 'GET':
        return stored ? new Response(stored as BodyInit) : new Response('NoSuchKey', { status: 404 })
      case 'PUT':
        objects.set(key, new Uint8Array(await input.arrayBuffer()))
        return new Response(null, { status: 200 })
      case 'DELETE':
        objects.delete(key)
        return new Response(null, { status: 204 })
      default:
        return new Response(null, { status: 405 })
    }
  }) as typeof fetch
  const s3 = createS3(
    { endpoint: ENDPOINT, bucket: BUCKET, region: 'auto', accessKeyId: 'test-key', secretAccessKey: 'test-secret', publicBaseUrl: 'https://ghosts.example.org' },
    AwsClient,
    fetchImpl,
  )
  return { s3, objects, requests }
}

async function setup() {
  const db = await createDatabase()
  const one = async (query: string, params: unknown[]) => (await db.query(query, params)).rows.length > 0
  for (const [id, username] of [[ALICE, 'alice'], [BOB, 'bob']]) {
    await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [
      id, `${username}@example.com`, JSON.stringify({ username }),
    ])
  }
  const bucket = memoryBucket()
  const handler = createHandler({
    // Tokens in these tests are just "token-<uid>".
    verifyToken: async (token) => (token.startsWith('token-') ? token.slice(6) : null),
    db: {
      isActiveAccount: (uid) => one(`select 1 from public.profiles where id = $1 and deleted_at is null`, [uid]),
      isValidated: (key) => one(`select 1 from public.ghost_moonshine_index where file_path = $1`, [key]),
      isReferenced: (key) => one(`select 1 from public.ghosts where file_path = $1`, [key]),
    },
    s3: bucket.s3,
  })
  async function call(uid: string | null, body: unknown, method = 'POST') {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (uid) headers.authorization = `Bearer token-${uid}`
    const res = await handler(new Request('https://ref.supabase.co/functions/v1/ghost-storage', {
      method, headers, body: method === 'POST' ? JSON.stringify(body) : undefined,
    }))
    const text = await res.text()
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null }
  }
  /** Inserts a ghosts row the way the website does, as superuser (ownership is not under test here). */
  async function addRow(uid: string, key: string, size = 10) {
    const id = key.split('/')[1]
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid])
    await db.query(`insert into public.ghosts (id, user_id, title, file_path, original_filename, file_size)
                    values ($1, $2, 'g', $3, 'g.smsghost', $4)`, [id, uid, key, size])
    return id
  }
  return { db, bucket, call, addRow }
}

test('every copy of the size limit agrees: 100 MiB', async () => {
  assert.equal(MAX_GHOST_BYTES, 104_857_600)
  assert.equal(MOONSHINE_MAX_FILE_BYTES, MAX_GHOST_BYTES)
  assert.equal(WEBSITE_MAX_GHOST_BYTES, MAX_GHOST_BYTES)
  const { db, addRow } = await setup()
  await addRow(ALICE, `${ALICE}/${crypto.randomUUID()}/max.smsghost`, MAX_GHOST_BYTES)
  await assert.rejects(addRow(ALICE, `${ALICE}/${crypto.randomUUID()}/over.smsghost`, MAX_GHOST_BYTES + 1), /ghosts_file_size_range/)
  const bucket = await db.query<{ file_size_limit: number }>(`select file_size_limit from storage.buckets where id = 'ghost-uploads'`)
  assert.equal(Number(bucket.rows[0].file_size_limit), MAX_GHOST_BYTES)
})

test('presign-upload signs one key under the caller, one exact size and type, no overwrite', async () => {
  const { call } = await setup()
  const ghostId = crypto.randomUUID()
  const res = await call(ALICE, { action: 'presign-upload', ghost_id: ghostId, filename: '../2026_10_13_AS1_45645[DE2C7FB6].smsghost', byte_size: 4321 })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.headers.get('access-control-allow-origin'), '*')
  assert.equal(res.body.key, `${ALICE}/${ghostId}/2026_10_13_AS1_45645_DE2C7FB6_.smsghost`)
  assert.equal(res.body.method, 'PUT')
  assert.equal(res.body.expires_in, PRESIGN_TTL_S)
  assert.deepEqual(res.body.headers, { 'content-type': 'application/octet-stream', 'if-none-match': '*' })

  const url = new URL(res.body.url)
  assert.equal(`${url.origin}${url.pathname}`, `${ENDPOINT}/${BUCKET}/${res.body.key}`)
  assert.equal(url.searchParams.get('X-Amz-Expires'), '900')
  assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'content-length;content-type;host;if-none-match')
  assert.match(url.searchParams.get('X-Amz-Credential') ?? '', /^test-key\/\d{8}\/auto\/s3\/aws4_request$/)
  assert.match(url.searchParams.get('X-Amz-Signature') ?? '', /^[0-9a-f]{64}$/)
  // No secret material in anything the browser receives.
  assert.ok(!JSON.stringify(res.body).includes('test-secret'))
})

test('presign-upload refuses guests, deleted accounts, bad input and anything over 100 MiB', async () => {
  const { db, call } = await setup()
  const base = { action: 'presign-upload', ghost_id: crypto.randomUUID(), filename: 'a.smsghost', byte_size: 10 }

  assert.deepEqual([(await call(null, base)).status, (await call(null, base)).body.error], [401, 'not_authenticated'])
  assert.equal((await call(ALICE, { ...base, ghost_id: '../x' })).body.error, 'invalid_request')
  assert.equal((await call(ALICE, { ...base, byte_size: 0 })).body.error, 'invalid_request')
  assert.equal((await call(ALICE, { ...base, byte_size: 1.5 })).body.error, 'invalid_request')
  assert.equal((await call(ALICE, { ...base, filename: '' })).body.error, 'invalid_request')
  assert.equal((await call(ALICE, { ...base, action: 'list' })).body.error, 'invalid_request')
  assert.equal((await call(ALICE, null, 'GET')).status, 405)

  const over = await call(ALICE, { ...base, byte_size: MAX_GHOST_BYTES + 1 })
  assert.deepEqual([over.status, over.body.error], [413, 'too_large'])
  assert.equal((await call(ALICE, { ...base, byte_size: MAX_GHOST_BYTES })).status, 200)

  // A forged owner in the body is ignored: the key is always under the token's uid.
  const forged = await call(ALICE, { ...base, user_id: BOB, filename: `${BOB}/x.smsghost` })
  assert.ok(forged.body.key.startsWith(`${ALICE}/`), forged.body.key)

  // Not a .smsghost: the name is normalised onto the extension, never stored as-is.
  assert.ok((await call(ALICE, { ...base, filename: 'evil.html' })).body.key.endsWith('/evil.html.smsghost'))

  // Deleted accounts (0008) can no longer write, even with a token that has not expired.
  await db.query(`delete from auth.users where id = $1`, [BOB])
  const gone = await call(BOB, base)
  assert.deepEqual([gone.status, gone.body.error], [403, 'forbidden'])
})

test('presign-upload never hands out a URL for an object that already exists', async () => {
  const { call, bucket } = await setup()
  const ghostId = crypto.randomUUID()
  const key = `${ALICE}/${ghostId}/a.smsghost`
  bucket.objects.set(key, new Uint8Array([1, 2, 3]))
  const res = await call(ALICE, { action: 'presign-upload', ghost_id: ghostId, filename: 'a.smsghost', byte_size: 3 })
  assert.deepEqual([res.status, res.body.error], [409, 'object_exists'])
})

test('delete removes only unreferenced, unvalidated objects in the caller\'s own folder', async () => {
  const { db, call, bucket, addRow } = await setup()
  const ghostId = crypto.randomUUID()
  const key = `${ALICE}/${ghostId}/a.smsghost`
  bucket.objects.set(key, new Uint8Array([1]))

  for (const bad of [
    `${BOB}/${ghostId}/a.smsghost`,          // someone else's folder
    `${ALICE}/a.smsghost`,                   // one folder only
    `${ALICE}/${ghostId}/x/a.smsghost`,      // three folders
    `${ALICE}/${ghostId}/../a.smsghost`,     // traversal
    `${ALICE}/${ghostId}/a.txt`,             // wrong extension
    `${ALICE}/${ghostId}/a b.smsghost`,      // a name safeFilename would change
    42,
  ]) {
    const res = await call(ALICE, { action: 'delete', key: bad })
    assert.deepEqual([res.status, res.body.error], [403, 'forbidden'], String(bad))
  }
  assert.ok(bucket.objects.has(key))

  // A ghosts row still points at it: refused, so a live ghost never loses its file.
  await addRow(ALICE, key)
  assert.deepEqual((await call(ALICE, { action: 'delete', key })).body.error, 'in_use')

  // Validated for Moonshine: immutable, as the 0012 Storage policy had it.
  await db.query(`insert into public.ghost_moonshine_index (ghost_id, file_path, byte_length, content_sha256, status, status_code, validator, source)
                  values ($1, $2, 1, repeat('a', 64), 'invalid', 'invalid_ghost', 'test', 'website')`, [ghostId, key])
  await db.query(`update public.ghosts set file_path = $1 where id = $2`, [`${ALICE}/${ghostId}/b.smsghost`, ghostId])
  await db.query(`insert into public.ghost_moonshine_index (ghost_id, file_path, byte_length, content_sha256, status, status_code, validator, source)
                  values ($1, $2, 1, repeat('a', 64), 'invalid', 'invalid_ghost', 'test', 'website')
                  on conflict (ghost_id) do update set file_path = excluded.file_path`, [ghostId, key])
  assert.deepEqual((await call(ALICE, { action: 'delete', key })).body.error, 'in_use')

  // Row gone (the index row cascades with it): the object can go.
  await db.query(`delete from public.ghosts where id = $1`, [ghostId])
  const ok = await call(ALICE, { action: 'delete', key })
  assert.deepEqual([ok.status, ok.body.deleted], [200, key])
  assert.ok(!bucket.objects.has(key))
  // Deleting again is harmless.
  assert.equal((await call(ALICE, { action: 'delete', key })).status, 200)

  // Deleted accounts cannot delete either.
  const bobKey = `${BOB}/${crypto.randomUUID()}/b.smsghost`
  bucket.objects.set(bobKey, new Uint8Array([1]))
  await db.query(`delete from auth.users where id = $1`, [BOB])
  assert.equal((await call(BOB, { action: 'delete', key: bobKey })).body.error, 'forbidden')
  assert.ok(bucket.objects.has(bobKey))
})

test('the S3 client round-trips bytes and builds public URLs per segment', async () => {
  const bucket = memoryBucket()
  const key = `${ALICE}/${crypto.randomUUID()}/r123_${safeFilename('a b.smsghost')}`
  const bytes = crypto.getRandomValues(new Uint8Array(1024))
  assert.equal(await bucket.s3.head(key), null)
  await bucket.s3.put(key, bytes)
  assert.equal(await bucket.s3.head(key), 1024)
  assert.deepEqual(await bucket.s3.get(key), bytes)
  await bucket.s3.remove(key)
  assert.equal(await bucket.s3.get(key), null)
  await bucket.s3.remove(key) // missing is fine
  assert.equal(publicObjectUrl('https://ghosts.example.org/', 'u/g/a b.smsghost'), 'https://ghosts.example.org/u/g/a%20b.smsghost')
})
