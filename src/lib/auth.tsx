import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { getProfileById } from './profiles'
import type { Profile } from '../types'

/**
 * All credential handling is delegated to Supabase Auth. This project never
 * hashes, stores or transmits passwords to its own tables — `auth.users` is
 * managed by Supabase and is not readable through the anon key.
 */

interface AuthContextValue {
  session: Session | null
  user: User | null
  profile: Profile | null
  /** True until the stored session has been restored on first load. */
  initialising: boolean
  /** True while the profile row for the signed-in user is being fetched. */
  profileLoading: boolean
  /** Set when Supabase reports the user arrived from a password-reset link. */
  recoveryMode: boolean
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string, username: string) => Promise<{ needsVerification: boolean }>
  signOut: () => Promise<void>
  requestPasswordReset: (email: string) => Promise<void>
  updatePassword: (password: string) => Promise<void>
  clearRecoveryMode: () => void
  refreshProfile: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

/** Where Supabase should send people after they click an emailed link. */
function authRedirectUrl(): string {
  return `${window.location.origin}${import.meta.env.BASE_URL}`
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [initialising, setInitialising] = useState(true)
  const [profileLoading, setProfileLoading] = useState(false)
  const [recoveryMode, setRecoveryMode] = useState(false)
  const currentUserId = useRef<string | null>(null)

  useEffect(() => {
    let active = true

    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!active) return
        setSession(data.session)
      })
      .finally(() => {
        if (active) setInitialising(false)
      })

    const { data: subscription } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!active) return
      setSession(nextSession)
      if (event === 'PASSWORD_RECOVERY') setRecoveryMode(true)
      if (event === 'SIGNED_OUT') setProfile(null)
    })

    return () => {
      active = false
      subscription.subscription.unsubscribe()
    }
  }, [])

  const loadProfile = useCallback(async (userId: string) => {
    setProfileLoading(true)
    try {
      const next = await getProfileById(userId)
      setProfile(next)
    } catch {
      setProfile(null)
    } finally {
      setProfileLoading(false)
    }
  }, [])

  useEffect(() => {
    const userId = session?.user?.id ?? null
    if (userId === currentUserId.current) return
    currentUserId.current = userId
    if (userId) void loadProfile(userId)
    else setProfile(null)
  }, [session, loadProfile])

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    if (error) throw error
  }, [])

  const signUp = useCallback(async (email: string, password: string, username: string) => {
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: { username: username.trim() },
        emailRedirectTo: authRedirectUrl(),
      },
    })
    if (error) throw error
    // No session means the project requires email confirmation first.
    return { needsVerification: !data.session }
  }, [])

  const signOut = useCallback(async () => {
    const { error } = await supabase.auth.signOut()
    if (error) throw error
    setProfile(null)
  }, [])

  const requestPasswordReset = useCallback(async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: authRedirectUrl(),
    })
    if (error) throw error
  }, [])

  const updatePassword = useCallback(async (password: string) => {
    const { error } = await supabase.auth.updateUser({ password })
    if (error) throw error
    setRecoveryMode(false)
  }, [])

  const refreshProfile = useCallback(async () => {
    if (session?.user?.id) await loadProfile(session.user.id)
  }, [session, loadProfile])

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      profile,
      initialising,
      profileLoading,
      recoveryMode,
      signIn,
      signUp,
      signOut,
      requestPasswordReset,
      updatePassword,
      clearRecoveryMode: () => setRecoveryMode(false),
      refreshProfile,
    }),
    [
      session,
      profile,
      initialising,
      profileLoading,
      recoveryMode,
      signIn,
      signUp,
      signOut,
      requestPasswordReset,
      updatePassword,
      refreshProfile,
    ],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
