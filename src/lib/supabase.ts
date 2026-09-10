import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/**
 * Both values below are public by design: the anon key is a client credential
 * that grants exactly what Row Level Security allows and nothing more. The
 * service_role key must never appear in this project — anything built by Vite
 * is world-readable.
 */
export const isSupabaseConfigured = Boolean(url && anonKey)

export const supabase = createClient(url ?? 'https://placeholder.supabase.co', anonKey ?? 'placeholder', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: 'delfino-ghosts-auth',
  },
})
