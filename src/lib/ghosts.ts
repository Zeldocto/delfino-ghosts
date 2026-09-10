import { supabase } from './supabase'
import {
  buildGhostPath,
  removeGhostObject,
  replaceGhostObject,
  safeFilename,
  uploadGhostObject,
} from './ghost/GhostStorage'
import type { GhostListing, SortKey } from '../types'

export interface ListGhostsParams {
  search?: string
  sort?: SortKey
  userId?: string
  page?: number
  pageSize?: number
}

export interface ListGhostsResult {
  ghosts: GhostListing[]
  total: number
}

/**
 * Sorting, filtering and paging all happen in Postgres. The browser only ever
 * receives one page, so the archive stays responsive at any size.
 */
export async function listGhosts({
  search,
  sort = 'recent',
  userId,
  page = 0,
  pageSize = 25,
}: ListGhostsParams): Promise<ListGhostsResult> {
  const { data, error } = await supabase.rpc('list_ghosts', {
    p_search: search?.trim() || null,
    p_sort: sort,
    p_user: userId ?? null,
    p_limit: pageSize,
    p_offset: page * pageSize,
  })
  if (error) throw error
  const ghosts = (data ?? []) as GhostListing[]
  return { ghosts, total: ghosts[0]?.total_count ?? 0 }
}

export async function getGhost(id: string): Promise<GhostListing | null> {
  const { data, error } = await supabase
    .from('ghosts')
    .select(
      'id, user_id, title, description, level, time_ms, file_path, original_filename, file_size, is_tas, ' +
        'moonshine_version, tags, download_count, created_at, updated_at, ' +
        'profiles!inner(username, display_name, total_downloads)',
    )
    .eq('id', id)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const row = data as unknown as Record<string, unknown> & {
    profiles: { username: string; display_name: string | null; total_downloads: number }
  }
  const author = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles

  return {
    ...(row as unknown as GhostListing),
    author_username: author.username,
    author_display_name: author.display_name,
    author_total_downloads: author.total_downloads,
    total_count: 1,
  }
}

export async function countGhostsForUser(userId: string): Promise<number> {
  const { count, error } = await supabase
    .from('ghosts')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
  if (error) throw error
  return count ?? 0
}

export interface CreateGhostInput {
  userId: string
  title: string
  description: string | null
  level: string | null
  /** Milliseconds, or null when unknown. */
  timeMs: number | null
  isTas: boolean
  moonshineVersion: string | null
  tags: string[]
  file: File
}

/**
 * Upload then insert. The row id is generated client-side only so the object
 * path can be built before the insert; ownership itself is set server-side by
 * the insert trigger from auth.uid(), so a forged user_id has no effect.
 * If the insert fails, the uploaded object is removed rather than orphaned.
 */
export async function createGhost(input: CreateGhostInput): Promise<string> {
  const ghostId = crypto.randomUUID()
  const filename = safeFilename(input.file.name)
  const path = buildGhostPath(input.userId, ghostId, filename)

  await uploadGhostObject(path, input.file)

  const { data, error } = await supabase
    .from('ghosts')
    .insert({
      id: ghostId,
      user_id: input.userId,
      title: input.title,
      description: input.description,
      level: input.level,
      time_ms: input.timeMs,
      file_path: path,
      original_filename: filename,
      file_size: input.file.size,
      is_tas: input.isTas,
      moonshine_version: input.moonshineVersion,
      tags: input.tags,
    })
    .select('id')
    .single()

  if (error) {
    await removeGhostObject(path).catch(() => {
      /* best effort: the row never existed, so nothing references this object */
    })
    throw error
  }

  return (data as { id: string }).id
}

export interface UpdateGhostInput {
  title: string
  description: string | null
  level: string | null
  timeMs: number | null
  isTas: boolean
  moonshineVersion: string | null
  tags: string[]
  /** Optional replacement container; the stored path is reused. */
  file?: File | null
}

export async function updateGhost(
  ghost: Pick<GhostListing, 'id' | 'file_path'>,
  input: UpdateGhostInput,
): Promise<void> {
  const patch: Record<string, unknown> = {
    title: input.title,
    description: input.description,
    level: input.level,
    time_ms: input.timeMs,
    is_tas: input.isTas,
    moonshine_version: input.moonshineVersion,
    tags: input.tags,
  }

  if (input.file) {
    await replaceGhostObject(ghost.file_path, input.file)
    patch.file_size = input.file.size
  }

  const { error } = await supabase.from('ghosts').update(patch).eq('id', ghost.id)
  if (error) throw error
}

/** Removes the row first: with the row gone the object is unreachable anyway. */
export async function deleteGhost(ghost: Pick<GhostListing, 'id' | 'file_path'>): Promise<void> {
  const { error } = await supabase.from('ghosts').delete().eq('id', ghost.id)
  if (error) throw error
  await removeGhostObject(ghost.file_path).catch(() => {
    /* row is already gone; a leftover object is invisible to the archive */
  })
}
