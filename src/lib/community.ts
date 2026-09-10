import { supabase } from './supabase'
import type { CommunityStats, Mdp, PlayerRanking } from '../types'

export async function fetchCommunityStats(): Promise<CommunityStats> {
  const { data, error } = await supabase.rpc('community_stats')
  if (error) throw error
  return data as CommunityStats
}

export async function fetchTopPlayers(limit = 25): Promise<PlayerRanking[]> {
  const { data, error } = await supabase.rpc('top_players', { p_limit: limit })
  if (error) throw error
  return (data ?? []) as PlayerRanking[]
}

/** The MDP is always derived from live totals — never stored as a flag. */
export async function fetchCurrentMdp(): Promise<Mdp | null> {
  const { data, error } = await supabase.rpc('current_mdp')
  if (error) throw error
  const rows = (data ?? []) as Mdp[]
  return rows[0] ?? null
}
