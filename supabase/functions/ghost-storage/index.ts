/**
 * Supabase Edge Function entry point for ghost-storage (see app.ts).
 *
 * Deploy WITH JWT verification - only signed-in website users call this:
 *
 *   supabase functions deploy ghost-storage
 *
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by Supabase. The
 * archive bucket is configured by secrets (README section 2.5):
 * S3_ENDPOINT, S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY,
 * GHOSTS_PUBLIC_BASE_URL. None of them ever reaches a client.
 */
import { createClient } from 'npm:@supabase/supabase-js@2.116.0'
import { AwsClient } from 'npm:aws4fetch@1.0.20'
import { createS3, s3ConfigFromEnv } from '../_shared/s3.ts'
import { createHandler } from './app.ts'

declare const Deno: {
  env: { get(name: string): string | undefined }
  serve(handler: (req: Request) => Response | Promise<Response>): void
}

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
})

async function exists(table: string, column: string, value: string): Promise<boolean> {
  const { count, error } = await admin.from(table).select(column, { count: 'exact', head: true }).eq(column, value)
  if (error) throw error
  return (count ?? 0) > 0
}

const handler = createHandler({
  async verifyToken(token) {
    const { data, error } = await admin.auth.getUser(token)
    return error || !data.user ? null : data.user.id
  },
  db: {
    async isActiveAccount(uid) {
      const { data, error } = await admin.from('profiles').select('deleted_at').eq('id', uid).maybeSingle()
      if (error) throw error
      return data !== null && (data as { deleted_at: string | null }).deleted_at === null
    },
    isValidated: (key) => exists('ghost_moonshine_index', 'file_path', key),
    isReferenced: (key) => exists('ghosts', 'file_path', key),
  },
  s3: createS3(s3ConfigFromEnv((name) => Deno.env.get(name)), AwsClient),
  log: (message, detail) => console.error(`[ghost-storage] ${message}`, detail ?? ''),
})

Deno.serve(handler)
