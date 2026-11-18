-- ============================================================================
-- Delfino Ghosts - 0019: accept .msgt ghost files alongside .smsghost
-- ----------------------------------------------------------------------------
-- Moonshine's newer ghost files end in `.msgt`. They use the same filename
-- shape as `.smsghost` files; only the extension differs. The archive now
-- takes both, and a file keeps the extension it was uploaded with.
--
-- 0016 tied ghosts.original_filename (the name a download is saved under) to
-- the shape safeFilename() produces, ending in `.smsghost`. safeFilename()
-- (supabase/functions/_shared/ghost_paths.ts, src/lib/ghost/GhostStorage.ts)
-- now keeps a `.msgt` ending, so the CHECK allows either:
--   * starts with a letter or digit;
--   * only letters, digits, `.`, `_`, `-`;
--   * ends in lowercase `.smsghost` or `.msgt`;
--   * at most 105 characters (96 + `.smsghost`).
--
-- Only widens the rule, so every existing row already passes and nothing is
-- rewritten. Redeploy the ghost-storage and moonshine-api Edge Functions as
-- well (they share ghost_paths.ts): until ghost-storage is redeployed it still
-- renames `x.msgt` to `x.msgt.smsghost`, and the website refuses that key.
-- ============================================================================

alter table public.ghosts
  drop constraint if exists ghosts_original_filename_shape;

-- Unbounded quantifier plus char_length(): Postgres caps regex bounds at 255
-- and raises at evaluation time (see 0005).
alter table public.ghosts
  add constraint ghosts_original_filename_shape
  check (
    original_filename ~ '^[A-Za-z0-9][A-Za-z0-9._-]*\.(smsghost|msgt)$'
    and char_length(original_filename) <= 105
  );
