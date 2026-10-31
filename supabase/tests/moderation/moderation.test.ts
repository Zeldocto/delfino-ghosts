/**
 * Tests for moderation (0018): staff roles, removing and editing ghosts,
 * suspending accounts, the moderation log. Real SQL from every migration in
 * PGlite, called as the `authenticated` or `anon` role the way PostgREST
 * would, so grants and RLS are real.
 *
 *   npm run test:moderation
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PGlite } from '@electric-sql/pglite'
import { callAs, createApp, createDatabase } from '../moonshine/harness.ts'

const ADMIN = '11111111-1111-4111-8111-111111111111'
const MOD = '22222222-2222-4222-8222-222222222222'
const PLAYER = '33333333-3333-4333-8333-333333333333'
const OTHER = '44444444-4444-4444-8444-444444444444'

async function setup() {
  const db = await createDatabase()
  for (const [id, username] of [[ADMIN, 'Theo'], [MOD, 'modder'], [PLAYER, 'player'], [OTHER, 'other']]) {
    await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [
      id, `${username}@example.com`, JSON.stringify({ username }),
    ])
  }
  // The one manual step: the owner makes themself admin in the SQL editor.
  await db.query(`insert into public.staff (user_id, role) values ($1, 'admin')`, [ADMIN])
  return db
}

/** Runs SQL as a signed-in website user, or as a guest when uid is null. */
function as(db: PGlite, uid: string | null, query: string, params: unknown[] = []) {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid ?? ''])
    await tx.exec(`set local role ${uid ? 'authenticated' : 'anon'}`)
    return (await tx.query<Record<string, unknown>>(query, params)).rows
  })
}

const roleOf = async (db: PGlite, uid: string) =>
  (await as(db, uid, `select public.my_moderation_status() ->> 'role' as r`))[0].r

async function addGhost(db: PGlite, uid: string, title = 'run', downloads = 0) {
  const id = crypto.randomUUID()
  await as(db, uid, `insert into public.ghosts (id, user_id, title, file_path, original_filename, file_size)
                     values ($1, $2, $3, $4, 'g.smsghost', 10)`, [id, uid, title, `${uid}/${id}/g.smsghost`])
  if (downloads) {
    await db.query(`select set_config('delfino.counter_ctx', 'on', false)`)
    await db.query(`update public.ghosts set download_count = $2 where id = $1`, [id, downloads])
    await db.query(`update public.profiles set total_downloads = total_downloads + $2 where id = $1`, [uid, downloads])
    await db.query(`select set_config('delfino.counter_ctx', 'off', false)`)
  }
  return id
}

test('only the admin can make and unmake moderators, by username', async () => {
  const db = await setup()
  assert.equal(await roleOf(db, PLAYER), null)
  assert.equal(await roleOf(db, ADMIN), 'admin')

  await assert.rejects(as(db, PLAYER, `select public.set_moderator('player', true)`), /not_admin/)
  await as(db, ADMIN, `select public.set_moderator('  MODDER ', true)`) // case and spaces do not matter
  assert.equal(await roleOf(db, MOD), 'moderator')

  // A moderator cannot appoint others, and nobody can change an admin through the website.
  await assert.rejects(as(db, MOD, `select public.set_moderator('player', true)`), /not_admin/)
  await assert.rejects(as(db, ADMIN, `select public.set_moderator('Theo', false)`), /target_is_admin/)
  await assert.rejects(as(db, ADMIN, `select public.set_moderator('nobody-here', true)`), /user_not_found/)

  const staff = await as(db, MOD, `select username, role from public.list_staff()`)
  assert.deepEqual(staff, [{ username: 'Theo', role: 'admin' }, { username: 'modder', role: 'moderator' }])
  await assert.rejects(as(db, PLAYER, `select * from public.list_staff()`), /not_staff/)

  // Who is staff is public, so names can be marked for everyone, guests included.
  const directory = await as(db, null, `select username, role from public.staff_directory() order by lower(username)`)
  assert.deepEqual(directory, [{ username: 'modder', role: 'moderator' }, { username: 'Theo', role: 'admin' }])

  await as(db, ADMIN, `select public.set_moderator('modder', false)`)
  assert.equal(await roleOf(db, MOD), null)
  const log = await as(db, ADMIN, `select action, actor_username, target_username from public.moderation_log_recent()`)
  assert.deepEqual(log, [
    { action: 'remove_moderator', actor_username: 'Theo', target_username: 'modder' },
    { action: 'add_moderator', actor_username: 'Theo', target_username: 'modder' },
  ])
})

test('nobody reaches the moderation tables directly, and guests reach only the staff directory', async () => {
  const db = await setup()
  await assert.rejects(as(db, PLAYER, `insert into public.staff (user_id, role) values ($1, 'admin')`, [PLAYER]), /permission denied/)
  await assert.rejects(as(db, ADMIN, `select * from public.staff`), /permission denied/)
  await assert.rejects(as(db, ADMIN, `delete from public.moderation_log`), /permission denied/)
  await assert.rejects(as(db, PLAYER, `delete from public.account_suspensions`), /permission denied/)
  const signedIn = ['my_moderation_status()', 'moderator_remove_ghost(uuid, text)',
    'moderator_update_ghost(uuid, text, text, text, integer, boolean, text, text[], text)', 'suspend_account(text, text)',
    'unsuspend_account(text)', 'set_moderator(text, boolean)', 'staff_account_status(uuid)', 'list_staff()',
    'list_suspensions()', 'moderation_log_recent(integer)']
  const internal = ['staff_role_of(uuid)', 'staff_require(boolean)', 'staff_find_account(text)', 'account_is_active(uuid)']
  const can = async (role: string, fn: string) =>
    (await db.query<{ ok: boolean }>(`select has_function_privilege('${role}', 'public.${fn}', 'execute') as ok`)).rows[0].ok
  for (const fn of [...signedIn, ...internal]) assert.equal(await can('anon', fn), false, fn)
  for (const fn of internal) assert.equal(await can('authenticated', fn), false, fn)
  assert.equal(await can('anon', 'staff_directory()'), true)
})

test('a moderator removes anyone\'s ghost; totals follow and the log records it', async () => {
  const db = await setup()
  await as(db, ADMIN, `select public.set_moderator('modder', true)`)
  const ghost = await addGhost(db, PLAYER, 'bad upload', 7)
  const keep = await addGhost(db, PLAYER, 'fine upload', 3)

  await assert.rejects(as(db, OTHER, `select public.moderator_remove_ghost($1, 'no')`, [ghost]), /not_staff/)
  // An ordinary user still cannot delete someone else's row directly (RLS: zero rows).
  await as(db, OTHER, `delete from public.ghosts where id = $1`, [ghost])
  assert.equal((await db.query(`select 1 from public.ghosts where id = $1`, [ghost])).rows.length, 1)

  await assert.rejects(as(db, MOD, `select public.moderator_remove_ghost($1, $2)`, [ghost, 'x'.repeat(501)]), /reason_too_long/)
  const [{ r }] = await as(db, MOD, `select public.moderator_remove_ghost($1, '  not a ghost file ') as r`, [ghost])
  assert.deepEqual(r, { ghost_id: ghost, file_path: `${PLAYER}/${ghost}/g.smsghost` })
  assert.equal((await db.query(`select 1 from public.ghosts where id = $1`, [ghost])).rows.length, 0)
  assert.equal((await db.query(`select 1 from public.ghosts where id = $1`, [keep])).rows.length, 1)

  const { rows: [profile] } = await db.query<{ total_ghosts: number; total_downloads: number }>(
    `select total_ghosts, total_downloads from public.profiles where id = $1`, [PLAYER])
  assert.deepEqual([profile.total_ghosts, Number(profile.total_downloads)], [1, 3])

  const [entry] = await as(db, ADMIN, `select action, actor_username, target_username, ghost_title, file_path, reason
                                         from public.moderation_log_recent(1)`)
  assert.deepEqual(entry, {
    action: 'remove_ghost', actor_username: 'modder', target_username: 'player',
    ghost_title: 'bad upload', file_path: `${PLAYER}/${ghost}/g.smsghost`, reason: 'not a ghost file',
  })
  await assert.rejects(as(db, MOD, `select public.moderator_remove_ghost($1, null)`, [ghost]), /ghost_not_found/)
})

test('a moderator edits anyone\'s ghost details; owner and count stay put; changes are logged', async () => {
  const db = await setup()
  await as(db, ADMIN, `select public.set_moderator('modder', true)`)
  const ghost = await addGhost(db, PLAYER, 'Bianco 3 any%', 4)
  const edit = (uid: string, title: string, isTas: boolean, reason: string | null) =>
    as(db, uid, `select public.moderator_update_ghost($1, $2, null, 'Bianco Hills 3', 37337, $3, null, array['Bianco'], $4) as r`,
      [ghost, title, isTas, reason])

  await assert.rejects(edit(OTHER, 'hijacked', false, null), /not_staff/)
  // Nor can an ordinary user update it directly (RLS: zero rows).
  await as(db, OTHER, `update public.ghosts set title = 'hijacked' where id = $1`, [ghost])

  const [{ r }] = await edit(MOD, '  Bianco Hills 3 (TAS) ', true, 'mislabelled TAS')
  assert.deepEqual(r, { ghost_id: ghost, changed: true })
  const { rows: [row] } = await db.query<Record<string, unknown>>(
    `select user_id, title, is_tas, level, time_ms, tags, download_count from public.ghosts where id = $1`, [ghost])
  assert.deepEqual(row, {
    user_id: PLAYER, title: 'Bianco Hills 3 (TAS)', is_tas: true, level: 'Bianco Hills 3', time_ms: 37337,
    tags: ['bianco'], download_count: 4,
  })

  const [entry] = await as(db, ADMIN, `select action, actor_username, target_username, ghost_title, reason, details
                                         from public.moderation_log_recent(1)`)
  assert.deepEqual(entry, {
    action: 'edit_ghost', actor_username: 'modder', target_username: 'player', ghost_title: 'Bianco Hills 3 (TAS)',
    reason: 'mislabelled TAS',
    details: {
      title: { from: 'Bianco 3 any%', to: 'Bianco Hills 3 (TAS)' },
      is_tas: { from: false, to: true },
      level: { from: null, to: 'Bianco Hills 3' },
      time_ms: { from: null, to: 37337 },
      tags: { from: [], to: ['bianco'] },
    },
  })

  // Saving without changes writes nothing to the log.
  const [{ r: again }] = await edit(MOD, 'Bianco Hills 3 (TAS)', true, null)
  assert.deepEqual(again, { ghost_id: ghost, changed: false })
  assert.equal((await as(db, ADMIN, `select 1 from public.moderation_log_recent() where action = 'edit_ghost'`)).length, 1)
})

test('a suspended account is read-only until a moderator restores it', async () => {
  const db = await setup()
  await as(db, ADMIN, `select public.set_moderator('modder', true)`)
  const ghost = await addGhost(db, PLAYER, 'mine')
  const otherGhost = await addGhost(db, OTHER, 'theirs')

  await assert.rejects(as(db, OTHER, `select public.suspend_account('player', 'spam')`), /not_staff/)
  await assert.rejects(as(db, MOD, `select public.suspend_account('Theo', null)`), /target_is_staff/)
  await assert.rejects(as(db, ADMIN, `select public.suspend_account('modder', null)`), /target_is_staff/)
  await as(db, MOD, `select public.suspend_account('player', '  spam uploads ')`)
  await as(db, MOD, `select public.suspend_account('player', 'again')`) // already suspended: no second entry

  const [{ s }] = await as(db, PLAYER, `select public.my_moderation_status() as s`)
  const mine = s as { role: string | null; suspended: boolean; reason: string | null }
  assert.deepEqual([mine.role, mine.suspended, mine.reason], [null, true, 'spam uploads'])

  // Every write is refused, by the same policies the website and Moonshine go through.
  await assert.rejects(addGhost(db, PLAYER, 'new'), /row-level security/)
  await as(db, PLAYER, `update public.ghosts set title = 'changed' where id = $1`, [ghost])
  await as(db, PLAYER, `delete from public.ghosts where id = $1`, [ghost])
  await as(db, PLAYER, `update public.profiles set bio = 'changed' where id = $1`, [PLAYER])
  const { rows: [state] } = await db.query<{ title: string; bio: string | null }>(
    `select g.title, p.bio from public.ghosts g join public.profiles p on p.id = g.user_id where g.id = $1`, [ghost])
  assert.deepEqual(state, { title: 'mine', bio: null })
  await assert.rejects(as(db, PLAYER, `select public.record_authenticated_download($1)`, [otherGhost]), /not_authenticated/)
  await assert.rejects(as(db, PLAYER, `select public.moonshine_link_lookup('BCDF-GHJK')`), /not_authenticated/)
  await assert.rejects(as(db, ADMIN, `select public.set_moderator('player', true)`), /target_is_suspended/)

  const [{ s: seen }] = await as(db, MOD, `select public.staff_account_status($1) as s`, [PLAYER])
  const status = seen as { suspended: boolean; reason: string | null; suspended_by_username: string | null }
  assert.deepEqual([status.suspended, status.reason, status.suspended_by_username], [true, 'spam uploads', 'modder'])
  assert.deepEqual(await as(db, MOD, `select username, reason from public.list_suspensions()`), [{ username: 'player', reason: 'spam uploads' }])
  await assert.rejects(as(db, OTHER, `select public.staff_account_status($1)`, [PLAYER]), /not_staff/)

  await as(db, MOD, `select public.unsuspend_account('player')`)
  await addGhost(db, PLAYER, 'back again')
  const log = await as(db, ADMIN, `select action, actor_username, target_username, reason from public.moderation_log_recent()
                                    where action like '%suspend%'`)
  assert.deepEqual(log, [
    { action: 'unsuspend_account', actor_username: 'modder', target_username: 'player', reason: null },
    { action: 'suspend_account', actor_username: 'modder', target_username: 'player', reason: 'spam uploads' },
  ])
})

test('a suspended account can still delete itself', async () => {
  const db = await setup()
  await as(db, ADMIN, `select public.suspend_account('player', null)`)
  await as(db, PLAYER, `select public.delete_own_account()`)
  assert.equal((await db.query(`select 1 from auth.users where id = $1`, [PLAYER])).rows.length, 0)
  assert.equal((await db.query(`select 1 from public.account_suspensions where user_id = $1`, [PLAYER])).rows.length, 0)
})

test('a suspended account\'s linked Moonshine devices stop working, and work again after', async () => {
  const app = await createApp()
  await app.createUser(ADMIN, 'Theo')
  await app.createUser(PLAYER, 'player')
  await app.admin(`insert into public.staff (user_id, role) values ($1, 'admin')`, [ADMIN])
  const { access_token: token } = await app.linkDevice(PLAYER)
  assert.equal((await app.request('GET', '/v1/me', { token })).status, 200)

  await callAs(app.db, 'authenticated', ADMIN, 'suspend_account', { p_username: 'player', p_reason: null })
  const refused = await app.request('GET', '/v1/me', { token })
  assert.deepEqual([refused.status, refused.body.error.code], [401, 'invalid_token'])

  await callAs(app.db, 'authenticated', ADMIN, 'unsuspend_account', { p_username: 'player' })
  assert.equal((await app.request('GET', '/v1/me', { token })).status, 200)
})

test('a deleted account loses its role; the log keeps its anonymised name', async () => {
  const db = await setup()
  await as(db, ADMIN, `select public.set_moderator('modder', true)`)
  const ghost = await addGhost(db, PLAYER)
  await as(db, MOD, `select public.moderator_remove_ghost($1, null)`, [ghost])

  await db.query(`delete from auth.users where id = $1`, [MOD]) // fires the 0008 anonymisation
  assert.equal((await db.query(`select 1 from public.staff where user_id = $1`, [MOD])).rows.length, 0)
  const staff = await as(db, ADMIN, `select username from public.list_staff()`)
  assert.deepEqual(staff, [{ username: 'Theo' }])
  const [entry] = await as(db, ADMIN, `select actor_username from public.moderation_log_recent(1)`)
  assert.match(entry.actor_username as string, /^anonymous-\d+$/)
})
