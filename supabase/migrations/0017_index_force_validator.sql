-- ============================================================================
-- Delfino Ghosts - 0017: moonshine_index_candidate reports the stored validator
-- ----------------------------------------------------------------------------
-- POST /v1/ghosts/{id}/index is public, and `?force=1` used to re-download and
-- re-validate a ghost every time (files up to 100 MiB, 300 calls per hour per
-- IP). Validation is deterministic for immutable bytes, so re-reading is only
-- useful after a validator update. The function now honours force only when
-- the stored verdict came from a different validator than the one running, and
-- needs that validator id from here.
--
-- Same signature and return type as 0012 plus one key, so the grants (Edge
-- Function only) carry over. Safe to run before or after deploying
-- moonshine-api: the old function ignores the new key, and the new function
-- treats a missing key as "older validator" (the previous behaviour).
-- ============================================================================

create or replace function public.moonshine_index_candidate(p_ghost_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'ghost_id', g.id,
           'file_path', g.file_path,
           'file_size', g.file_size,
           'indexed', i.ghost_id is not null,
           'status', i.status,
           'validator', i.validator)
    from public.ghosts g
    left join public.ghost_moonshine_index i
      on i.ghost_id = g.id and i.file_path = g.file_path and i.byte_length = g.file_size
   where g.id = p_ghost_id;
$$;
