/**
 * End-to-end tests for the Moonshine API: the real request handler, the real
 * SQL from every migration (in PGlite), and an in-memory object store.
 *
 *   npm run test:moonshine
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callAs, createApp, sha256Hex } from './harness.ts'
import { buildGhost, finalize } from './fixtures.ts'

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'

type App = Awaited<ReturnType<typeof createApp>>

/** Runs SQL as a signed-in website user, the way PostgREST would. */
async function asUser<T = Record<string, unknown>>(app: App, uid: string | null, query: string, params: unknown[] = []) {
  return app.db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid ?? ''])
    await tx.exec(`set local role ${uid ? 'authenticated' : 'anon'}`)
    return (await tx.query<T>(query, params)).rows
  })
}

/** A browser upload: object in Storage plus a ghosts row, as the website does it. */
async function websiteUpload(app: App, uid: string, bytes: Uint8Array, title = 'web ghost') {
  const id = crypto.randomUUID()
  const path = `${uid}/${id}/web.smsghost`
  app.storage.archive.set(path, bytes)
  await asUser(app, uid, `insert into public.ghosts (id, user_id, title, file_path, original_filename, file_size)
                         values ($1, $2, $3, $4, 'web.smsghost', $5)`, [id, uid, title, path, bytes.length])
  return { id, path }
}

async function uploadViaApi(app: App, token: string, bytes: Uint8Array, extra: Record<string, unknown> = {}) {
  const created = await app.request('POST', '/v1/uploads', {
    token,
    body: { byte_length: bytes.length, sha256: await sha256Hex(bytes), ...extra },
  })
  assert.ok([200, 201].includes(created.status), JSON.stringify(created.body))
  const id = created.body.upload.upload_id
  const put = await app.request('PUT', `/v1/uploads/${id}/content`, { token, body: bytes })
  const published = put.status === 200 ? await app.request('POST', `/v1/uploads/${id}/publish`, { token }) : null
  return { created, put, published, id }
}

async function setup() {
  const app = await createApp()
  await app.createUser(ALICE, 'alice')
  await app.createUser(BOB, 'bob')
  return app
}

// --- capabilities ------------------------------------------------------------------

test('capabilities declares versions, limits and auth without needing a key', async () => {
  const app = await setup()
  const res = await app.request('GET', '/v1/capabilities')
  assert.equal(res.status, 200)
  assert.equal(res.body.api_version, 1)
  assert.deepEqual(res.body.formats[0].versions, [3, 4, 5, 6, 7, 8, 9])
  assert.equal(res.body.formats[0].required_features_by_version[9], 63)
  assert.equal(res.body.limits.max_upload_bytes, 1_297_992)
  assert.equal(res.body.auth.client_key_required, false)
  assert.equal(res.headers.get('access-control-allow-origin'), '*')

  const unknown = await app.request('GET', '/v1/nope')
  assert.equal(unknown.status, 404)
  assert.deepEqual(Object.keys(unknown.body.error).sort(), ['code', 'message', 'retryable'])
  assert.equal((await app.request('DELETE', '/v1/capabilities')).body.error.code, 'method_not_allowed')
})

// --- catalogue ----------------------------------------------------------------------

test('website uploads are validated server-side before they are advertised', async () => {
  const app = await setup()
  const good = await websiteUpload(app, ALICE, buildGhost({ version: 9, name: 'TAS Bianco Hills 4 - 1:00.794' }))
  const corrupt = buildGhost({ version: 8, ghostId: [1, 2] })
  corrupt[0x950] ^= 0xff
  const bad = await websiteUpload(app, ALICE, corrupt)
  const future = finalize(Object.assign(buildGhost({ version: 9, ghostId: [3, 4] }), { 5: 10 }))
  const unsupported = await websiteUpload(app, ALICE, future)
  const truncated = await websiteUpload(app, ALICE, buildGhost({ version: 7, ghostId: [5, 6] }).slice(0, 2500))

  // Not indexed yet: nothing is advertised, and the row says why.
  assert.equal((await app.request('GET', '/v1/ghosts')).body.total, 0)
  assert.equal((await app.request('GET', `/v1/ghosts/${good.id}`)).body.ghost.status, 'not_indexed')

  const results: Record<string, unknown>[] = []
  for (const g of [good, bad, unsupported, truncated]) {
    results.push((await app.request('POST', `/v1/ghosts/${g.id}/index`)).body)
  }
  assert.deepEqual(results.map((r) => r.status), ['compatible', 'invalid', 'unsupported', 'invalid'])
  assert.equal(results[1].detail, 'ghost file checksum mismatch')
  assert.equal(results[2].code, 'unsupported_version')
  assert.equal(results[3].detail, 'ghost file size does not match bytes')

  // Indexing again is a no-op.
  assert.equal((await app.request('POST', `/v1/ghosts/${good.id}/index`)).body.reindexed, false)

  const list = await app.request('GET', '/v1/ghosts')
  assert.equal(list.body.total, 1)
  const entry = list.body.items[0]
  assert.equal(entry.id, good.id)
  assert.equal(entry.format.version, 9)
  assert.deepEqual(entry.format.features, ['extended_codec', 'teaching', 'fludd', 'visual_v7', 'camera', 'initial_rng'])
  assert.equal(entry.file.sha256, await sha256Hex(app.storage.archive.get(good.path)!))
  assert.equal(entry.file.download_url, `https://example-ref.supabase.co/storage/v1/object/public/ghosts/${good.path}`)
  assert.equal(entry.route.key, '02.2.ff.00.-1')
  assert.equal(entry.route.portable_across_regions, true)
  assert.deepEqual(entry.timing, { unit: 'qf', result_qf: 44, start_qf: 0, end_qf: 44, duration_qf: 44, export_duration_ms: 367 })
  assert.deepEqual(entry.recording.initial_rng, { seed: 0x2468ace0, provenance: 'first_recorded_pose' })
  // The website row has is_tas = false and the file has no TAS bit: unknown, never "clean".
  assert.equal(entry.eligibility.assistance, 'unknown')
  assert.equal(entry.eligibility.uploader_tas, null)

  const detail = await app.request('GET', `/v1/ghosts/${bad.id}`)
  assert.deepEqual([detail.body.ghost.compatible, detail.body.ghost.status], [false, 'invalid'])
  const file = await app.request('GET', `/v1/ghosts/${good.id}/file`)
  assert.equal(file.status, 302)
  assert.equal(file.headers.get('location'), entry.file.download_url)
  assert.equal((await app.request('GET', `/v1/ghosts/${bad.id}/file`)).status, 404)
  assert.equal((await app.request('GET', `/v1/ghosts/${crypto.randomUUID()}`)).status, 404)
})

test('oversized but otherwise valid files stay on the website and are not advertised', async () => {
  const app = await setup()
  // 9 splits pushes a V5 past 1,297,992 bytes only at full capacity, so fake the size.
  const big = new Uint8Array(1_297_993)
  big.set(buildGhost({ version: 5 }))
  const ghost = await websiteUpload(app, ALICE, big)
  const res = await app.request('POST', `/v1/ghosts/${ghost.id}/index`)
  assert.deepEqual([res.body.status, res.body.code], ['too_large', 'too_large'])
  assert.equal((await app.request('GET', '/v1/ghosts')).body.total, 0)
})

test('pagination is stable, filtered and rejects bad parameters', async () => {
  const app = await setup()
  const ids: string[] = []
  for (let i = 0; i < 7; i++) {
    const g = await websiteUpload(app, i % 2 ? BOB : ALICE, buildGhost({
      version: i % 2 ? 5 : 9, region: i % 3, ghostId: [10, i], area: i < 5 ? 0x02 : 0x07,
      episode: 2, resultQf: null, runFlags: i === 6 ? 0x21 : i === 4 ? 0x02 : 0,
    }))
    await app.request('POST', `/v1/ghosts/${g.id}/index`)
    ids.push(g.id)
  }
  // Area 0x07 without a parent is valid, but not portable across regions.
  const all = await app.request('GET', '/v1/ghosts?limit=50')
  assert.equal(all.body.total, 7)

  const seen: string[] = []
  let cursor: string | null = null
  let pages = 0
  do {
    const res = await app.request('GET', `/v1/ghosts?limit=2${cursor ? `&cursor=${cursor}` : ''}`)
    assert.equal(res.status, 200)
    seen.push(...res.body.items.map((e: { id: string }) => e.id))
    cursor = res.body.next_cursor
    pages++
    if (pages === 1) {
      // A ghost added mid-browse lands before the cursor and does not shift later pages.
      const late = await websiteUpload(app, ALICE, buildGhost({ version: 9, ghostId: [99, 99] }))
      await app.request('POST', `/v1/ghosts/${late.id}/index`)
    }
  } while (cursor)
  assert.equal(pages, 4)
  assert.equal(new Set(seen).size, 7)
  assert.deepEqual(seen, all.body.items.map((e: { id: string }) => e.id))

  const byAuthor = await app.request('GET', '/v1/ghosts?author=BOB')
  assert.ok(byAuthor.body.items.every((e: { author: { username: string } }) => e.author.username === 'bob'))
  assert.equal((await app.request('GET', '/v1/ghosts?format_version=5')).body.total, 3)
  assert.equal((await app.request('GET', '/v1/ghosts?region=pal')).body.total, 2)
  assert.equal((await app.request('GET', '/v1/ghosts?route_key=02.2.ff.00.-1')).body.total, 6)
  assert.equal((await app.request('GET', '/v1/ghosts?assistance=assisted')).body.total, 1)
  assert.equal((await app.request('GET', '/v1/ghosts?assistance=unknown')).body.total, 6)
  assert.equal((await app.request('GET', '/v1/ghosts?assistance=tas')).body.total, 1)
  assert.equal((await app.request('GET', '/v1/ghosts?playable_on=us')).body.total, 6)

  for (const bad of ['limit=0', 'limit=51', 'region=eu', 'sort=fastest', 'cursor=abc', 'assistance=clean', 'route_key=BH3', 'cursor=r~1~00000000-0000-0000-0000-000000000000']) {
    const res = await app.request('GET', `/v1/ghosts?${bad}`)
    assert.equal(res.status, 400, bad)
    assert.equal(res.body.error.code, 'invalid_parameter', bad)
  }
})

// --- device linking ---------------------------------------------------------------

test('device linking: pending, slow_down, approval, single-use code', async () => {
  const app = await setup()
  const start = await app.request('POST', '/v1/device/code', { body: { client_name: 'Moonshine Wii', client_version: '0.9.0' } })
  assert.equal(start.status, 200)
  assert.match(start.body.user_code, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/)
  assert.equal(start.body.verification_uri, 'https://zeldocto.github.io/delfino-ghosts/link')
  assert.equal(start.body.verification_uri_complete, `https://zeldocto.github.io/delfino-ghosts/link?code=${start.body.user_code}`)
  assert.deepEqual([start.body.expires_in, start.body.interval], [600, 5])
  const poll = () => app.request('POST', '/v1/device/token', { body: { device_code: start.body.device_code } })

  const first = await poll()
  assert.deepEqual([first.status, first.body.error.code, first.body.error.retryable], [400, 'authorization_pending', true])
  const fast = await poll()
  assert.deepEqual([fast.body.error.code, fast.body.error.interval], ['slow_down', 10])
  assert.equal(fast.headers.get('retry-after'), '10')

  // The website shows what is asking; codes are case- and dash-insensitive.
  const typed = start.body.user_code.replace('-', '').toLowerCase()
  const lookup = (await callAs(app.db, 'authenticated', ALICE, 'moonshine_link_lookup', { p_user_code: typed })) as Record<string, unknown>
  assert.deepEqual([lookup.status, lookup.client_name], ['pending', 'Moonshine Wii'])
  // A guest cannot approve.
  await assert.rejects(callAs(app.db, 'anon', null, 'moonshine_link_decide', { p_user_code: typed, p_approve: true }), /permission denied/)
  assert.equal(((await callAs(app.db, 'authenticated', ALICE, 'moonshine_link_decide', { p_user_code: typed, p_approve: true })) as Record<string, unknown>).status, 'approved')
  // The code cannot be approved twice, e.g. by someone else.
  assert.equal(((await callAs(app.db, 'authenticated', BOB, 'moonshine_link_decide', { p_user_code: typed, p_approve: true })) as Record<string, unknown>).error, 'not_found')

  const issued = await poll()
  assert.equal(issued.status, 200)
  assert.match(issued.body.access_token, /^dga_/)
  assert.match(issued.body.refresh_token, /^dgr_/)
  assert.deepEqual([issued.body.expires_in, issued.body.refresh_expires_in], [3600, 7_776_000])
  assert.equal(issued.body.user.username, 'alice')
  const me = await app.request('GET', '/v1/me', { token: issued.body.access_token })
  assert.equal(me.body.user.id, ALICE)

  // A lost response may be re-polled briefly; the replacement supersedes the first pair.
  const again = await poll()
  assert.equal(again.status, 200)
  assert.equal((await app.request('GET', '/v1/me', { token: issued.body.access_token })).status, 401)
  await app.admin(`update public.moonshine_device_links set tokens_issued_at = now() - interval '5 minutes'`)
  assert.equal((await poll()).body.error.code, 'invalid_grant')

  // Raw tokens are never stored.
  const stored = await app.admin(`select access_token_hash, refresh_token_hash from public.moonshine_device_links`)
  assert.ok(!JSON.stringify(stored.rows).includes(again.body.access_token.slice(4)))
})

test('device linking: denial, expiry, and rate limits', async () => {
  const app = await setup()
  const denied = await app.request('POST', '/v1/device/code', { body: {} })
  await callAs(app.db, 'authenticated', ALICE, 'moonshine_link_decide', { p_user_code: denied.body.user_code, p_approve: false })
  const deniedPoll = await app.request('POST', '/v1/device/token', { body: { device_code: denied.body.device_code } })
  assert.deepEqual([deniedPoll.body.error.code, deniedPoll.body.error.retryable], ['access_denied', false])

  const expired = await app.request('POST', '/v1/device/code', { body: { client_name: 'Dolphin companion' } })
  await app.admin(`update public.moonshine_device_links set code_expires_at = now() - interval '1 second' where status = 'pending'`)
  const late = await callAs(app.db, 'authenticated', ALICE, 'moonshine_link_decide', { p_user_code: expired.body.user_code, p_approve: true })
  assert.equal((late as Record<string, unknown>).error, 'not_found')
  assert.equal((await app.request('POST', '/v1/device/token', { body: { device_code: expired.body.device_code } })).body.error.code, 'expired_token')
  assert.equal((await app.request('POST', '/v1/device/token', { body: { device_code: 'dgd_unknown' } })).body.error.code, 'invalid_grant')
  assert.equal((await app.request('POST', '/v1/device/token', { body: {} })).body.error.code, 'invalid_request')
  assert.equal((await app.request('POST', '/v1/device/code', { body: { client_name: 'café' } })).status, 400)

  // Ten starts per IP per 10 minutes; the eleventh is told when to retry.
  const ip = '198.51.100.20'
  for (let i = 0; i < 10; i++) assert.equal((await app.request('POST', '/v1/device/code', { body: {}, ip })).status, 200)
  const limited = await app.request('POST', '/v1/device/code', { body: {}, ip })
  assert.deepEqual([limited.status, limited.body.error.code], [429, 'rate_limited'])
  assert.ok(Number(limited.headers.get('retry-after')) > 0)
  assert.equal((await app.request('POST', '/v1/device/code', { body: {}, ip: '198.51.100.21' })).status, 200)
})

test('tokens: refresh rotates, reuse revokes, expiry and unlinking stop access', async () => {
  const app = await setup()
  const t1 = await app.linkDevice(ALICE)
  const refresh = (token: string) => app.request('POST', '/v1/device/refresh', { body: { refresh_token: token } })

  const t2 = await refresh(t1.refresh_token)
  assert.equal(t2.status, 200)
  assert.notEqual(t2.body.refresh_token, t1.refresh_token)
  assert.equal((await app.request('GET', '/v1/me', { token: t2.body.access_token })).status, 200)
  // Retrying with the old refresh token right away (lost response) still works...
  const t3 = await refresh(t1.refresh_token)
  assert.equal(t3.status, 200)
  // ...but presenting it after the grace window is treated as theft.
  await app.admin(`update public.moonshine_device_links set rotated_at = now() - interval '10 minutes'`)
  const reuse = await refresh(t1.refresh_token)
  assert.deepEqual([reuse.status, reuse.body.error.code, reuse.body.error.reason], [400, 'invalid_grant', 'refresh_token_reuse'])
  assert.equal((await app.request('GET', '/v1/me', { token: t3.body.access_token })).body.error.code, 'invalid_token')

  // Expired access token: 401 token_expired, retryable after refresh.
  const t4 = await app.linkDevice(ALICE)
  await app.admin(`update public.moonshine_device_links set access_expires_at = now() - interval '1 second' where status = 'active'`)
  const expired = await app.request('GET', '/v1/me', { token: t4.access_token })
  assert.deepEqual([expired.status, expired.body.error.code, expired.body.error.retryable], [401, 'token_expired', true])
  assert.match(expired.headers.get('www-authenticate') ?? '', /^Bearer/)
  const t5 = await refresh(t4.refresh_token)
  assert.equal((await app.request('GET', '/v1/me', { token: t5.body.access_token })).status, 200)

  // Expired refresh token: link ends.
  await app.admin(`update public.moonshine_device_links set refresh_expires_at = now() - interval '1 second' where status = 'active'`)
  assert.equal((await refresh(t5.body.refresh_token)).body.error.reason, 'refresh_token_expired')

  // Unlinking from the website.
  const t6 = await app.linkDevice(ALICE)
  const links = (await callAs(app.db, 'authenticated', ALICE, 'moonshine_my_device_links', {})) as { id: string }[]
  assert.equal(links.length, 1)
  assert.equal(await callAs(app.db, 'authenticated', BOB, 'moonshine_revoke_device_link', { p_link_id: links[0].id }), false)
  assert.equal((await app.request('GET', '/v1/me', { token: t6.access_token })).status, 200)
  assert.equal(await callAs(app.db, 'authenticated', ALICE, 'moonshine_revoke_device_link', { p_link_id: links[0].id }), true)
  assert.equal((await app.request('GET', '/v1/me', { token: t6.access_token })).status, 401)
  assert.equal((await refresh(t6.refresh_token)).body.error.code, 'invalid_grant')

  // Unlinking from the device, idempotently.
  const t7 = await app.linkDevice(ALICE)
  assert.equal((await app.request('POST', '/v1/device/revoke', { body: { token: t7.refresh_token } })).body.revoked, true)
  assert.equal((await app.request('POST', '/v1/device/revoke', { body: { token: t7.refresh_token } })).body.revoked, true)
  assert.equal((await app.request('POST', '/v1/device/revoke', { body: { token: 'dgr_never-issued' } })).body.revoked, false)
  assert.equal((await app.request('GET', '/v1/me', { token: t7.access_token })).status, 401)
})

test('account deletion revokes linked devices; device cap is enforced', async () => {
  const app = await setup()
  const t = await app.linkDevice(BOB)
  await callAs(app.db, 'authenticated', BOB, 'delete_own_account', {})
  assert.equal((await app.request('GET', '/v1/me', { token: t.access_token })).status, 401)
  assert.equal((await app.request('POST', '/v1/device/refresh', { body: { refresh_token: t.refresh_token } })).body.error.code, 'invalid_grant')

  for (let i = 0; i < 10; i++) await app.linkDevice(ALICE, `device ${i}`)
  const extra = await app.request('POST', '/v1/device/code', { body: {}, ip: '192.0.2.99' })
  const decided = await callAs(app.db, 'authenticated', ALICE, 'moonshine_link_decide', { p_user_code: extra.body.user_code, p_approve: true })
  assert.equal((decided as Record<string, unknown>).error, 'too_many_devices')
})

// --- uploads ---------------------------------------------------------------------

test('uploads require a valid device token', async () => {
  const app = await setup()
  const bytes = buildGhost()
  const body = { byte_length: bytes.length, sha256: await sha256Hex(bytes) }
  for (const token of [undefined, 'dga_not-a-real-token-at-all-xxxxxxxx', 'eyJhbGciOiJIUzI1NiJ9.e30.x']) {
    const res = await app.request('POST', '/v1/uploads', { token, body })
    assert.deepEqual([res.status, res.body.error.code], [401, 'invalid_token'])
  }
  // A device token is not a Supabase session and the tables are closed to clients.
  for (const table of ['moonshine_device_links', 'moonshine_uploads', 'moonshine_rate_limits']) {
    await assert.rejects(asUser(app, ALICE, `select * from public.${table}`), /permission denied/, table)
  }
  await assert.rejects(
    asUser(app, ALICE, `insert into public.ghost_moonshine_index (ghost_id, file_path, byte_length, content_sha256, status, status_code, validator, source)
                        values (gen_random_uuid(), 'x', 1, repeat('a', 64), 'invalid', 'x', 'x', 'website')`),
    /permission denied/,
  )
  // The service-role functions cannot be called by website users or guests.
  const serviceOnly: [string, Record<string, unknown>][] = [
    ['moonshine_authenticate', { p_access_hash: 'x' }],
    ['moonshine_device_poll', { p_device_code_hash: 'x', p_access_hash: 'y', p_refresh_hash: 'z' }],
    ['moonshine_upload_create', { p_user_id: ALICE, p_link_id: null, p_byte_length: 10, p_sha256: 'a'.repeat(64),
      p_filename: null, p_title: null, p_description: null, p_tas_declared: null, p_idempotency_key: null }],
    ['moonshine_index_put', { p_ghost_id: ALICE, p_file_path: 'x', p_byte_length: 1, p_sha256: 'a'.repeat(64),
      p_status: 'compatible', p_code: 'ok', p_detail: null, p_validator: 'x', p_source: 'website', p_fields: {} }],
    ['moonshine_rate_limit_hit', { p_bucket: 'x', p_key: 'y', p_limit: 1, p_window_s: 60 }],
  ]
  for (const [fn, args] of serviceOnly) {
    await assert.rejects(callAs(app.db, 'authenticated', ALICE, fn, args), /permission denied/, fn)
    await assert.rejects(callAs(app.db, 'anon', null, fn, args), /permission denied/, fn)
  }
})

test('upload happy path preserves bytes exactly and publishes under the token owner', async () => {
  const app = await setup()
  const { access_token: token } = await app.linkDevice(ALICE)
  const bytes = buildGhost({ version: 9, name: 'Bianco Hills 3 - 0:37.337', profileName: 'Any percent', rngSeed: 0 })
  const sha = await sha256Hex(bytes)

  const created = await app.request('POST', '/v1/uploads', {
    token,
    body: { byte_length: bytes.length, sha256: sha, filename: '2026_10_24_BH3_37337[ABCDEF01].smsghost', user_id: BOB },
  })
  assert.equal(created.status, 201)
  assert.equal(created.body.upload.status, 'awaiting_content')
  assert.equal(created.body.upload.content_url, `https://example-ref.supabase.co/functions/v1/moonshine-api/v1/uploads/${created.body.upload.upload_id}/content`)
  const id = created.body.upload.upload_id

  const early = await app.request('POST', `/v1/uploads/${id}/publish`, { token })
  assert.deepEqual([early.status, early.body.error.code], [409, 'not_validated'])

  const put = await app.request('PUT', `/v1/uploads/${id}/content`, { token, body: bytes })
  assert.equal(put.status, 200, JSON.stringify(put.body))
  assert.equal(put.body.upload.status, 'validated')
  assert.equal(put.body.upload.validation.format_version, 9)

  const published = await app.request('POST', `/v1/uploads/${id}/publish`, { token })
  assert.equal(published.status, 201, JSON.stringify(published.body))
  const ghost = published.body.ghost
  assert.equal(ghost.author.id, ALICE) // never the user_id the client sent
  assert.equal(ghost.file.sha256, sha)
  assert.equal(ghost.file.byte_length, bytes.length)
  assert.equal(ghost.recording.initial_rng.seed, 0) // a zero seed is a real value
  assert.equal(ghost.site.level, 'Bianco Hills 3')
  assert.equal(ghost.site.time_ms, 37337)

  const stored = app.storage.archive.get(ghost.file.path)!
  assert.deepEqual(stored, bytes)
  assert.ok(ghost.file.path.startsWith(`${ALICE}/`))
  assert.equal(ghost.file.filename, '2026_10_24_BH3_37337_ABCDEF01_.smsghost')
  assert.equal(app.storage.staging.size, 0, 'staging copy removed after publish')

  // The website sees it like any other ghost.
  const row = await asUser<{ title: string; user_id: string; tags: string[] }>(app, null,
    `select title, user_id, tags from public.list_ghosts(p_limit => 5)`)
  assert.deepEqual(row, [{ title: 'Bianco Hills 3 - 0:37.337', user_id: ALICE, tags: ['any percent'] }])
  assert.equal((await app.request('GET', '/v1/ghosts')).body.items[0].id, ghost.id)
})

test('retrying any step never creates a duplicate', async () => {
  const app = await setup()
  const { access_token: token } = await app.linkDevice(ALICE)
  const bytes = buildGhost({ version: 6 })
  const sha = await sha256Hex(bytes)
  const create = (headers: Record<string, string> = {}) =>
    app.request('POST', '/v1/uploads', { token, headers, body: { byte_length: bytes.length, sha256: sha } })

  const a = await create({ 'idempotency-key': 'wii-0001' })
  const b = await create({ 'idempotency-key': 'wii-0001' })
  const c = await create()
  assert.deepEqual([a.status, b.status, c.status], [201, 200, 200])
  assert.equal(b.body.result, 'existing')
  assert.equal(new Set([a, b, c].map((r) => r.body.upload.upload_id)).size, 1)
  const id = a.body.upload.upload_id

  const other = buildGhost({ version: 6, ghostId: [7, 7] })
  const reused = await app.request('POST', '/v1/uploads', {
    token, headers: { 'idempotency-key': 'wii-0001' }, body: { byte_length: other.length, sha256: await sha256Hex(other) },
  })
  assert.deepEqual([reused.status, reused.body.error.code], [409, 'idempotency_key_reused'])

  assert.equal((await app.request('PUT', `/v1/uploads/${id}/content`, { token, body: bytes })).status, 200)
  assert.equal((await app.request('PUT', `/v1/uploads/${id}/content`, { token, body: bytes })).status, 200)

  // Storage hiccup during publish: retryable, nothing half-published.
  app.storage.failNextArchiveWrite = true
  const outage = await app.request('POST', `/v1/uploads/${id}/publish`, { token })
  assert.deepEqual([outage.status, outage.body.error.code, outage.body.error.retryable], [503, 'storage_unavailable', true])

  const p1 = await app.request('POST', `/v1/uploads/${id}/publish`, { token })
  const p2 = await app.request('POST', `/v1/uploads/${id}/publish`, { token })
  assert.deepEqual([p1.status, p2.status], [201, 200])
  assert.deepEqual([p1.body.result, p2.body.result], ['published', 'already_published'])
  assert.equal(p1.body.ghost.id, p2.body.ghost.id)

  // Starting over from scratch with the same bytes finds the published ghost.
  const fresh = await create({ 'idempotency-key': 'wii-0002' })
  assert.deepEqual([fresh.status, fresh.body.result, fresh.body.ghost.id], [200, 'already_published', p1.body.ghost.id])
  assert.equal((await app.request('PUT', `/v1/uploads/${id}/content`, { token, body: bytes })).body.error.code, 'upload_closed')

  const count = await app.admin(`select count(*)::int as n from public.ghosts`)
  assert.equal((count.rows[0] as { n: number }).n, 1)
  assert.equal(app.storage.archive.size, 1)
})

test('corrupt, truncated, unsupported and mismatched content is refused', async () => {
  const app = await setup()
  const { access_token: token } = await app.linkDevice(ALICE)

  const corrupt = buildGhost({ version: 9, ghostId: [8, 1] })
  corrupt[0x920] ^= 0x10
  const r1 = await uploadViaApi(app, token, corrupt)
  assert.deepEqual([r1.put.status, r1.put.body.error.code, r1.put.body.error.detail], [422, 'invalid_ghost', 'ghost file checksum mismatch'])
  const after = await app.request('GET', `/v1/uploads/${r1.id}`, { token })
  assert.deepEqual([after.body.upload.status, after.body.upload.error.code], ['rejected', 'invalid_ghost'])
  assert.equal((await app.request('POST', `/v1/uploads/${r1.id}/publish`, { token })).body.error.code, 'upload_closed')

  const truncated = buildGhost({ version: 8, ghostId: [8, 2] }).slice(0, 2400)
  assert.equal((await uploadViaApi(app, token, truncated)).put.body.error.detail, 'ghost file size does not match bytes')

  const v10 = finalize(Object.assign(buildGhost({ ghostId: [8, 3] }), { 5: 10 }))
  assert.equal((await uploadViaApi(app, token, v10)).put.body.error.code, 'unsupported_version')
  const v2 = Object.assign(buildGhost({ ghostId: [8, 4] }), { 5: 2 })
  assert.equal((await uploadViaApi(app, token, v2)).put.body.error.code, 'unsupported_version')
  const feature = finalize(Object.assign(buildGhost({ ghostId: [8, 5] }), { 27: 127 }))
  assert.equal((await uploadViaApi(app, token, feature)).put.body.error.code, 'unsupported_feature')

  // Transfer damage is retryable: the session stays open for a correct resend.
  const good = buildGhost({ version: 9, ghostId: [8, 6] })
  const created = await app.request('POST', '/v1/uploads', { token, body: { byte_length: good.length, sha256: await sha256Hex(good) } })
  const id = created.body.upload.upload_id
  const damaged = new Uint8Array(good)
  damaged[100] ^= 1
  const mismatch = await app.request('PUT', `/v1/uploads/${id}/content`, { token, body: damaged })
  assert.deepEqual([mismatch.status, mismatch.body.error.code, mismatch.body.error.retryable], [422, 'sha256_mismatch', true])
  const short = await app.request('PUT', `/v1/uploads/${id}/content`, { token, body: good.slice(0, 500) })
  assert.equal(short.body.error.code, 'length_mismatch')
  const long = new Uint8Array(good.length + 10)
  long.set(good)
  assert.equal((await app.request('PUT', `/v1/uploads/${id}/content`, { token, body: long, headers: { 'content-length': String(long.length) } })).body.error.code, 'length_mismatch')
  assert.equal((await app.request('PUT', `/v1/uploads/${id}/content`, { token, body: good })).status, 200)

  // Declared too large: refused before any bytes move.
  const big = await app.request('POST', '/v1/uploads', { token, body: { byte_length: 1_297_993, sha256: 'a'.repeat(64) } })
  assert.deepEqual([big.status, big.body.error.code], [413, 'too_large'])
  assert.equal((await app.request('POST', '/v1/uploads', { token, body: { byte_length: 10, sha256: 'xyz' } })).status, 400)
  assert.equal(app.storage.archive.size, 0)
})

test('users can only act on their own uploads; cross-account duplicates are refused', async () => {
  const app = await setup()
  const alice = await app.linkDevice(ALICE)
  const bob = await app.linkDevice(BOB)
  const bytes = buildGhost({ version: 7 })
  const mine = await uploadViaApi(app, alice.access_token, bytes)
  assert.equal(mine.published?.status, 201)

  for (const [method, suffix] of [['GET', ''], ['PUT', '/content'], ['POST', '/publish'], ['DELETE', '']] as const) {
    const res = await app.request(method, `/v1/uploads/${mine.id}${suffix}`, { token: bob.access_token, body: method === 'PUT' ? bytes : undefined })
    assert.deepEqual([res.status, res.body.error.code], [404, 'not_found'], `${method} ${suffix}`)
  }

  const copy = await app.request('POST', '/v1/uploads', { token: bob.access_token, body: { byte_length: bytes.length, sha256: await sha256Hex(bytes) } })
  assert.deepEqual([copy.status, copy.body.error.code, copy.body.error.ghost_id], [409, 'duplicate_content', mine.published!.body.ghost.id])

  // The same holds for bytes already on the website.
  const web = buildGhost({ version: 9, ghostId: [4, 4] })
  const webGhost = await websiteUpload(app, ALICE, web)
  await app.request('POST', `/v1/ghosts/${webGhost.id}/index`)
  const dupe = await app.request('POST', '/v1/uploads', { token: bob.access_token, body: { byte_length: web.length, sha256: await sha256Hex(web) } })
  assert.equal(dupe.body.error.code, 'duplicate_content')
  const own = await app.request('POST', '/v1/uploads', { token: alice.access_token, body: { byte_length: web.length, sha256: await sha256Hex(web) } })
  assert.deepEqual([own.body.result, own.body.ghost.id], ['already_published', webGhost.id])
})

test('abandoned sessions expire and their staging objects are swept', async () => {
  const app = await setup()
  const { access_token: token } = await app.linkDevice(ALICE)
  const bytes = buildGhost({ version: 5 })
  const created = await app.request('POST', '/v1/uploads', { token, body: { byte_length: bytes.length, sha256: await sha256Hex(bytes) } })
  const id = created.body.upload.upload_id
  await app.request('PUT', `/v1/uploads/${id}/content`, { token, body: bytes })
  assert.equal(app.storage.staging.size, 1)

  await app.admin(`update public.moonshine_uploads set expires_at = now() - interval '1 minute'`)
  assert.equal((await app.request('GET', `/v1/uploads/${id}`, { token })).body.upload.status, 'expired')
  assert.deepEqual([(await app.request('POST', `/v1/uploads/${id}/publish`, { token })).status], [410])

  // The next create sweeps; the same bytes can start a new session.
  const again = await app.request('POST', '/v1/uploads', { token, body: { byte_length: bytes.length, sha256: await sha256Hex(bytes) } })
  assert.equal(again.status, 201)
  assert.notEqual(again.body.upload.upload_id, id)
  assert.equal(app.storage.staging.size, 0)

  // Cancel is idempotent and frees the open-session budget.
  const cancel1 = await app.request('DELETE', `/v1/uploads/${again.body.upload.upload_id}`, { token })
  const cancel2 = await app.request('DELETE', `/v1/uploads/${again.body.upload.upload_id}`, { token })
  assert.deepEqual([cancel1.body.upload.status, cancel2.body.upload.status], ['cancelled', 'cancelled'])

  for (let i = 0; i < 5; i++) {
    const g = buildGhost({ version: 5, ghostId: [50, i] })
    assert.equal((await app.request('POST', '/v1/uploads', { token, body: { byte_length: g.length, sha256: await sha256Hex(g) } })).status, 201)
  }
  const sixth = buildGhost({ version: 5, ghostId: [50, 99] })
  const blocked = await app.request('POST', '/v1/uploads', { token, body: { byte_length: sixth.length, sha256: await sha256Hex(sixth) } })
  assert.deepEqual([blocked.status, blocked.body.error.code], [409, 'too_many_open_uploads'])
})

test('the 200-ghost limit applies to API uploads and leaves no orphaned object', async () => {
  const app = await setup()
  const { access_token: token } = await app.linkDevice(ALICE)
  await asUser(app, ALICE, `insert into public.ghosts (user_id, title, file_path, original_filename, file_size)
    select $1::uuid, 'filler ' || i, $1::text || '/' || gen_random_uuid() || '/f.smsghost', 'f.smsghost', 100 from generate_series(1, 200) i`, [ALICE])
  const r = await uploadViaApi(app, token, buildGhost({ version: 9 }))
  assert.deepEqual([r.published?.status, r.published?.body.error.code], [409, 'ghost_limit_reached'])
  assert.equal(app.storage.archive.size, 0)
})

// --- archive integrity ----------------------------------------------------------------

test('validated objects are immutable; changing a ghost file clears its validation', async () => {
  const app = await setup()
  const bytes = buildGhost({ version: 9 })
  const ghost = await websiteUpload(app, ALICE, bytes)
  await app.admin(`insert into storage.objects (bucket_id, name) values ('ghosts', $1)`, [ghost.path])
  const update = () => asUser(app, ALICE, `update storage.objects set owner = $1 where name = $2 returning name`, [ALICE, ghost.path])
  const remove = () => asUser(app, ALICE, `delete from storage.objects where name = $1 returning name`, [ghost.path])

  // Before validation the owner may overwrite in place (existing website behaviour).
  assert.equal((await update()).length, 1)
  await app.request('POST', `/v1/ghosts/${ghost.id}/index`)
  assert.equal((await update()).length, 0, 'overwrite of a validated object must be refused')
  assert.equal((await remove()).length, 0, 'deleting a validated object out from under its row must be refused')

  // Replacing the file the new way: point the row at a new object.
  const newPath = `${ALICE}/${ghost.id}/replacement.smsghost`
  await asUser(app, ALICE, `update public.ghosts set file_path = $1, file_size = 999 where id = $2`, [newPath, ghost.id])
  assert.equal(((await app.admin(`select count(*)::int as n from public.ghost_moonshine_index`)).rows[0] as { n: number }).n, 0)
  assert.equal((await app.request('GET', '/v1/ghosts')).body.total, 0)
  // The old object is no longer protected, so the website can clean it up.
  assert.equal((await remove()).length, 1)

  // Deleting the ghost removes its validation with it.
  const other = await websiteUpload(app, ALICE, buildGhost({ version: 8, ghostId: [6, 6] }))
  await app.request('POST', `/v1/ghosts/${other.id}/index`)
  await asUser(app, ALICE, `delete from public.ghosts where id = $1`, [other.id])
  assert.equal(((await app.admin(`select count(*)::int as n from public.ghost_moonshine_index`)).rows[0] as { n: number }).n, 0)
})
