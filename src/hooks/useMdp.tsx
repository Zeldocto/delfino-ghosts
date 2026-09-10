import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { fetchCurrentMdp } from '../lib/community'
import type { Mdp } from '../types'

/**
 * The current Most Download Player, fetched once per page load and shared by
 * every <AuthorName />. The value is derived from live totals by the database,
 * so the designation moves on its own as soon as someone is overtaken.
 */
const MdpContext = createContext<{ mdp: Mdp | null; loading: boolean }>({ mdp: null, loading: true })

export function MdpProvider({ children }: { children: ReactNode }) {
  const [mdp, setMdp] = useState<Mdp | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    fetchCurrentMdp()
      .then((value) => {
        if (active) setMdp(value)
      })
      .catch(() => {
        if (active) setMdp(null)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const value = useMemo(() => ({ mdp, loading }), [mdp, loading])
  return <MdpContext.Provider value={value}>{children}</MdpContext.Provider>
}

export function useMdp() {
  return useContext(MdpContext)
}

export function useIsMdp(username: string | null | undefined): boolean {
  const { mdp } = useMdp()
  if (!username || !mdp) return false
  return mdp.username.toLowerCase() === username.toLowerCase()
}
