import { supabase } from './supabase'

/**
 * Website side of the Moonshine integration (migration 0012). The game itself
 * talks to the `moonshine-api` Edge Function; the website only approves device
 * links, lists and revokes them, and asks for new uploads to be validated.
 */

const functionsUrl = `${(import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? ''}/functions/v1/moonshine-api`

export interface PendingLink {
  client_name: string
  client_version: string | null
  requested_at: string
  expires_at: string
}

export interface LinkedDevice {
  id: string
  client_name: string
  client_version: string | null
  status: 'approved' | 'active'
  linked_at: string | null
  last_used_at: string | null
  expires_at: string | null
}

export class LinkError extends Error {
  code: string
  constructor(code: string) {
    super(code)
    this.code = code
  }
}

type Result = Record<string, unknown> & { error?: string }

/** What is asking to link? Throws LinkError('not_found') for unknown or expired codes. */
export async function lookupLinkCode(code: string): Promise<PendingLink> {
  const { data, error } = await supabase.rpc('moonshine_link_lookup', { p_user_code: code })
  if (error) throw error
  const result = data as Result
  if (result.error) throw new LinkError(result.error)
  return result as unknown as PendingLink
}

export async function decideLink(code: string, approve: boolean): Promise<void> {
  const { data, error } = await supabase.rpc('moonshine_link_decide', { p_user_code: code, p_approve: approve })
  if (error) throw error
  const result = data as Result
  if (result.error) throw new LinkError(result.error)
}

export async function listLinkedDevices(): Promise<LinkedDevice[]> {
  const { data, error } = await supabase.rpc('moonshine_my_device_links')
  if (error) throw error
  return (data ?? []) as LinkedDevice[]
}

export async function revokeLinkedDevice(id: string): Promise<void> {
  const { error } = await supabase.rpc('moonshine_revoke_device_link', { p_link_id: id })
  if (error) throw error
}

/**
 * Asks the server to validate a ghost's stored bytes so it can be offered to
 * Moonshine. Fire-and-forget: the archive works the same whether or not this
 * succeeds (for instance before the Edge Function is deployed).
 */
export function requestMoonshineIndex(ghostId: string): void {
  if (!functionsUrl.startsWith('https://')) return
  fetch(`${functionsUrl}/v1/ghosts/${ghostId}/index`, { method: 'POST' }).catch(() => {
    /* validation can be retried later; nothing on the website depends on it */
  })
}

export function linkErrorMessage(err: unknown): string {
  const code = err instanceof LinkError ? err.code : ''
  if (code === 'not_found') return 'That code is not valid or has expired. Start linking again on the device.'
  if (code === 'too_many_devices') return 'This account already has the maximum of 10 linked devices. Unlink one in Settings first.'
  if (code === 'rate_limited') return 'Too many attempts. Wait a few minutes and try again.'
  return 'Something went wrong. Try again.'
}
