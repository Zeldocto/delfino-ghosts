-- ============================================================================
-- Delfino Ghosts - 0005: repair the avatar URL constraint
-- ----------------------------------------------------------------------------
-- Bug: the original constraint used the pattern
--
--     '^https://[^\s<>"]{1,400}$'
--
-- PostgreSQL caps regular-expression repetition bounds at 255. A bound above
-- that is not a non-match — it raises "invalid regular expression: invalid
-- repetition count(s)" when the constraint is evaluated. The constraint was
-- therefore created without complaint and then failed on every non-null
-- avatar_url, making it impossible for anyone to save an avatar at all.
--
-- The fix splits the two concerns the pattern was mixing: shape is checked with
-- an unbounded quantifier, length with char_length().
--
-- Safe to run on a live database. It only replaces a constraint, and existing
-- rows all have avatar_url IS NULL (nothing could ever have been stored).
-- ============================================================================

alter table public.profiles
  drop constraint if exists profiles_avatar_url_valid;

alter table public.profiles
  add constraint profiles_avatar_url_valid
  check (
    avatar_url is null
    or (
      avatar_url ~ '^https://[^\s<>"]+$'
      and char_length(avatar_url) <= 400
    )
  );
