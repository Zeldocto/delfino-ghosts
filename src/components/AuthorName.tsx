import { Link } from 'react-router-dom'
import { useIsMdp } from '../hooks/useMdp'
import { Tooltip } from './Tooltip'

interface AuthorNameProps {
  username: string
  displayName?: string | null
  /** Render as a link to the profile. Defaults to true. */
  link?: boolean
  className?: string
}

/**
 * The single place that knows how an author is rendered. Wherever a username
 * appears — Browse, ghost detail, profiles, the leaderboard — this component
 * decides whether it currently belongs to the MDP and styles it accordingly.
 */
export function AuthorName({ username, displayName, link = true, className }: AuthorNameProps) {
  const isMdp = useIsMdp(username)
  const label = displayName?.trim() || username

  const body = isMdp ? (
    <Tooltip label="Most Download Player (MDP)">
      <span className="mdp-name">{label}</span>
      <span className="sr-only"> — Most Download Player</span>
    </Tooltip>
  ) : (
    <span>{label}</span>
  )

  if (!link) return <span className={className}>{body}</span>

  return (
    <Link to={`/profile/${username}`} className={className} title={`${username}'s ghosts`}>
      {body}
    </Link>
  )
}
