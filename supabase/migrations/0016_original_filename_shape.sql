-- ============================================================================
-- Delfino Ghosts - 0016: ghosts.original_filename must look like a ghost file
-- ----------------------------------------------------------------------------
-- original_filename is the name the browser saves a download under
-- (src/lib/downloads.ts) and the `file.filename` the Moonshine catalogue
-- hands out. Until now the only rule was 1-200 characters. The website and
-- the Moonshine API both pass names through safeFilename(), but a signed-in
-- user can insert or update a ghosts row directly with the public anon key,
-- so a row could name its file `Moonshine_update.exe` and every visitor who
-- clicked Download would save an executable from a trusted site.
--
-- The rule is now the shape safeFilename() produces
-- (supabase/functions/_shared/ghost_paths.ts and src/lib/ghost/GhostStorage.ts):
--   * starts with a letter or digit;
--   * only letters, digits, `.`, `_`, `-`;
--   * ends in lowercase `.smsghost`;
--   * at most 105 characters (96 + `.smsghost`).
--
-- Existing rows that do not fit are rewritten first with the same steps as
-- safeFilename(), so this is safe to run on a live database. Website and
-- Moonshine uploads already conform, so in practice nothing should change.
-- No Edge Function deploy is needed.
-- ============================================================================

update public.ghosts
   set original_filename = coalesce(nullif(left(
         regexp_replace(                                           -- no leading . _ -
           regexp_replace(                                         -- runs of dots
             regexp_replace(                                       -- odd characters
               regexp_replace(                                     -- extension
                 regexp_replace(original_filename, '^.*[\\/]', ''),  -- last path segment
               '\.smsghost$', '', 'i'),
             '[^A-Za-z0-9._-]', '_', 'g'),
           '\.{2,}', '_', 'g'),
         '^[._-]+', ''),
       96), ''), 'ghost') || '.smsghost'
 where original_filename !~ '^[A-Za-z0-9][A-Za-z0-9._-]*\.smsghost$'
    or char_length(original_filename) > 105;

alter table public.ghosts
  drop constraint if exists ghosts_original_filename_shape;

-- Unbounded quantifier plus char_length(): Postgres caps regex bounds at 255
-- and raises at evaluation time (see 0005).
alter table public.ghosts
  add constraint ghosts_original_filename_shape
  check (
    original_filename ~ '^[A-Za-z0-9][A-Za-z0-9._-]*\.smsghost$'
    and char_length(original_filename) <= 105
  );
