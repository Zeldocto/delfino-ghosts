import { supabase } from './supabase'
import { removeGhostObject } from './ghost/GhostStorage'

/**
 * Website side of moderation (migration 0018). Every rule lives in Postgres:
 * these functions refuse anyone who is not staff, whatever this file does.
 * Admins are granted in the SQL editor; admins make and unmake moderators here.
 */

export type StaffRole = 'admin' | 'moderator'

export interface ModerationStatus {
  role: StaffRole | null
  suspended: boolean
  suspended_at: string | null
  reason: string | null
}

export interface StaffMember {
  user_id: string
  username: string
  display_name: string | null
  role: StaffRole
  granted_at: string
}

export interface Suspension {
  user_id: string
  username: string
  display_name: string | null
  suspended_at: string
  reason: string | null
  suspended_by_username: string | null
}

export interface AccountStatus {
  role: StaffRole | null
  suspended: boolean
  suspended_at: string | null
  reason: string | null
  suspended_by_username: string | null
}

export interface ModerationEntry {
  id: number
  created_at: string
  action: 'remove_ghost' | 'edit_ghost' | 'suspend_account' | 'unsuspend_account' | 'add_moderator' | 'remove_moderator'
  actor_username: string | null
  actor_display_name: string | null
  target_username: string | null
  target_display_name: string | null
  ghost_id: string | null
  ghost_title: string | null
  file_path: string | null
  reason: string | null
  /** edit_ghost only: each changed field with its old and new value. */
  details: Record<string, { from: unknown; to: unknown }> | null
}

export const MAX_REASON_LENGTH = 500

export async function fetchMyModerationStatus(): Promise<ModerationStatus> {
  const { data, error } = await supabase.rpc('my_moderation_status')
  if (error) throw error
  return data as ModerationStatus
}

/** Public: every staff account's username and role, for marking names. */
export async function fetchStaffDirectory(): Promise<{ username: string; role: StaffRole }[]> {
  const { data, error } = await supabase.rpc('staff_directory')
  if (error) throw error
  return (data ?? []) as { username: string; role: StaffRole }[]
}

/**
 * Removes someone's ghost and then its file. The row goes first, so the ghost
 * is off the archive even if the file step fails; `fileRemoved: false` means
 * the file is still in the bucket and `retryFileRemoval` should be offered.
 */
export async function removeGhostAsStaff(
  ghostId: string,
  reason: string,
): Promise<{ filePath: string; fileRemoved: boolean }> {
  const { data, error } = await supabase.rpc('moderator_remove_ghost', {
    p_ghost_id: ghostId,
    p_reason: reason.trim() || null,
  })
  if (error) throw error
  const filePath = (data as { file_path: string }).file_path
  const fileRemoved = await removeGhostObject(filePath).then(
    () => true,
    () => false,
  )
  return { filePath, fileRemoved }
}

/** Deletes a removed ghost's file. ghost-storage refuses if a ghost still uses it. */
export async function retryFileRemoval(filePath: string): Promise<void> {
  await removeGhostObject(filePath)
}

export interface StaffGhostEdit {
  title: string
  description: string | null
  level: string | null
  timeMs: number | null
  isTas: boolean
  moonshineVersion: string | null
  tags: string[]
}

/** Edits someone else's ghost details. The file cannot be changed this way. */
export async function updateGhostAsStaff(ghostId: string, edit: StaffGhostEdit, reason: string): Promise<void> {
  const { error } = await supabase.rpc('moderator_update_ghost', {
    p_ghost_id: ghostId,
    p_title: edit.title,
    p_description: edit.description,
    p_level: edit.level,
    p_time_ms: edit.timeMs,
    p_is_tas: edit.isTas,
    p_moonshine_version: edit.moonshineVersion,
    p_tags: edit.tags,
    p_reason: reason.trim() || null,
  })
  if (error) throw error
}

export async function suspendAccount(username: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('suspend_account', { p_username: username, p_reason: reason.trim() || null })
  if (error) throw error
}

export async function unsuspendAccount(username: string): Promise<void> {
  const { error } = await supabase.rpc('unsuspend_account', { p_username: username })
  if (error) throw error
}

export async function fetchAccountStatus(userId: string): Promise<AccountStatus> {
  const { data, error } = await supabase.rpc('staff_account_status', { p_user_id: userId })
  if (error) throw error
  return data as AccountStatus
}

export async function listStaff(): Promise<StaffMember[]> {
  const { data, error } = await supabase.rpc('list_staff')
  if (error) throw error
  return (data ?? []) as StaffMember[]
}

export async function listSuspensions(): Promise<Suspension[]> {
  const { data, error } = await supabase.rpc('list_suspensions')
  if (error) throw error
  return (data ?? []) as Suspension[]
}

export async function setModerator(username: string, moderator: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_moderator', { p_username: username.trim(), p_moderator: moderator })
  if (error) throw error
}

export async function recentModeration(limit = 50): Promise<ModerationEntry[]> {
  const { data, error } = await supabase.rpc('moderation_log_recent', { p_limit: limit })
  if (error) throw error
  return (data ?? []) as ModerationEntry[]
}
