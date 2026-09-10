import { supabase } from '../supabase'

export const GHOST_BUCKET = 'ghosts'

/**
 * Objects live at `<user-id>/<ghost-id>/<name>.smsghost`. The Storage policies
 * check that first segment against auth.uid(), and the ghosts table has a CHECK
 * constraint tying file_path to user_id, so a row can never reference another
 * user's object.
 */
export function buildGhostPath(userId: string, ghostId: string, originalName: string): string {
  return `${userId}/${ghostId}/${safeFilename(originalName)}`
}

/** Strips directories and anything that is not a plain filename character. */
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

export async function uploadGhostObject(path: string, file: File): Promise<void> {
  const { error } = await supabase.storage.from(GHOST_BUCKET).upload(path, file, {
    contentType: 'application/octet-stream',
    cacheControl: '3600',
    upsert: false,
  })
  if (error) throw error
}

export async function replaceGhostObject(path: string, file: File): Promise<void> {
  const { error } = await supabase.storage.from(GHOST_BUCKET).upload(path, file, {
    contentType: 'application/octet-stream',
    cacheControl: '3600',
    upsert: true,
  })
  if (error) throw error
}

export async function removeGhostObject(path: string): Promise<void> {
  const { error } = await supabase.storage.from(GHOST_BUCKET).remove([path])
  if (error) throw error
}

export function ghostPublicUrl(path: string): string {
  return supabase.storage.from(GHOST_BUCKET).getPublicUrl(path).data.publicUrl
}
