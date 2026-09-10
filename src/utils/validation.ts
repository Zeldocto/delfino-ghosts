export const USERNAME_PATTERN = /^[A-Za-z0-9_-]{3,24}$/

export const RESERVED_USERNAMES = new Set([
  'admin', 'root', 'system', 'support', 'moderator', 'mod', 'api', 'auth',
  'profile', 'ghost', 'ghosts', 'browse', 'upload', 'community', 'about',
  'login', 'register', 'settings', 'delfino', 'moonshine', 'new', 'edit',
])

export function validateUsername(value: string): string | null {
  const v = value.trim()
  if (!v) return 'Pick a username.'
  if (v.length < 3) return 'Usernames are at least 3 characters.'
  if (v.length > 24) return 'Usernames are at most 24 characters.'
  if (!USERNAME_PATTERN.test(v)) return 'Use letters, numbers, hyphens and underscores only.'
  if (RESERVED_USERNAMES.has(v.toLowerCase())) return 'That username is reserved.'
  return null
}

export function validateEmail(value: string): string | null {
  if (!value.trim()) return 'Enter your email address.'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) return 'That email address does not look right.'
  return null
}

export function validatePassword(value: string): string | null {
  if (!value) return 'Enter a password.'
  if (value.length < 8) return 'Passwords are at least 8 characters.'
  if (value.length > 72) return 'Passwords are at most 72 characters.'
  return null
}

export function validateTitle(value: string): string | null {
  const v = value.trim()
  if (!v) return 'Give the ghost a title.'
  if (v.length > 100) return 'Titles are at most 100 characters.'
  return null
}

export function validateDescription(value: string): string | null {
  if (value.length > 2000) return 'Descriptions are at most 2000 characters.'
  return null
}

/** Accepts a comma or space separated tag string, returns normalised tags. */
export function parseTags(input: string): string[] {
  const tags = input
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .filter((t) => /^[a-z0-9][a-z0-9 _-]{0,23}$/.test(t))
  return Array.from(new Set(tags)).slice(0, 8)
}
