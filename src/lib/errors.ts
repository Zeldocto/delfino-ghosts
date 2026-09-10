import { GHOST_LIMIT } from '../types'

/**
 * Turns Supabase/Postgres failures into something a person can act on. Raw
 * database messages never reach the interface.
 */
export function friendlyError(err: unknown, fallback = 'Something went wrong. Try again.'): string {
  if (!err) return fallback

  const raw = typeof err === 'string' ? err : ((err as { message?: string }).message ?? '')
  const code = (err as { code?: string }).code ?? ''
  const text = raw.toLowerCase()

  if (text.includes('ghost_limit_reached')) {
    return `This account is at the ${GHOST_LIMIT}-ghost limit. Delete one to upload another.`
  }
  if (text.includes('not_authenticated') || code === '28000') {
    return 'Sign in to do that.'
  }
  if (text.includes('ghost_not_found')) {
    return 'That ghost no longer exists.'
  }
  if (text.includes('username_taken') || (code === '23505' && text.includes('username'))) {
    return 'That username is already taken.'
  }
  if (text.includes('duplicate key') || code === '23505') {
    return 'That already exists.'
  }
  if (text.includes('database error saving new user')) {
    return 'That username is already taken. Pick another one.'
  }
  if (text.includes('invalid login credentials')) {
    return 'That email and password combination did not match.'
  }
  if (text.includes('email not confirmed')) {
    return 'Confirm your email address first. Check your inbox for the verification link.'
  }
  if (text.includes('user already registered')) {
    return 'An account already uses that email address.'
  }
  if (text.includes('for security purposes') || text.includes('rate limit') || code === '429') {
    return 'Too many attempts. Wait a minute and try again.'
  }
  if (text.includes('row-level security') || code === '42501') {
    return 'You do not have permission to do that.'
  }
  if (text.includes('violates check constraint') || code === '23514') {
    return 'Some of those values are not allowed. Check the form and try again.'
  }
  if (text.includes('payload too large') || text.includes('exceeded the maximum allowed size')) {
    return 'That file is larger than the 2 MB limit.'
  }
  if (text.includes('mime type') || text.includes('invalid_mime_type')) {
    return 'That file type is not accepted here.'
  }
  if (text.includes('failed to fetch') || text.includes('networkerror')) {
    return 'Could not reach the server. Check your connection and try again.'
  }
  if (code === 'PGRST116') {
    return 'Not found.'
  }
  return fallback
}
