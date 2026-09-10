import { supabase } from './supabase'
import type { Profile } from '../types'

const PROFILE_COLUMNS =
  'id, username, display_name, avatar_url, bio, total_ghosts, total_downloads, created_at, updated_at'

export async function getProfileById(id: string): Promise<Profile | null> {
  const { data, error } = await supabase.from('profiles').select(PROFILE_COLUMNS).eq('id', id).maybeSingle()
  if (error) throw error
  return data as Profile | null
}

export async function getProfileByUsername(username: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select(PROFILE_COLUMNS)
    .eq('username_lower', username.toLowerCase())
    .maybeSingle()
  if (error) throw error
  return data as Profile | null
}

export interface ProfileUpdate {
  username?: string
  display_name?: string | null
  avatar_url?: string | null
  bio?: string | null
}

export async function updateProfile(id: string, patch: ProfileUpdate): Promise<Profile> {
  const { data, error } = await supabase
    .from('profiles')
    .update(patch)
    .eq('id', id)
    .select(PROFILE_COLUMNS)
    .single()
  if (error) throw error
  return data as Profile
}

export async function isUsernameAvailable(username: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('username_available', { p_username: username })
  if (error) throw error
  return Boolean(data)
}
