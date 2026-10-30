-- ============================================================================
-- Delfino Ghosts - 0015: one 100 MiB size limit for the archive and Moonshine
-- ----------------------------------------------------------------------------
-- The website and the Moonshine API now share a single ceiling, 104857600
-- bytes (100 MiB). It must agree with:
--   * MAX_GHOST_BYTES in src/types/index.ts (browser feedback only)
--   * MAX_GHOST_BYTES in supabase/functions/_shared/ghost_paths.ts (the
--     ghost-storage function signs uploads for at most this size)
--   * MOONSHINE_MAX_FILE_BYTES in supabase/functions/_shared/ghost_format.ts
--
-- Raised here:
--   * ghosts_file_size_range on public.ghosts (was 10 MiB, 0010)
--   * moonshine_config() max_upload_bytes (was 1297992, 0012)
--   * ghost_moonshine_index_compatible_complete byte_length bound (0012)
--   * moonshine_uploads_length (0012)
--   * the private `ghost-uploads` staging bucket's file_size_limit (0012)
--
-- Not changed: the legacy public `ghosts` bucket. Archive files now live in
-- the S3-compatible bucket behind the ghost-storage Edge Function; the old
-- bucket stays at 10 MiB, read-only in practice, until it is removed by hand.
--
-- Note: Moonshine's ghost format still caps canonical files at about 1.3 MB
-- (validateGhost in ghost_format.ts). This migration does not change what the
-- validator accepts, only the service limits around it.
--
-- Every bound only grows, so existing rows stay valid and this is safe to run
-- on a live database. Deploy the Edge Functions first (README section 4).
-- ============================================================================

-- ghosts ------------------------------------------------------------------------

alter table public.ghosts
  drop constraint if exists ghosts_file_size_range;

alter table public.ghosts
  add constraint ghosts_file_size_range
  check (file_size > 0 and file_size <= 104857600);   -- 100 MiB

-- moonshine_config(): identical to 0012 except max_upload_bytes ----------------

create or replace function public.moonshine_config()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'max_upload_bytes',            104857600,  -- 100 MiB, shared with the website
    'upload_session_ttl_s',        86400,
    'max_open_uploads',            5,
    'max_content_attempts',        10,
    'upload_creates_per_hour',     30,
    'device_code_ttl_s',           600,
    'device_poll_interval_s',      5,
    'device_poll_interval_max_s',  60,
    'device_starts_per_10min',     10,
    'device_collect_grace_s',      120,
    'access_token_ttl_s',          3600,
    'refresh_token_ttl_s',         7776000,  -- 90 days, sliding
    'refresh_retry_grace_s',       120,
    'max_linked_devices',          10,
    'link_lookups_per_10min',      20,
    'page_size_default',           20,
    'page_size_max',               50
  );
$$;

grant execute on function public.moonshine_config() to anon, authenticated, service_role;

-- ghost_moonshine_index: same predicate as 0012, larger byte bound -------------

alter table public.ghost_moonshine_index
  drop constraint if exists ghost_moonshine_index_compatible_complete;

alter table public.ghost_moonshine_index
  add constraint ghost_moonshine_index_compatible_complete
  check (status <> 'compatible' or (
    format_version is not null and required_features is not null and run_flags is not null
    and region is not null and game_id is not null and source_profile is not null
    and route_key is not null and portable is not null and start_qf is not null
    and end_qf is not null and duration_qf is not null and byte_length <= 104857600
  ));

-- moonshine_uploads -------------------------------------------------------------

alter table public.moonshine_uploads
  drop constraint if exists moonshine_uploads_length;

alter table public.moonshine_uploads
  add constraint moonshine_uploads_length
  check (byte_length between 1 and 104857600);

-- staging bucket ------------------------------------------------------------------

update storage.buckets
   set file_size_limit = 104857600                     -- 100 MiB, enforced by Storage itself
 where id = 'ghost-uploads';
