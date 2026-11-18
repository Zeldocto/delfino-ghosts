/**
 * Object-key rules for the ghost archive, shared by both Edge Functions.
 *
 * Keys are `<user-id>/<ghost-id>/<name>.smsghost` (or `.msgt`). These are the rules the
 * Supabase Storage policies in 0002/0008 enforced, now checked in code because
 * the S3-compatible bucket has no notion of auth.uid().
 */

/**
 * The one size ceiling for a ghost file: website uploads, the Moonshine API,
 * the ghosts_file_size_range CHECK (0015) and MAX_GHOST_BYTES in
 * src/types/index.ts all use this value. 100 MiB.
 */
export const MAX_GHOST_BYTES = 104_857_600

/**
 * The archive takes two file types. `.smsghost` is the SGHF container
 * Moonshine has always written; `.msgt` is its newer file type (the MSTR trace
 * format). Both use the same filename shape. A name keeps whichever of the two
 * it already ends in; anything else is given `.smsghost`.
 */
export const GHOST_EXTENSION = '.smsghost'
export const GHOST_EXTENSIONS = ['.smsghost', '.msgt'] as const
export type GhostExtension = (typeof GHOST_EXTENSIONS)[number]

/** The accepted extension `name` ends in (any case), lowercased, or null. */
export function ghostExtensionOf(name: string): GhostExtension | null {
  const match = /\.(smsghost|msgt)$/i.exec(name)
  return match ? (`.${match[1].toLowerCase()}` as GhostExtension) : null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

/**
 * Same rules as the website's safeFilename() in src/lib/ghost/GhostStorage.ts.
 * The result ends in `extension`, which defaults to the one the name already
 * has (`.smsghost` or `.msgt`), else `.smsghost`.
 */
export function safeFilename(name: string, extension?: GhostExtension): string {
  const base = name.split(/[\\/]/).pop() ?? 'ghost.smsghost'
  const ext = extension ?? ghostExtensionOf(base) ?? GHOST_EXTENSION
  const cleaned = base
    .replace(/\.(smsghost|msgt)$/i, '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^[._-]+/, '')
    .slice(0, 96)
    .replace(/\.+$/, '') // else `abc.` + `.smsghost` makes a `..` the key check refuses
  return `${cleaned || 'ghost'}${ext}`
}

/**
 * True when `key` is a well-formed archive key owned by `uid`: exactly two
 * folders, the first equal to uid, a .smsghost or .msgt file name that safeFilename
 * would leave unchanged, and no traversal.
 */
export function isOwnedGhostKey(key: unknown, uid: string): key is string {
  if (typeof key !== 'string' || key.includes('..') || key.includes('\\')) return false
  const parts = key.split('/')
  if (parts.length !== 3) return false
  const [owner, folder, name] = parts
  return owner === uid && folder.length > 0 && ghostExtensionOf(name) !== null && safeFilename(name) === name
}
