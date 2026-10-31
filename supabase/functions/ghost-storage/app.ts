/**
 * ghost-storage: the website's only write path to the archive bucket.
 *
 * Runtime-agnostic, like moonshine-api/app.ts: Deno specifics live in index.ts
 * so the Node tests (supabase/tests/storage/) run this exact handler.
 *
 * The archive bucket is S3-compatible and knows nothing about Supabase users,
 * so the rules the Storage policies used to enforce (0002, 0008, 0012) are
 * enforced here instead, from the caller's verified JWT:
 *
 *   - keys are <auth.uid()>/<ghost-id>/<name>.smsghost, exactly two folders;
 *   - names pass safeFilename(); no traversal;
 *   - at most MAX_GHOST_BYTES, and the presigned PUT signs that exact size,
 *     the content type, and If-None-Match so an existing object is never
 *     replaced;
 *   - deleted accounts can neither upload nor delete (is_active_account());
 *   - a validated object (ghost_moonshine_index row) cannot be deleted, and
 *     nor can one a ghosts row still points at;
 *   - staff (0018) may delete an object in anyone's folder, under those same
 *     two rules, which is how a moderator-removed ghost's file is cleared.
 *
 * Downloads never come through here: they are plain GETs on the public URL.
 */
import { MAX_GHOST_BYTES, isOwnedGhostKey, isUuid, safeFilename } from '../_shared/ghost_paths.ts'
import type { S3Store } from '../_shared/s3.ts'

/** Presigned URLs are checked when the PUT starts, so this only bounds the start. */
export const PRESIGN_TTL_S = 900

export interface StorageDb {
  /** profiles.deleted_at is null for this id. */
  isActiveAccount(uid: string): Promise<boolean>
  /** A ghost_moonshine_index row records a verdict for this exact key. */
  isValidated(key: string): Promise<boolean>
  /** A ghosts row's file_path is this exact key. */
  isReferenced(key: string): Promise<boolean>
  /** This account is an admin or moderator (staff_role_of, 0018). */
  isStaff(uid: string): Promise<boolean>
}

export interface Deps {
  /** Returns the user id for a valid Supabase access token, else null. */
  verifyToken(token: string): Promise<string | null>
  db: StorageDb
  s3: S3Store
  log?: (message: string, detail?: unknown) => void
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Max-Age': '86400',
}

const STATUS: Record<string, number> = {
  invalid_request: 400,
  not_authenticated: 401,
  forbidden: 403,
  method_not_allowed: 405,
  object_exists: 409,
  in_use: 409,
  too_large: 413,
  internal: 500,
  storage_unavailable: 503,
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

class Refusal extends Error {
  code: string
  detail: string | undefined
  constructor(code: string, detail?: string) {
    super(code)
    this.code = code
    this.detail = detail
  }
}

function refuse(code: string, detail?: string): never {
  throw new Refusal(code, detail)
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text()
  if (text.length > 16 * 1024) refuse('invalid_request', 'body too long')
  try {
    const value = JSON.parse(text)
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    /* fall through */
  }
  refuse('invalid_request', 'body must be a JSON object')
}

export function createHandler(deps: Deps): (req: Request) => Promise<Response> {
  const { db, s3 } = deps
  const log = deps.log ?? (() => {})

  async function storage<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (err) {
      log(`${what} failed`, err)
      refuse('storage_unavailable')
    }
  }

  async function presignUpload(uid: string, body: Record<string, unknown>): Promise<Response> {
    const { ghost_id: ghostId, filename, byte_size: size } = body
    if (!isUuid(ghostId)) refuse('invalid_request', 'ghost_id must be a uuid')
    if (typeof filename !== 'string' || filename.length === 0 || filename.length > 255) {
      refuse('invalid_request', 'filename must be a non-empty string')
    }
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 1) {
      refuse('invalid_request', 'byte_size must be a positive integer')
    }
    if (size > MAX_GHOST_BYTES) refuse('too_large', `at most ${MAX_GHOST_BYTES} bytes`)

    // The key is built here from the verified uid; the client cannot choose the owner.
    const key = `${uid}/${ghostId.toLowerCase()}/${safeFilename(filename)}`
    if (!isOwnedGhostKey(key, uid)) refuse('invalid_request', 'filename is not usable')
    if ((await storage('head', () => s3.head(key))) !== null) refuse('object_exists')

    const signed = await s3.presignPut(key, size, PRESIGN_TTL_S)
    return json(200, { key, ...signed })
  }

  async function remove(uid: string, body: Record<string, unknown>): Promise<Response> {
    const { key } = body
    if (!isOwnedGhostKey(key, uid)) {
      // Staff clear the files of ghosts they removed; the owner is the key's first folder.
      const owner = typeof key === 'string' ? key.split('/')[0] : ''
      if (!isUuid(owner) || !isOwnedGhostKey(key, owner) || !(await db.isStaff(uid))) {
        refuse('forbidden', 'not a key in your own folder')
      }
    }
    // Mirrors the 0012 delete policy: a validated object is immutable.
    if (await db.isValidated(key)) refuse('in_use', 'this file has been validated for Moonshine')
    // Stricter than the old policy: never pull the file out from under a live row.
    if (await db.isReferenced(key)) refuse('in_use', 'a ghost still uses this file')
    await storage('delete', () => s3.remove(key))
    return json(200, { deleted: key })
  }

  async function route(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS })
    if (req.method !== 'POST') refuse('method_not_allowed')

    const token = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get('authorization') ?? '')?.[1]
    const uid = token ? await deps.verifyToken(token) : null
    if (!uid) refuse('not_authenticated')

    const body = await readJson(req)
    if (body.action !== 'presign-upload' && body.action !== 'delete') {
      refuse('invalid_request', 'action must be presign-upload or delete')
    }
    // Same rule as is_active_account() in the 0008 owner-write policies.
    if (!(await db.isActiveAccount(uid))) refuse('forbidden', 'account deleted')

    return body.action === 'presign-upload' ? presignUpload(uid, body) : remove(uid, body)
  }

  return async (req: Request): Promise<Response> => {
    try {
      return await route(req)
    } catch (err) {
      if (err instanceof Refusal) {
        return json(STATUS[err.code] ?? 500, { error: err.code, ...(err.detail ? { detail: err.detail } : {}) })
      }
      log('unhandled error', err)
      return json(500, { error: 'internal' })
    }
  }
}
