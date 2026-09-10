export interface Profile {
  id: string
  username: string
  display_name: string | null
  avatar_url: string | null
  bio: string | null
  total_ghosts: number
  total_downloads: number
  created_at: string
  updated_at: string
}

/** A ghost row as returned by the `list_ghosts` RPC (ghost + author columns). */
export interface GhostListing {
  id: string
  user_id: string
  title: string
  description: string | null
  level: string | null
  /** Milliseconds. Formatted for display with formatTime(). */
  time_ms: number | null
  file_path: string
  original_filename: string
  file_size: number
  is_tas: boolean
  moonshine_version: string | null
  tags: string[]
  download_count: number
  created_at: string
  updated_at: string
  author_username: string
  author_display_name: string | null
  author_total_downloads: number
  total_count: number
}

export type SortKey = 'recent' | 'downloads' | 'oldest' | 'updated' | 'time'

export const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'recent', label: 'Recently uploaded' },
  { value: 'downloads', label: 'Most downloaded' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'updated', label: 'Recently updated' },
  { value: 'time', label: 'Fastest time' },
]

export interface Mdp {
  id: string
  username: string
  total_downloads: number
}

export interface CommunityStats {
  total_users: number
  total_ghosts: number
  total_downloads: number
  mdp: Mdp | null
  top_ghost: { id: string; title: string; download_count: number; author: string } | null
  latest_ghost: { id: string; title: string; created_at: string; author: string } | null
}

export interface PlayerRanking {
  id: string
  username: string
  display_name: string | null
  avatar_url: string | null
  total_ghosts: number
  total_downloads: number
}

export const GHOST_LIMIT = 200
export const MAX_GHOST_BYTES = 2 * 1024 * 1024
export const GHOST_EXTENSION = '.smsghost'
export const PAGE_SIZE = 25
