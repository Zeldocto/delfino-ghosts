/**
 * Test harness: an in-process PostgreSQL (PGlite) loaded with the Supabase
 * stand-ins and every migration in order, an in-memory object store, and the
 * Moonshine API handler wired to both. Nothing here touches a real project.
 */
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHandler, DbError, type ObjectStore } from '../../functions/moonshine-api/app.ts'

const root = resolve(import.meta.dirname, '..', '..')
const sql = (path: string) => readFileSync(resolve(root, path), 'utf8')

export const MIGRATIONS = [
  'migrations/0001_init.sql',
  'migrations/0002_storage.sql',
  'migrations/0003_no_self_downloads.sql',
  'migrations/0004_level_and_time.sql',
  'migrations/0005_fix_avatar_url_check.sql',
  'migrations/0006_level_filter.sql',
  'migrations/0007_levels_in_use_per_user.sql',
  'migrations/0008_account_deletion.sql',
  'migrations/0009_purge_auth_logs_on_deletion.sql',
  'migrations/0010_ghost_size_10mb.sql',
  'migrations/0011_tas_filter.sql',
  'migrations/0012_moonshine_api.sql',
  'migrations/0013_moonshine_retention.sql',
  'migrations/0014_moonshine_route_sort.sql',
  'migrations/0015_size_100mb.sql',
  'migrations/0016_original_filename_shape.sql',
]

// Grants Supabase gives its roles that the plain stubs do not.
const SERVICE_ROLE_SETUP = `
  alter role service_role bypassrls;
  grant usage on schema storage to anon, authenticated;
  grant select, insert, update, delete on storage.objects to authenticated;
  grant usage on schema public, storage, auth to service_role;
  alter default privileges in schema public grant all on tables to service_role;
  alter default privileges in schema public grant all on sequences to service_role;
`

export async function createDatabase(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } })
  await db.exec(sql('tests/local_stubs.sql'))
  await db.exec(SERVICE_ROLE_SETUP)
  for (const file of MIGRATIONS) {
    try {
      await db.exec(sql(file))
    } catch (err) {
      throw new Error(`${file}: ${(err as Error).message}`)
    }
  }
  return db
}

const SET_RETURNING = new Set(['moonshine_uploads_claim_cleanup', 'moonshine_my_device_links'])

/** Calls public.<fn>(named args) as `role`, returning what PostgREST would. */
export async function callAs(
  db: PGlite,
  role: 'service_role' | 'authenticated' | 'anon',
  uid: string | null,
  fn: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!/^[a-z_][a-z0-9_]*$/.test(fn)) throw new Error(`bad function name ${fn}`)
  const names = Object.keys(args)
  const params = names.map((name) => {
    const value = args[name]
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? JSON.stringify(value) : value
  })
  const call = `public.${fn}(${names.map((name, i) => `${name} => $${i + 1}`).join(', ')})`
  const query = SET_RETURNING.has(fn)
    ? `select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) as r from ${call} t`
    : `select to_jsonb(${call}) as r`
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid ?? ''])
    await tx.exec(`set local role ${role}`)
    try {
      const result = await tx.query<{ r: unknown }>(query, params)
      return result.rows[0]?.r ?? null
    } catch (err) {
      const e = err as { message: string; code?: string }
      throw new DbError(e.message, e.code ?? '')
    }
  })
}

export class MemoryStore implements ObjectStore {
  staging = new Map<string, Uint8Array>()
  archive = new Map<string, Uint8Array>()
  failNextArchiveWrite = false

  async putStaging(path: string, bytes: Uint8Array) {
    this.staging.set(path, new Uint8Array(bytes))
  }
  async getStaging(path: string) {
    return this.staging.get(path) ?? null
  }
  async removeStaging(paths: string[]) {
    for (const p of paths) this.staging.delete(p)
  }
  async putArchive(path: string, bytes: Uint8Array) {
    if (this.failNextArchiveWrite) {
      this.failNextArchiveWrite = false
      throw new Error('simulated storage outage')
    }
    this.archive.set(path, new Uint8Array(bytes))
  }
  async getArchive(path: string) {
    return this.archive.get(path) ?? null
  }
  async removeArchive(path: string) {
    this.archive.delete(path)
  }
}

export const SUPABASE_URL = 'https://example-ref.supabase.co'
export const API = `${SUPABASE_URL}/functions/v1/moonshine-api`
/** Public base of the archive bucket (GHOSTS_PUBLIC_BASE_URL in production). */
export const ARCHIVE_BASE_URL = 'https://ghosts.example.org'

export async function createApp() {
  const db = await createDatabase()
  const storage = new MemoryStore()
  const logs: string[] = []
  const handler = createHandler({
    db: { rpc: (fn, args) => callAs(db, 'service_role', null, fn, args) },
    storage,
    archiveBaseUrl: ARCHIVE_BASE_URL,
    apiBaseUrl: API,
    siteUrl: 'https://zeldocto.github.io/delfino-ghosts',
    rateSalt: 'test-salt',
    log: (message) => logs.push(message),
  })

  async function request(
    method: string,
    path: string,
    options: { body?: unknown; token?: string; headers?: Record<string, string>; ip?: string } = {},
  ) {
    const headers: Record<string, string> = { 'x-forwarded-for': options.ip ?? '203.0.113.7', ...options.headers }
    let body: BodyInit | undefined
    if (options.body instanceof Uint8Array) {
      body = options.body as BodyInit
      headers['content-type'] ??= 'application/octet-stream'
      headers['content-length'] ??= String(options.body.length)
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body)
      headers['content-type'] = 'application/json'
    }
    if (options.token) headers.authorization = `Bearer ${options.token}`
    const response = await handler(new Request(`${API}${path}`, { method, headers, body }))
    const text = await response.text()
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null }
  }

  /** Runs SQL as the postgres superuser (fixture setup, clock travel). */
  const admin = (query: string, params: unknown[] = []) => db.query(query, params)

  /** Creates an auth user (the signup trigger makes the profile). */
  async function createUser(id: string, username: string) {
    await admin(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [
      id,
      `${username}@example.com`,
      JSON.stringify({ username }),
    ])
    return id
  }

  /** Links a device for `uid` through the real flow and returns its tokens. */
  async function linkDevice(uid: string, clientName = 'Moonshine Wii') {
    // A fresh client address per link, so tests are not throttled by the per-IP start limit.
    const ip = `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`
    const start = await request('POST', '/v1/device/code', { body: { client_name: clientName, client_version: '0.9.0' }, ip })
    const decided = (await callAs(db, 'authenticated', uid, 'moonshine_link_decide', {
      p_user_code: start.body.user_code,
      p_approve: true,
    })) as Record<string, unknown>
    if (decided.status !== 'approved') throw new Error(`approve failed: ${JSON.stringify(decided)}`)
    const token = await request('POST', '/v1/device/token', { body: { device_code: start.body.device_code } })
    if (token.status !== 200) throw new Error(`token failed: ${JSON.stringify(token.body)}`)
    return token.body as { access_token: string; refresh_token: string; link_id: string }
  }

  return { db, storage, logs, handler, request, admin, createUser, linkDevice }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}
