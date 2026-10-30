import { FunctionsHttpError } from '@supabase/supabase-js'
import { supabase } from '../supabase'

/**
 * Ghost files live in an S3-compatible bucket (Cloudflare R2), not Supabase
 * Storage. The browser never holds a bucket credential: it asks the
 * `ghost-storage` Edge Function for a presigned URL, and the function decides
 * the key, size and type. Downloads are plain GETs on the public base URL.
 */
const publicBase = ((import.meta.env.VITE_GHOSTS_PUBLIC_BASE_URL as string | undefined) ?? '').replace(/\/+$/, '')

/** Without a public base there is nowhere to download from; App shows the setup page. */
export const isStorageConfigured = Boolean(publicBase)

/**
 * Objects live at `<user-id>/<ghost-id>/<name>.smsghost`. The ghost-storage
 * function checks that first segment against the caller's verified user id,
 * and the ghosts table has a CHECK constraint tying file_path to user_id, so a
 * row can never reference another user's object.
 */
export function buildGhostPath(userId: string, ghostId: string, originalName: string): string {
  return `${userId}/${ghostId}/${safeFilename(originalName)}`
}

/**
 * Strips directories and anything that is not a plain filename character.
 * Same rules as supabase/functions/_shared/ghost_paths.ts, which is the copy
 * that is actually enforced.
 */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'ghost.smsghost'
  const cleaned = base
    .replace(/\.smsghost$/i, '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^[._-]+/, '')
    .slice(0, 96)
    .replace(/\.+$/, '') // else `abc.` + `.smsghost` makes a `..` the key check refuses
  return `${cleaned || 'ghost'}.smsghost`
}

interface PresignedUpload {
  key: string
  url: string
  method: 'PUT'
  headers: Record<string, string>
}

/** Calls ghost-storage; a refusal comes back as an Error whose message is its code. */
async function callStorage<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('ghost-storage', { body })
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const payload = (await (error.context as Response).json().catch(() => null)) as { error?: string } | null
      throw new Error(payload?.error ?? 'storage_unavailable')
    }
    throw error
  }
  return data as T
}

export async function uploadGhostObject(path: string, file: File): Promise<void> {
  const [, ghostId, name] = path.split('/')
  const signed = await callStorage<PresignedUpload>({
    action: 'presign-upload',
    ghost_id: ghostId,
    filename: name,
    byte_size: file.size,
  })
  // The function builds the key itself; the row must point at exactly that.
  if (signed.key !== path) throw new Error('storage_key_mismatch')

  const res = await fetch(signed.url, { method: signed.method, headers: signed.headers, body: file })
  if (res.status === 412) throw new Error('object_exists')
  if (!res.ok) throw new Error('storage_unavailable')
}

export async function removeGhostObject(path: string): Promise<void> {
  await callStorage({ action: 'delete', key: path })
}

export function ghostPublicUrl(path: string): string {
  return `${publicBase}/${path.split('/').map(encodeURIComponent).join('/')}`
}
