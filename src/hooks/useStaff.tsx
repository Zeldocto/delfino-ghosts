import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useAuth } from '../lib/auth'
import { fetchMyModerationStatus, fetchStaffDirectory, type ModerationStatus, type StaffRole } from '../lib/moderation'

/**
 * Moderation state shared by the whole site:
 *   - the public staff directory, fetched once per page load, so <AuthorName />
 *     can mark admins and moderators wherever a name appears (like useMdp);
 *   - the signed-in account's own role and suspension.
 * It only decides what to show: the database refuses staff actions from anyone
 * without the role, and every write from a suspended account.
 */
interface StaffContextValue {
  role: StaffRole | null
  isStaff: boolean
  isAdmin: boolean
  /** The signed-in account is suspended; `suspensionReason` says why, if staff gave a reason. */
  suspended: boolean
  suspensionReason: string | null
  loading: boolean
  /** The role of any username, from the public directory. */
  roleOf: (username: string | null | undefined) => StaffRole | null
  /** Re-reads the directory, after a role change. */
  refreshDirectory: () => Promise<void>
}

const noStatus: ModerationStatus = { role: null, suspended: false, suspended_at: null, reason: null }

const StaffContext = createContext<StaffContextValue>({
  role: null,
  isStaff: false,
  isAdmin: false,
  suspended: false,
  suspensionReason: null,
  loading: true,
  roleOf: () => null,
  refreshDirectory: async () => {},
})

export function StaffProvider({ children }: { children: ReactNode }) {
  const { user, initialising } = useAuth()
  const userId = user?.id ?? null
  const [status, setStatus] = useState<ModerationStatus>(noStatus)
  const [loading, setLoading] = useState(true)
  const [directory, setDirectory] = useState<Map<string, StaffRole>>(() => new Map())

  const refreshDirectory = useCallback(async () => {
    try {
      const rows = await fetchStaffDirectory()
      setDirectory(new Map(rows.map((row) => [row.username.toLowerCase(), row.role])))
    } catch {
      // Before migration 0018 is applied the function does not exist: nobody is marked.
      setDirectory(new Map())
    }
  }, [])

  useEffect(() => {
    void refreshDirectory()
  }, [refreshDirectory])

  useEffect(() => {
    if (initialising) return
    let active = true
    setStatus(noStatus)
    if (!userId) {
      setLoading(false)
      return
    }
    setLoading(true)
    fetchMyModerationStatus()
      .then((value) => {
        if (active) setStatus(value)
      })
      .catch(() => {
        if (active) setStatus(noStatus)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [userId, initialising])

  const roleOf = useCallback(
    (username: string | null | undefined) => (username ? (directory.get(username.toLowerCase()) ?? null) : null),
    [directory],
  )

  const value = useMemo(
    () => ({
      role: status.role,
      isStaff: status.role !== null,
      isAdmin: status.role === 'admin',
      suspended: status.suspended,
      suspensionReason: status.reason,
      loading,
      roleOf,
      refreshDirectory,
    }),
    [status, loading, roleOf, refreshDirectory],
  )
  return <StaffContext.Provider value={value}>{children}</StaffContext.Provider>
}

export function useStaff() {
  return useContext(StaffContext)
}
