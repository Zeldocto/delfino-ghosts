/**
 * Moonshine ghost-sharing API: HTTP routing and request handling.
 *
 * Runtime-agnostic on purpose. Everything Deno- or Supabase-specific is behind
 * the `Deps` interface, so the same handler runs in the Edge Function
 * (index.ts) and in the Node tests (supabase/tests/moonshine/).
 *
 * The database holds every rule that matters (who may do what, limits, state
 * transitions) in SQL functions from migration 0012. This file does the parts
 * Postgres cannot: generating secrets, reading request bodies, validating ghost
 * bytes, and moving objects in Storage.
 */
import {
  MOONSHINE_MAX_FILE_BYTES,
  SUPPORTED_VERSIONS,
  VALIDATOR_ID,
  classifyGhost,
  featureNames,
  indexFields,
  type ValidatedGhost,
} from '../_shared/ghost_format.ts'

export const API_VERSION = 1
export const CATALOGUE_SCHEMA = 1
export const UPSTREAM_SPEC = 'Moonshine PR27, 2026-10-24 (ghost_format.h, ghost_format.md, validate_ghost.py)'

// --- dependencies --------------------------------------------------------------

export class DbError extends Error {
  code: string
  constructor(message: string, code = '') {
    super(message)
    this.name = 'DbError'
    this.code = code
  }
}

export interface Db {
  /** Calls a public.* SQL function with named arguments as the service role. */
  rpc(fn: string, args: Record<string, unknown>): Promise<unknown>
}

export interface ObjectStore {
  putStaging(path: string, bytes: Uint8Array): Promise<void>
  getStaging(path: string): Promise<Uint8Array | null>
  removeStaging(paths: string[]): Promise<void>
  putArchive(path: string, bytes: Uint8Array): Promise<void>
  getArchive(path: string): Promise<Uint8Array | null>
  removeArchive(path: string): Promise<void>
}

export interface Deps {
  db: Db
  storage: ObjectStore
  /** e.g. https://cvadewafbthfhvzgdgay.supabase.co */
  supabaseUrl: string
  /** Public base of this function, e.g. https://<ref>.supabase.co/functions/v1/moonshine-api */
  apiBaseUrl: string
  /** The website, e.g. https://zeldocto.github.io/delfino-ghosts */
  siteUrl: string
  /** Secret mixed into rate-limit keys so stored keys cannot be reversed to IPs. */
  rateSalt: string
  log?: (message: string, detail?: unknown) => void
}

// --- small utilities -------------------------------------------------------------

const encoder = new TextEncoder()

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomToken(prefix: string): string {
  return prefix + base64url(crypto.getRandomValues(new Uint8Array(32)))
}

// No vowels (no accidental words), no 0/O/1/I confusion.
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'

export function randomUserCode(): string {
  const out: string[] = []
  // Rejection sampling keeps the distribution uniform.
  while (out.length < 8) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < 240 && out.length < 8) out.push(USER_CODE_ALPHABET[b % 20])
    }
  }
  return `${out.slice(0, 4).join('')}-${out.slice(4).join('')}`
}

export function normalizeUserCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Same rules as the website's safeFilename() in src/lib/ghost/GhostStorage.ts. */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'ghost.smsghost'
  const cleaned = base
    .replace(/\.smsghost$/i, '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^[._-]+/, '')
    .slice(0, 96)
  return `${cleaned || 'ghost'}.smsghost`
}

/** Public, unsigned, non-expiring Storage URL for an archive object. */
export function archiveUrl(supabaseUrl: string, path: string): string {
  return `${supabaseUrl}/storage/v1/object/public/ghosts/${path.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * Mirrors splitRunLabel() in src/lib/ghost/GhostMetadata.ts so an API upload
 * gets the same website level/time/TAS display fields as a browser upload.
 * These are display columns only; the API never uses them for identity.
 */
export function splitRunLabel(label: string): { level: string | null; timeMs: number | null; isTas: boolean } {
  let text = label.trim()
  const tasPrefix = /^TAS\b[\s:-]*/i.exec(text)
  if (tasPrefix) text = text.slice(tasPrefix[0].length)
  const match = /^(.*?)\s*[-–—]\s*((?:\d+:)?(?:\d+:)?\d+(?:\.\d{1,3})?)$/.exec(text)
  if (!match) return { level: null, timeMs: null, isTas: tasPrefix !== null }
  let total = 0
  for (const part of match[2].split(':')) total = total * 60 + Number(part)
  const ms = Math.round(total * 1000)
  return {
    level: match[1].trim().slice(0, 48) || null,
    timeMs: ms > 0 && ms <= 86_400_000 ? ms : null,
    isTas: tasPrefix !== null,
  }
}

// --- responses ---------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, idempotency-key, apikey, x-client-info',
  'Access-Control-Expose-Headers': 'retry-after, location',
  'Access-Control-Max-Age': '86400',
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  })
}

interface ErrorSpec {
  status: number
  retryable: boolean
  message: string
}

/** Every error code the API can return. Documented in MOONSHINE-INTEGRATION.md. */
export const ERRORS: Record<string, ErrorSpec> = {
  invalid_request:        { status: 400, retryable: false, message: 'The request is malformed or a field is invalid.' },
  invalid_parameter:      { status: 400, retryable: false, message: 'A query parameter is invalid.' },
  authorization_pending:  { status: 400, retryable: true,  message: 'The player has not approved this code yet. Poll again after `interval` seconds.' },
  slow_down:              { status: 400, retryable: true,  message: 'Polling too fast. The interval has been increased; wait `interval` seconds.' },
  expired_token:          { status: 400, retryable: false, message: 'The link code expired. Start linking again.' },
  access_denied:          { status: 400, retryable: false, message: 'The player denied or revoked this link. Start linking again if they want to link.' },
  invalid_grant:          { status: 400, retryable: false, message: 'The device code or refresh token is not valid. Start linking again.' },
  invalid_token:          { status: 401, retryable: false, message: 'Missing or invalid access token. Refresh it, or link the device again.' },
  token_expired:          { status: 401, retryable: true,  message: 'The access token expired. Use the refresh token, then retry.' },
  not_found:              { status: 404, retryable: false, message: 'Not found.' },
  route_not_found:        { status: 404, retryable: false, message: 'No such endpoint.' },
  object_missing:         { status: 404, retryable: false, message: 'The archive row exists but its file is missing from Storage.' },
  method_not_allowed:     { status: 405, retryable: false, message: 'Method not allowed on this endpoint.' },
  duplicate_content:      { status: 409, retryable: false, message: 'Another account has already published a ghost with these exact bytes.' },
  idempotency_key_reused: { status: 409, retryable: false, message: 'This Idempotency-Key was already used for different content.' },
  upload_closed:          { status: 409, retryable: false, message: 'This upload session no longer accepts content (published, rejected or cancelled).' },
  not_validated:          { status: 409, retryable: false, message: 'Send valid content before publishing.' },
  content_missing:        { status: 409, retryable: false, message: 'The staged content is gone. PUT the content again, then publish.' },
  ghost_limit_reached:    { status: 409, retryable: false, message: 'This account already holds the 200-ghost maximum.' },
  too_many_open_uploads:  { status: 409, retryable: true,  message: 'Too many unfinished uploads. Publish or cancel one, or wait for one to expire.' },
  too_many_devices:       { status: 409, retryable: false, message: 'This account already has the maximum number of linked devices.' },
  stale:                  { status: 409, retryable: true,  message: 'The ghost changed while it was being read. Retry.' },
  upload_expired:         { status: 410, retryable: false, message: 'This upload session expired. Create a new one.' },
  too_large:              { status: 413, retryable: false, message: `Ghosts offered to Moonshine are at most ${MOONSHINE_MAX_FILE_BYTES} bytes.` },
  length_mismatch:        { status: 422, retryable: true,  message: 'The body length differs from the byte_length declared for this upload. Resend the exact file.' },
  sha256_mismatch:        { status: 422, retryable: true,  message: 'The body does not match the sha256 declared for this upload. Resend the exact file.' },
  invalid_ghost:          { status: 422, retryable: false, message: 'The file is not a valid canonical SGHF ghost.' },
  unsupported_version:    { status: 422, retryable: false, message: 'The ghost format version is not supported by this service.' },
  unsupported_feature:    { status: 422, retryable: false, message: 'The ghost requires a format feature this service does not support.' },
  rate_limited:           { status: 429, retryable: true,  message: 'Too many requests. Wait `retry_after_s` seconds.' },
  too_many_attempts:      { status: 429, retryable: false, message: 'Too many content attempts for this upload. Create a new one.' },
  internal:               { status: 500, retryable: true,  message: 'Unexpected server error. Retry with backoff.' },
  storage_unavailable:    { status: 503, retryable: true,  message: 'Storage did not respond. Retry with backoff.' },
}

function error(code: string, extra: Record<string, unknown> = {}, detail?: string | null): Response {
  const spec = ERRORS[code] ?? ERRORS.internal
  const body: Record<string, unknown> = { code: ERRORS[code] ? code : 'internal', message: spec.message, retryable: spec.retryable }
  if (detail) body.detail = detail
  Object.assign(body, extra)
  const headers: Record<string, string> = {}
  const retryAfter = (extra.retry_after_s ?? extra.interval) as number | undefined
  if (spec.retryable && typeof retryAfter === 'number') headers['Retry-After'] = String(retryAfter)
  if (spec.status === 401) headers['WWW-Authenticate'] = `Bearer error="${code === 'token_expired' ? 'invalid_token' : code}"`
  return json(spec.status, { error: body }, headers)
}

class HttpError extends Error {
  response: Response
  constructor(response: Response) {
    super('http error')
    this.response = response
  }
}

function fail(code: string, extra: Record<string, unknown> = {}, detail?: string | null): never {
  throw new HttpError(error(code, extra, detail))
}

/** Maps a `{error: ...}` result from a SQL function to a thrown HTTP error. */
function check<T extends Record<string, unknown>>(result: unknown): T {
  const value = (result ?? {}) as Record<string, unknown>
  if (typeof value.error === 'string') {
    const { error: code, detail, ...extra } = value
    fail(code as string, extra, (detail as string | undefined) ?? null)
  }
  return value as T
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await readBody(req, 16 * 1024).then((b) => new TextDecoder().decode(b))
  if (!text.trim()) return {}
  try {
    const value = JSON.parse(text)
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    /* fall through */
  }
  fail('invalid_request', {}, 'body must be a JSON object')
}

/** Reads at most `limit` bytes; one byte more means the body is too long. */
async function readBody(req: Request, limit: number): Promise<Uint8Array> {
  if (!req.body) return new Uint8Array(0)
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > limit) {
      await reader.cancel().catch(() => {})
      throw new BodyTooLong()
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

class BodyTooLong extends Error {}

function optionalString(body: Record<string, unknown>, key: string, max: number): string | null {
  const value = body[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length > max) fail('invalid_request', {}, `${key} must be a string of at most ${max} characters`)
  return value
}

function clientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  return req.headers.get('cf-connecting-ip') ?? req.headers.get('x-real-ip') ?? 'unknown'
}

// --- the handler -------------------------------------------------------------------

interface AuthContext {
  link_id: string
  user_id: string
  user: { id: string; username: string; display_name: string | null }
}

export function createHandler(deps: Deps): (req: Request) => Promise<Response> {
  const { db, storage } = deps
  const log = deps.log ?? (() => {})

  async function rateKey(req: Request): Promise<string> {
    return sha256Hex(`${deps.rateSalt}:${clientIp(req)}`)
  }

  async function authenticate(req: Request): Promise<AuthContext> {
    const header = req.headers.get('authorization') ?? ''
    const match = /^Bearer\s+(dga_[A-Za-z0-9_-]{20,})\s*$/.exec(header)
    if (!match) fail('invalid_token', {}, 'send Authorization: Bearer <access_token>')
    return check<AuthContext & Record<string, unknown>>(
      await db.rpc('moonshine_authenticate', { p_access_hash: await sha256Hex(match[1]) }),
    )
  }

  function decorateEntry(entry: Record<string, unknown>): Record<string, unknown> {
    const file = entry.file as Record<string, unknown>
    return {
      ...entry,
      file: { ...file, download_url: archiveUrl(deps.supabaseUrl, file.path as string) },
      page_url: `${deps.siteUrl}/ghost/${entry.id}`,
    }
  }

  async function ghostResponse(id: string): Promise<Record<string, unknown> | null> {
    const result = (await db.rpc('moonshine_get_ghost', { p_id: id })) as Record<string, unknown> | null
    if (!result) return null
    if (result.compatible) return decorateEntry(result.entry as Record<string, unknown>)
    return result
  }

  // GET /v1/capabilities -------------------------------------------------------
  async function capabilities(): Promise<Response> {
    const cfg = (await db.rpc('moonshine_config', {})) as Record<string, number>
    const base = deps.apiBaseUrl
    return json(200, {
      api_version: API_VERSION,
      catalogue_schema: CATALOGUE_SCHEMA,
      service: 'delfino-ghosts',
      api_base_url: base,
      website_url: deps.siteUrl,
      formats: [
        {
          magic: 'SGHF',
          extension: '.smsghost',
          versions: [...SUPPORTED_VERSIONS],
          current_version: 9,
          required_features_by_version: { 3: 0, 4: 1, 5: 3, 6: 7, 7: 15, 8: 31, 9: 63 },
          feature_names: Object.fromEntries([1, 2, 4, 8, 16, 32].map((bit) => [bit, featureNames(bit)[0]])),
          validator: VALIDATOR_ID,
          upstream_spec: UPSTREAM_SPEC,
          unknown_versions: 'rejected (unsupported_version)',
          unknown_required_features: 'rejected (unsupported_feature)',
        },
      ],
      limits: {
        max_upload_bytes: cfg.max_upload_bytes,
        max_download_bytes: MOONSHINE_MAX_FILE_BYTES,
        page_size_default: cfg.page_size_default,
        page_size_max: cfg.page_size_max,
        upload_session_ttl_s: cfg.upload_session_ttl_s,
        max_open_uploads: cfg.max_open_uploads,
        max_content_attempts: cfg.max_content_attempts,
        upload_creates_per_hour: cfg.upload_creates_per_hour,
        device_code_ttl_s: cfg.device_code_ttl_s,
        device_poll_interval_s: cfg.device_poll_interval_s,
        device_poll_interval_max_s: cfg.device_poll_interval_max_s,
        device_starts_per_10min: cfg.device_starts_per_10min,
        access_token_ttl_s: cfg.access_token_ttl_s,
        refresh_token_ttl_s: cfg.refresh_token_ttl_s,
        max_linked_devices: cfg.max_linked_devices,
        archive_ghost_limit_per_account: 200,
      },
      auth: {
        catalogue: 'none',
        downloads: 'none',
        uploads: 'Authorization: Bearer <access_token> from device linking',
        client_key_required: false,
        device_authorization_url: `${base}/v1/device/code`,
        token_url: `${base}/v1/device/token`,
        refresh_url: `${base}/v1/device/refresh`,
        revoke_url: `${base}/v1/device/revoke`,
        verification_uri: `${deps.siteUrl}/link`,
      },
      downloads: {
        url_field: 'file.download_url',
        redirects: false,
        signed: false,
        expires: false,
        range_requests: true,
        content_type: 'application/octet-stream',
        integrity: 'compare file.sha256 and file.byte_length after download',
      },
      catalogue: {
        sorts: ['newest', 'oldest', 'result_qf', 'route'],
        filters: ['route_key', 'area', 'episode', 'region', 'playable_on', 'source_profile', 'assistance', 'format_version', 'author', 'sha256'],
        assistance_values: ['tas', 'assisted', 'unknown'],
        compatible_only: true,
      },
    })
  }

  // GET /v1/ghosts ---------------------------------------------------------------
  async function listGhosts(url: URL): Promise<Response> {
    const q = url.searchParams
    const int = (name: string, min: number, max: number): number | null => {
      const raw = q.get(name)
      if (raw === null || raw === '') return null
      if (!/^-?\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) fail('invalid_parameter', { parameter: name })
      return Number(raw)
    }
    const str = (name: string, re: RegExp): string | null => {
      const raw = q.get(name)
      if (raw === null || raw === '') return null
      if (!re.test(raw)) fail('invalid_parameter', { parameter: name })
      return raw
    }
    const args = {
      p_route_key: str('route_key', /^[0-9a-f]{2}\.\d\.[0-9a-f]{2}\.[0-9a-f]{2}\.-?\d{1,3}$/),
      p_area: int('area', 0, 255),
      p_episode: int('episode', 0, 255),
      p_region: str('region', /^(jp|us|pal)$/),
      p_playable_on: str('playable_on', /^(jp|us|pal)$/),
      p_source_profile: int('source_profile', 0, 255),
      p_assistance: str('assistance', /^(tas|assisted|unknown)$/),
      p_format_version: int('format_version', 0, 65535),
      p_author: str('author', /^[A-Za-z0-9_-]{1,24}$/),
      p_sha256: str('sha256', /^[0-9a-fA-F]{64}$/),
      p_sort: str('sort', /^(newest|oldest|result_qf|route)$/) ?? 'newest',
      // Opaque to clients. Shape: sort letter ~ sort key(s) ~ last id [~ filter hash] (0014).
      p_cursor: str('cursor', /^[nora]~-?\d{1,20}(?:\.-?\d{1,20}){0,5}~[0-9a-f-]{36}(?:~[0-9a-f]{8})?$/),
      p_limit: int('limit', 1, 50),
    }
    let page: Record<string, unknown>
    try {
      page = (await db.rpc('moonshine_list_ghosts', args)) as Record<string, unknown>
    } catch (err) {
      if (err instanceof DbError && err.code === '22023') {
        const parameter = /^invalid_parameter: (\w+)$/.exec(err.message)?.[1]
        fail('invalid_parameter', parameter ? { parameter } : {}, err.message)
      }
      throw err
    }
    const items = (page.items as Record<string, unknown>[]).map(decorateEntry)
    return json(200, {
      api_version: API_VERSION,
      catalogue_schema: CATALOGUE_SCHEMA,
      items,
      next_cursor: page.next_cursor ?? null,
      total: page.total,
      limit: page.limit,
      sort: page.sort,
    })
  }

  // POST /v1/ghosts/{id}/index ------------------------------------------------------
  // Public and idempotent: validates the ghost's *stored* bytes, so the caller
  // cannot influence the result. The website calls it after every upload.
  async function indexGhost(req: Request, id: string, force: boolean): Promise<Response> {
    const rate = (await db.rpc('moonshine_rate_limit_hit', {
      p_bucket: 'index', p_key: await rateKey(req), p_limit: 300, p_window_s: 3600,
    })) as { allowed: boolean; retry_after_s: number }
    if (!rate.allowed) fail('rate_limited', { retry_after_s: rate.retry_after_s })

    const candidate = (await db.rpc('moonshine_index_candidate', { p_ghost_id: id })) as
      | { file_path: string; file_size: number; indexed: boolean; status: string | null }
      | null
    if (!candidate) fail('not_found')
    if (candidate.indexed && !force) {
      return json(200, { ghost_id: id, status: candidate.status, compatible: candidate.status === 'compatible', reindexed: false })
    }

    let bytes: Uint8Array | null
    try {
      bytes = await storage.getArchive(candidate.file_path)
    } catch (err) {
      log('index: storage read failed', err)
      fail('storage_unavailable')
    }
    if (!bytes) fail('object_missing')
    if (bytes.length !== candidate.file_size) fail('stale', {}, 'stored object size differs from the ghost row')

    const outcome = classifyGhost(bytes)
    const result = (await db.rpc('moonshine_index_put', {
      p_ghost_id: id,
      p_file_path: candidate.file_path,
      p_byte_length: bytes.length,
      p_sha256: await sha256Hex(bytes),
      p_status: outcome.status,
      p_code: outcome.code,
      p_detail: outcome.detail,
      p_validator: VALIDATOR_ID,
      p_source: 'website',
      p_fields: outcome.ghost ? indexFields(outcome.ghost) : {},
    })) as Record<string, unknown>
    check(result)
    return json(200, {
      ghost_id: id,
      status: outcome.status,
      compatible: outcome.status === 'compatible',
      code: outcome.code,
      detail: outcome.detail,
      reindexed: true,
    })
  }

  // POST /v1/device/code --------------------------------------------------------------
  async function deviceCode(req: Request): Promise<Response> {
    const body = await readJson(req)
    const clientName = optionalString(body, 'client_name', 48) ?? 'Moonshine'
    const clientVersion = optionalString(body, 'client_version', 32)
    if (!/^[ -~]+$/.test(clientName) || (clientVersion !== null && !/^[ -~]+$/.test(clientVersion))) {
      fail('invalid_request', {}, 'client_name and client_version must be printable ASCII')
    }
    const key = await rateKey(req)
    for (let attempt = 0; attempt < 3; attempt++) {
      const deviceCode = randomToken('dgd_')
      const userCode = randomUserCode()
      const result = (await db.rpc('moonshine_device_start', {
        p_device_code_hash: await sha256Hex(deviceCode),
        p_user_code_hash: await sha256Hex(normalizeUserCode(userCode)),
        p_client_name: clientName,
        p_client_version: clientVersion,
        p_rate_key: key,
      })) as Record<string, unknown>
      if (result.error === 'code_collision') continue
      const ok = check<{ link_id: string; expires_in: number; interval: number }>(result)
      const verification = `${deps.siteUrl}/link`
      return json(200, {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: verification,
        verification_uri_complete: `${verification}?code=${userCode}`,
        expires_in: ok.expires_in,
        interval: ok.interval,
      })
    }
    fail('internal', {}, 'could not allocate a unique code')
  }

  // POST /v1/device/token -------------------------------------------------------------
  async function deviceToken(req: Request): Promise<Response> {
    const body = await readJson(req)
    const deviceCode = optionalString(body, 'device_code', 128)
    if (!deviceCode || !deviceCode.startsWith('dgd_')) fail('invalid_request', {}, 'device_code is required')
    const access = randomToken('dga_')
    const refresh = randomToken('dgr_')
    const result = check<Record<string, unknown>>(
      await db.rpc('moonshine_device_poll', {
        p_device_code_hash: await sha256Hex(deviceCode),
        p_access_hash: await sha256Hex(access),
        p_refresh_hash: await sha256Hex(refresh),
      }),
    )
    return json(200, tokenBody(result, access, refresh))
  }

  function tokenBody(result: Record<string, unknown>, access: string, refresh: string) {
    return {
      token_type: 'Bearer',
      access_token: access,
      expires_in: result.access_expires_in,
      refresh_token: refresh,
      refresh_expires_in: result.refresh_expires_in,
      link_id: result.link_id,
      user: result.user,
      scope: 'uploads',
    }
  }

  // POST /v1/device/refresh -----------------------------------------------------------
  async function deviceRefresh(req: Request): Promise<Response> {
    const body = await readJson(req)
    const token = optionalString(body, 'refresh_token', 128)
    if (!token || !token.startsWith('dgr_')) fail('invalid_request', {}, 'refresh_token is required')
    const access = randomToken('dga_')
    const refresh = randomToken('dgr_')
    const result = check<Record<string, unknown>>(
      await db.rpc('moonshine_device_refresh', {
        p_refresh_hash: await sha256Hex(token),
        p_new_access_hash: await sha256Hex(access),
        p_new_refresh_hash: await sha256Hex(refresh),
      }),
    )
    return json(200, tokenBody(result, access, refresh))
  }

  // POST /v1/device/revoke ------------------------------------------------------------
  async function deviceRevoke(req: Request): Promise<Response> {
    const body = await readJson(req)
    const bearer = /^Bearer\s+(\S+)$/.exec(req.headers.get('authorization') ?? '')?.[1] ?? null
    const token = optionalString(body, 'token', 128) ?? optionalString(body, 'refresh_token', 128) ?? bearer
    if (!token) fail('invalid_request', {}, 'send the refresh token as {"token": ...} or the access token as a Bearer header')
    const result = (await db.rpc('moonshine_device_revoke', { p_token_hash: await sha256Hex(token) })) as {
      revoked: boolean
    }
    // RFC 7009: an unknown token is not an error, so retries are harmless.
    return json(200, { revoked: result.revoked })
  }

  // POST /v1/uploads ------------------------------------------------------------------
  async function createUpload(req: Request): Promise<Response> {
    const auth = await authenticate(req)
    const body = await readJson(req)
    const byteLength = body.byte_length
    if (typeof byteLength !== 'number' || !Number.isInteger(byteLength) || byteLength < 1) {
      fail('invalid_request', {}, 'byte_length must be a positive integer')
    }
    if (byteLength > MOONSHINE_MAX_FILE_BYTES) fail('too_large')
    const sha = optionalString(body, 'sha256', 64)
    if (!sha || !/^[0-9a-fA-F]{64}$/.test(sha)) fail('invalid_request', {}, 'sha256 must be 64 hex digits')
    const tas = body.tas_declared
    if (tas !== undefined && tas !== null && typeof tas !== 'boolean') fail('invalid_request', {}, 'tas_declared must be true, false or null')
    const idempotencyKey = req.headers.get('idempotency-key')
    if (idempotencyKey !== null && !/^[A-Za-z0-9_.:-]{1,64}$/.test(idempotencyKey)) {
      fail('invalid_request', {}, 'Idempotency-Key must be 1-64 characters of [A-Za-z0-9_.:-]')
    }

    const result = check<Record<string, unknown>>(
      await db.rpc('moonshine_upload_create', {
        p_user_id: auth.user_id,
        p_link_id: auth.link_id,
        p_byte_length: byteLength,
        p_sha256: sha.toLowerCase(),
        p_filename: optionalString(body, 'filename', 200),
        p_title: optionalString(body, 'title', 100),
        p_description: optionalString(body, 'description', 2000),
        p_tas_declared: (tas as boolean | null | undefined) ?? null,
        p_idempotency_key: idempotencyKey,
      }),
    )
    if (result.result === 'already_published') {
      return json(200, { result: 'already_published', ghost: await ghostResponse(result.ghost_id as string) })
    }
    return json(result.result === 'created' ? 201 : 200, uploadBody(result.result as string, result.upload as Record<string, unknown>))
  }

  function uploadBody(result: string, upload: Record<string, unknown>) {
    const id = upload.upload_id as string
    return {
      result,
      upload: {
        ...upload,
        content_url: `${deps.apiBaseUrl}/v1/uploads/${id}/content`,
        publish_url: `${deps.apiBaseUrl}/v1/uploads/${id}/publish`,
      },
    }
  }

  async function getUpload(req: Request, id: string): Promise<Response> {
    const auth = await authenticate(req)
    const result = check<Record<string, unknown>>(await db.rpc('moonshine_upload_get', { p_user_id: auth.user_id, p_upload_id: id }))
    const upload = result.upload as Record<string, unknown>
    const body = uploadBody('existing', upload) as Record<string, unknown>
    if (upload.status === 'published' && upload.ghost_id) body.ghost = await ghostResponse(upload.ghost_id as string)
    return json(200, body)
  }

  // PUT /v1/uploads/{id}/content ---------------------------------------------------
  async function putContent(req: Request, id: string): Promise<Response> {
    const auth = await authenticate(req)
    const declared = req.headers.get('content-length')
    if (declared !== null && Number(declared) > MOONSHINE_MAX_FILE_BYTES) fail('too_large')
    const type = (req.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim().toLowerCase()
    if (type !== 'application/octet-stream') fail('invalid_request', {}, 'Content-Type must be application/octet-stream')

    const begin = check<{ byte_length: number; sha256: string; staging_path: string }>(
      await db.rpc('moonshine_upload_begin_content', { p_user_id: auth.user_id, p_upload_id: id }),
    )
    if (declared !== null && Number(declared) !== begin.byte_length) {
      fail('length_mismatch', { expected_byte_length: begin.byte_length })
    }

    let bytes: Uint8Array
    try {
      bytes = await readBody(req, begin.byte_length)
    } catch (err) {
      if (err instanceof BodyTooLong) fail('length_mismatch', { expected_byte_length: begin.byte_length })
      throw err
    }
    if (bytes.length !== begin.byte_length) fail('length_mismatch', { expected_byte_length: begin.byte_length, received: bytes.length })
    const sha = await sha256Hex(bytes)
    if (sha !== begin.sha256) fail('sha256_mismatch', { expected_sha256: begin.sha256, received_sha256: sha })

    const outcome = classifyGhost(bytes)
    if (!outcome.ghost) {
      await db.rpc('moonshine_upload_finish_content', {
        p_user_id: auth.user_id, p_upload_id: id, p_valid: false, p_validation: null,
        p_error_code: outcome.code, p_detail: outcome.detail,
      })
      fail(outcome.code, {}, outcome.detail)
    }

    try {
      await storage.putStaging(begin.staging_path, bytes)
    } catch (err) {
      log('content: staging write failed', err)
      fail('storage_unavailable')
    }
    const finished = check<{ upload: Record<string, unknown> }>(
      await db.rpc('moonshine_upload_finish_content', {
        p_user_id: auth.user_id, p_upload_id: id, p_valid: true,
        p_validation: validationSummary(outcome.ghost), p_error_code: null, p_detail: null,
      }),
    )
    return json(200, uploadBody('validated', finished.upload))
  }

  function validationSummary(ghost: ValidatedGhost) {
    const fields = indexFields(ghost)
    return {
      validator: VALIDATOR_ID,
      format_version: ghost.version,
      features: featureNames(ghost.required_features),
      region: ghost.region,
      source_profile: ghost.source_profile,
      route_key: fields.route_key,
      result_qf: ghost.result_qf,
      duration_qf: ghost.duration_qf,
      header_name: ghost.name,
      header_ghost_id: ghost.ghost_id,
    }
  }

  // POST /v1/uploads/{id}/publish ----------------------------------------------------
  async function publish(req: Request, id: string): Promise<Response> {
    const auth = await authenticate(req)
    const session = check<Record<string, unknown>>(await db.rpc('moonshine_upload_get', { p_user_id: auth.user_id, p_upload_id: id }))
    const upload = session.upload as Record<string, unknown>
    if (upload.status === 'published') {
      return json(200, { result: 'already_published', ghost: await ghostResponse(upload.ghost_id as string) })
    }
    if (upload.status === 'expired') fail('upload_expired')
    if (upload.status !== 'validated') fail(upload.status === 'awaiting_content' ? 'not_validated' : 'upload_closed', { upload })

    let bytes: Uint8Array | null
    try {
      bytes = await storage.getStaging(session.staging_path as string)
    } catch (err) {
      log('publish: staging read failed', err)
      fail('storage_unavailable')
    }
    if (!bytes) fail('content_missing')
    if ((await sha256Hex(bytes)) !== upload.sha256) fail('content_missing', {}, 'staged bytes changed')
    const outcome = classifyGhost(bytes)
    if (!outcome.ghost) fail('internal', {}, 'staged bytes no longer validate')
    const ghost = outcome.ghost

    const label = splitRunLabel(ghost.name)
    const title = ((session.title as string | null) ?? ghost.name).slice(0, 100)
    const filename = safeFilename((session.filename as string | null) ?? ghost.portable_filename)
    const path = `${auth.user_id}/${session.ghost_id}/${filename}`
    const profileTag = ghost.profile_name.toLowerCase().replace(/[^a-z0-9 _-]/g, '').trim().slice(0, 24)
    const isTas = session.tas_declared === true || label.isTas || (ghost.run_flags & 0x20) !== 0

    try {
      await storage.putArchive(path, bytes)
    } catch (err) {
      log('publish: archive write failed', err)
      fail('storage_unavailable')
    }

    const result = (await db.rpc('moonshine_upload_publish', {
      p_user_id: auth.user_id,
      p_upload_id: id,
      p_file_path: path,
      p_title: title,
      p_level: label.level,
      p_time_ms: label.timeMs,
      p_is_tas: isTas,
      p_tags: profileTag ? [profileTag] : [],
      p_filename: filename,
      p_validator: VALIDATOR_ID,
      p_fields: indexFields(ghost),
    })) as Record<string, unknown>

    if (typeof result.error === 'string' || result.object_unused) {
      // Nothing references the object we just wrote.
      await storage.removeArchive(path).catch((err) => log('publish: cleanup failed', err))
    }
    check(result)
    await storage
      .removeStaging([session.staging_path as string])
      .then(() => db.rpc('moonshine_uploads_mark_cleaned', { p_upload_ids: [id] }))
      .catch((err) => log('publish: staging cleanup failed', err))

    const status = result.result === 'published' ? 201 : 200
    return json(status, { result: result.result, ghost: await ghostResponse(result.ghost_id as string) })
  }

  // DELETE /v1/uploads/{id} -------------------------------------------------------------
  async function cancelUpload(req: Request, id: string): Promise<Response> {
    const auth = await authenticate(req)
    const result = check<{ upload: Record<string, unknown> }>(
      await db.rpc('moonshine_upload_cancel', { p_user_id: auth.user_id, p_upload_id: id }),
    )
    return json(200, uploadBody('cancelled', result.upload))
  }

  /** Deletes staging objects for finished or abandoned sessions. Best effort. */
  async function sweep(): Promise<void> {
    const rows = (await db.rpc('moonshine_uploads_claim_cleanup', { p_limit: 20 })) as
      | { upload_id: string; staging_path: string }[]
      | null
    if (!rows || rows.length === 0) return
    await storage.removeStaging(rows.map((r) => r.staging_path))
    await db.rpc('moonshine_uploads_mark_cleaned', { p_upload_ids: rows.map((r) => r.upload_id) })
  }

  // --- router -------------------------------------------------------------------------
  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url)
    // Supabase delivers /moonshine-api/<rest>; tolerate a /functions/v1 prefix too.
    const path = url.pathname.replace(/^.*?\/moonshine-api(?=\/|$)/, '').replace(/\/+$/, '') || '/'
    const method = req.method.toUpperCase()
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS })

    const allow = (...methods: string[]) => {
      if (!methods.includes(method)) fail('method_not_allowed', { allowed: methods })
    }
    let m: RegExpExecArray | null

    if (path === '/' || path === '/v1' || path === '/v1/capabilities') {
      allow('GET')
      return capabilities()
    }
    if (path === '/v1/ghosts') {
      allow('GET')
      return listGhosts(url)
    }
    if ((m = /^\/v1\/ghosts\/([^/]+)(\/file|\/index)?$/.exec(path))) {
      if (!UUID_RE.test(m[1])) fail('not_found')
      const id = m[1].toLowerCase()
      if (m[2] === '/index') {
        allow('POST')
        return indexGhost(req, id, url.searchParams.get('force') === '1')
      }
      allow('GET')
      const ghost = await ghostResponse(id)
      if (!ghost) fail('not_found')
      if (m[2] === '/file') {
        if (!ghost.file) fail('not_found', { compatible: false, status: ghost.status })
        const location = (ghost.file as Record<string, string>).download_url
        return json(302, { download_url: location }, { Location: location })
      }
      return json(200, { api_version: API_VERSION, catalogue_schema: CATALOGUE_SCHEMA, ghost })
    }
    if (path === '/v1/device/code') {
      allow('POST')
      return deviceCode(req)
    }
    if (path === '/v1/device/token') {
      allow('POST')
      return deviceToken(req)
    }
    if (path === '/v1/device/refresh') {
      allow('POST')
      return deviceRefresh(req)
    }
    if (path === '/v1/device/revoke') {
      allow('POST')
      return deviceRevoke(req)
    }
    if (path === '/v1/me') {
      allow('GET')
      const auth = await authenticate(req)
      return json(200, { link_id: auth.link_id, user: auth.user })
    }
    if (path === '/v1/uploads') {
      allow('POST')
      // Awaited: an Edge Function may be frozen as soon as it responds.
      await sweep().catch((err) => log('sweep failed', err))
      return createUpload(req)
    }
    if ((m = /^\/v1\/uploads\/([^/]+)(\/content|\/publish)?$/.exec(path))) {
      if (!UUID_RE.test(m[1])) fail('not_found')
      const id = m[1].toLowerCase()
      if (m[2] === '/content') {
        allow('PUT', 'POST')
        return putContent(req, id)
      }
      if (m[2] === '/publish') {
        allow('POST')
        return publish(req, id)
      }
      allow('GET', 'DELETE')
      return method === 'GET' ? getUpload(req, id) : cancelUpload(req, id)
    }
    fail('route_not_found')
  }

  return async (req: Request): Promise<Response> => {
    const started = performance.now()
    let res: Response
    try {
      res = await route(req)
    } catch (err) {
      if (err instanceof HttpError) res = err.response
      else {
        log('unhandled error', err)
        res = error('internal')
      }
    }
    // Time spent inside this function only, so a client can tell server time from network time.
    res.headers.set('Server-Timing', `app;dur=${(performance.now() - started).toFixed(1)}`)
    return res
  }
}
