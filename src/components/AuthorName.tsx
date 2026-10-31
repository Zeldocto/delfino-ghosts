import { Link } from 'react-router-dom'
import { useIsMdp } from '../hooks/useMdp'
import { useStaff } from '../hooks/useStaff'
import { Tooltip } from './Tooltip'

interface AuthorNameProps {
  username: string
  displayName?: string | null
  /** Render as a link to the profile. Defaults to true. */
  link?: boolean
  className?: string
}

const ROLE_LABEL = { admin: 'Admin', moderator: 'Moderator' } as const

/**
 * The single place that knows how an author is rendered. Wherever a username
 * appears — Browse, ghost detail, profiles, the leaderboard — this component
 * decides whether it currently belongs to the MDP or to staff and styles it
 * accordingly. Gold (MDP) wins the colour when both apply; the tooltip names both.
 */
export function AuthorName({ username, displayName, link = true, className }: AuthorNameProps) {
  const isMdp = useIsMdp(username)
  const role = useStaff().roleOf(username)
  const label = displayName?.trim() || username

  const titles = [role && ROLE_LABEL[role], isMdp && 'Most Downloaded Player (MDP)'].filter(Boolean).join(' · ')
  const nameClass = isMdp ? 'mdp-name' : role ? `staff-name staff-${role}` : null

  const body = nameClass ? (
    <Tooltip label={titles}>
      <span className={nameClass}>{label}</span>
      <span className="sr-only"> — {titles}</span>
    </Tooltip>
  ) : (
    <span>{label}</span>
  )

  if (!link) return <span className={className}>{body}</span>

  // A marked name has its own tooltip; the browser's title hint would pop up on top of it.
  return (
    <Link to={`/profile/${username}`} className={className} title={nameClass ? undefined : `${username}'s ghosts`}>
      {body}
    </Link>
  )
}
