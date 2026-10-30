/**
 * Object-key rules for the ghost archive, shared by both Edge Functions.
 *
 * Keys are `<user-id>/<ghost-id>/<name>.smsghost`. These are the rules the
 * Supabase Storage policies in 0002/0008 enforced, now checked in code because
 * the S3-compatible bucket has no notion of auth.uid().
 */

/**
 * The one size ceiling for a ghost file: website uploads, the Moonshine API,
 * the ghosts_file_size_range CHECK (0015) and MAX_GHOST_BYTES in
 * src/types/index.ts all use this value. 100 MiB.
 */
export const MAX_GHOST_BYTES = 104_857_600

export const GHOST_EXTENSION = '.smsghost'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

/** Same rules as the website's safeFilename() in src/lib/ghost/GhostStorage.ts. */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'ghost.smsghost'
  const cleaned = base
    .replace(/\.smsghost$/i, '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^[._-]+/, '')
    .slice(0, 96)
    .replace(/\.+$/, '') // else `abc.` + `.smsghost` makes a `..` the key check refuses
  return `${cleaned || 'ghost'}.smsghost`
}

/**
 * True when `key` is a well-formed archive key owned by `uid`: exactly two
 * folders, the first equal to uid, a .smsghost file name that safeFilename
 * would leave unchanged, and no traversal.
 */
export function isOwnedGhostKey(key: unknown, uid: string): key is string {
  if (typeof key !== 'string' || key.includes('..') || key.includes('\\')) return false
  const parts = key.split('/')
  if (parts.length !== 3) return false
  const [owner, folder, name] = parts
  return owner === uid && folder.length > 0 && name.endsWith(GHOST_EXTENSION) && safeFilename(name) === name
}
