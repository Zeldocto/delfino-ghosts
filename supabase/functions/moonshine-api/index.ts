/**
 * Supabase Edge Function entry point for the Moonshine API.
 *
 * Deploy with JWT verification off - Moonshine clients authenticate with this
 * API's own device tokens, not Supabase sessions:
 *
 *   supabase functions deploy moonshine-api --no-verify-jwt
 *
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by Supabase. The
 * service-role key stays inside this function; no client ever receives it.
 *
 * Archive ghosts live in an S3-compatible bucket (Cloudflare R2), configured by
 * the same secrets as ghost-storage: S3_ENDPOINT, S3_BUCKET, S3_REGION,
 * S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, GHOSTS_PUBLIC_BASE_URL. Upload
 * staging stays in the private Supabase bucket `ghost-uploads`.
 * Optional secrets: MOONSHINE_SITE_URL, MOONSHINE_RATE_SALT.
 */
import { createClient } from 'npm:@supabase/supabase-js@2.116.0'
import { AwsClient } from 'npm:aws4fetch@1.0.20'
import { createS3, s3ConfigFromEnv } from '../_shared/s3.ts'
import { createHandler, DbError, type ObjectStore } from './app.ts'

declare const Deno: {
  env: { get(name: string): string | undefined }
  serve(handler: (req: Request) => Response | Promise<Response>): void
}

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const siteUrl = (Deno.env.get('MOONSHINE_SITE_URL') ?? 'https://zeldocto.github.io/delfino-ghosts').replace(/\/$/, '')

const admin = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const SET_RETURNING = new Set(['moonshine_uploads_claim_cleanup'])

const db = {
  async rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await admin.rpc(fn, args)
    if (error) throw new DbError(error.message, error.code ?? '')
    return SET_RETURNING.has(fn) ? (data ?? []) : data
  },
}

// A missing object comes back as HTTP 400 with {"statusCode":"404","message":"Object not found"}
// (observed on the live project), so look at the body's code and message, not the HTTP status.
function missing(error: unknown): boolean {
  const e = error as { statusCode?: string | number; message?: string } | null
  if (!e) return false
  return String(e.statusCode ?? '') === '404' || /not found/i.test(e.message ?? '')
}

function bucket(name: string) {
  const store = admin.storage.from(name)
  return {
    async put(path: string, bytes: Uint8Array) {
      const { error } = await store.upload(path, bytes, {
        contentType: 'application/octet-stream',
        cacheControl: '3600',
        upsert: true,
      })
      if (error) throw error
    },
    async get(path: string): Promise<Uint8Array | null> {
      const { data, error } = await store.download(path)
      if (error) {
        if (missing(error)) return null
        throw error
      }
      return new Uint8Array(await data.arrayBuffer())
    },
    async remove(paths: string[]) {
      const { error } = await store.remove(paths)
      if (error) throw error
    },
  }
}

const staging = bucket('ghost-uploads')
const s3Config = s3ConfigFromEnv((name) => Deno.env.get(name))
const archive = createS3(s3Config, AwsClient)

const storage: ObjectStore = {
  putStaging: (path, bytes) => staging.put(path, bytes),
  getStaging: (path) => staging.get(path),
  removeStaging: (paths) => staging.remove(paths),
  putArchive: (path, bytes) => archive.put(path, bytes),
  getArchive: (path) => archive.get(path),
  removeArchive: (path) => archive.remove(path),
}

const handler = createHandler({
  db,
  storage,
  archiveBaseUrl: s3Config.publicBaseUrl,
  apiBaseUrl: `${supabaseUrl}/functions/v1/moonshine-api`,
  siteUrl,
  rateSalt: Deno.env.get('MOONSHINE_RATE_SALT') ?? serviceKey,
  log: (message, detail) => console.error(`[moonshine-api] ${message}`, detail ?? ''),
})

Deno.serve(handler)
