-- ============================================================================
-- Delfino Ghosts - 0010: raise the per-ghost size limit to 10 MiB
-- ----------------------------------------------------------------------------
-- The ceiling lives in two places that must agree, plus the frontend constant
-- MAX_GHOST_BYTES in src/types/index.ts:
--   * the ghosts_file_size_range CHECK on public.ghosts (from 0001)
--   * the file_size_limit on the `ghosts` Storage bucket (from 0002)
--
-- Raising a limit never invalidates existing rows, so this is safe to run on a
-- live database.
-- ============================================================================

alter table public.ghosts
  drop constraint if exists ghosts_file_size_range;

alter table public.ghosts
  add constraint ghosts_file_size_range
  check (file_size > 0 and file_size <= 10485760);   -- 10 MiB

update storage.buckets
   set file_size_limit = 10485760                    -- 10 MiB, enforced by Storage itself
 where id = 'ghosts';
