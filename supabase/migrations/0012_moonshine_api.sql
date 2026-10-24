-- ============================================================================
-- Delfino Ghosts - 0012: Moonshine ghost-sharing API
-- ----------------------------------------------------------------------------
-- Backs the `moonshine-api` Edge Function (supabase/functions/moonshine-api),
-- which lets the Moonshine practice mod browse, download and - when the player
-- opts in - upload ghosts without a browser. See MOONSHINE-INTEGRATION.md.
--
-- What this adds:
--   * ghost_moonshine_index   server-side validation result for a ghost's
--                             exact stored bytes. Only rows whose status is
--                             'compatible' are advertised to Moonshine. Written
--                             only by the Edge Function (service role).
--   * moonshine_device_links  "enter this code on your phone" device linking,
--                             plus the hashed, revocable tokens a linked device
--                             holds. Raw tokens are never stored.
--   * moonshine_uploads       resumable, idempotent upload sessions.
--   * moonshine_rate_limits   fixed-window counters.
--   * moonshine_catalogue     read-only view of compatible ghosts.
--   * RPCs for the website (approve a code, list/revoke linked devices) and
--     for the Edge Function (everything else, service_role only).
--   * Storage: a private `ghost-uploads` staging bucket, and archive objects
--     that have been validated can no longer be overwritten in place.
--
-- Nothing here changes existing rows, list_ghosts(), or the website's upload
-- path. Safe to run on the live database. Needs 0008 (is_active_account).
-- ============================================================================

-- ============================================================================
-- Settings
-- ============================================================================
-- One place for every limit. The Edge Function reports these numbers in its
-- capabilities response, so they cannot drift from what the SQL enforces.

create or replace function public.moonshine_config()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'max_upload_bytes',            1297992,  -- Moonshine's largest canonical file
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

-- ============================================================================
-- Rate limits
-- ============================================================================

create table if not exists public.moonshine_rate_limits (
  bucket       text        not null,
  key          text        not null,
  window_start timestamptz not null,
  hits         integer     not null default 0,
  primary key (bucket, key, window_start)
);

alter table public.moonshine_rate_limits enable row level security;
revoke all on public.moonshine_rate_limits from anon, authenticated;

-- Counts one hit and reports whether it is within the limit. Keys are opaque
-- (the Edge Function passes a hash of the client IP, never the IP itself).
create or replace function public.moonshine_rate_limit_hit(
  p_bucket   text,
  p_key      text,
  p_limit    integer,
  p_window_s integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_epoch  numeric := extract(epoch from now());
  v_window timestamptz := to_timestamp(floor(v_epoch / p_window_s) * p_window_s);
  v_hits   integer;
begin
  insert into public.moonshine_rate_limits as r (bucket, key, window_start, hits)
  values (p_bucket, coalesce(p_key, 'unknown'), v_window, 1)
  on conflict (bucket, key, window_start) do update set hits = r.hits + 1
  returning hits into v_hits;

  -- Occasional pruning keeps the table at a few windows' worth of rows.
  if random() < 0.02 then
    delete from public.moonshine_rate_limits where window_start < now() - interval '1 day';
  end if;

  if v_hits > p_limit then
    return jsonb_build_object(
      'allowed', false,
      'retry_after_s', greatest(1, ceil(extract(epoch from v_window) + p_window_s - v_epoch)::integer)
    );
  end if;
  return jsonb_build_object('allowed', true, 'retry_after_s', 0);
end;
$$;

-- ============================================================================
-- Validation index
-- ============================================================================
-- One row per ghost whose stored bytes the Edge Function has read and checked
-- with the port of Moonshine's validator. The row records which object it
-- describes (file_path + byte_length + sha256); the catalogue only trusts it
-- while the ghost still points at that same object.

create table if not exists public.ghost_moonshine_index (
  ghost_id            uuid primary key references public.ghosts (id) on delete cascade,
  file_path           text        not null,
  byte_length         integer     not null check (byte_length > 0),
  content_sha256      text        not null,
  status              text        not null,
  status_code         text        not null,
  status_detail       text,
  validator           text        not null,
  source              text        not null,
  validated_at        timestamptz not null default now(),

  format_version      smallint,
  required_features   bigint,
  run_flags           bigint,
  unknown_run_flags   bigint,
  game_id             text,
  region              text,
  source_profile      smallint,
  profile_name        text,
  route_area          smallint,
  route_episode       smallint,
  route_parent_area   smallint,
  route_flags         smallint,
  route_variant       integer,
  route_key           text,
  portable            boolean,
  result_qf           bigint,
  start_qf            bigint,
  end_qf              bigint,
  duration_qf         bigint,
  sample_count        integer,
  segment_count       integer,
  input_count         integer,
  split_count         integer,
  camera_sample_count integer,
  initial_rng_seed    bigint,
  file_crc32          text,
  header_ghost_id     text,
  created_unix        numeric(20, 0),
  header_name         text,
  header_author       text,

  constraint ghost_moonshine_index_sha
    check (content_sha256 ~ '^[0-9a-f]+$' and char_length(content_sha256) = 64),
  constraint ghost_moonshine_index_status
    check (status in ('compatible', 'invalid', 'unsupported', 'too_large')),
  constraint ghost_moonshine_index_source
    check (source in ('website', 'moonshine_api')),
  constraint ghost_moonshine_index_detail_len
    check (status_detail is null or char_length(status_detail) <= 300),
  constraint ghost_moonshine_index_region
    check (region is null or region in ('jp', 'us', 'pal')),
  -- A compatible row must carry everything the catalogue filters on.
  constraint ghost_moonshine_index_compatible_complete
    check (status <> 'compatible' or (
      format_version is not null and required_features is not null and run_flags is not null
      and region is not null and game_id is not null and source_profile is not null
      and route_key is not null and portable is not null and start_qf is not null
      and end_qf is not null and duration_qf is not null and byte_length <= 1297992
    ))
);

create index if not exists ghost_moonshine_index_sha_idx   on public.ghost_moonshine_index (content_sha256);
create index if not exists ghost_moonshine_index_route_idx on public.ghost_moonshine_index (route_key, result_qf);
create index if not exists ghost_moonshine_index_path_idx  on public.ghost_moonshine_index (file_path);

alter table public.ghost_moonshine_index enable row level security;

drop policy if exists ghost_moonshine_index_select_public on public.ghost_moonshine_index;
create policy ghost_moonshine_index_select_public
  on public.ghost_moonshine_index for select
  using (true);

revoke insert, update, delete, truncate on public.ghost_moonshine_index from anon, authenticated;
grant select on public.ghost_moonshine_index to anon, authenticated;

-- When a ghost row stops pointing at the validated object, the validation no
-- longer describes it. The catalogue join also checks path and size, so this
-- is belt and braces.
create or replace function public.ghost_moonshine_index_invalidate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.ghost_moonshine_index where ghost_id = new.id;
  return null;
end;
$$;

drop trigger if exists ghosts_moonshine_index_invalidate_trg on public.ghosts;
create trigger ghosts_moonshine_index_invalidate_trg
  after update of file_path, file_size on public.ghosts
  for each row
  when (old.file_path is distinct from new.file_path or old.file_size is distinct from new.file_size)
  execute function public.ghost_moonshine_index_invalidate();

-- Feature names for the requiredFeatures bits, named after the
-- SUSAMUNE_GHOST_REQUIRED_* macros in Moonshine's ghost_format.h.
create or replace function public.moonshine_feature_names(p_bits bigint)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(name order by bit), '[]'::jsonb)
    from (values (1, 'extended_codec'), (2, 'teaching'), (4, 'fludd'),
                 (8, 'visual_v7'), (16, 'camera'), (32, 'initial_rng')) f(bit, name)
   where (p_bits & bit) <> 0;
$$;

-- ============================================================================
-- Catalogue view
-- ============================================================================
-- Compatible ghosts only, joined to their author, with the JSON entry the API
-- returns (catalogue_schema 1). security_invoker keeps RLS in force.
--
-- `assistance` is 'tas', 'assisted' or 'unknown'. It is never 'clean': the
-- file's run flags are advisory and the website's is_tas checkbox defaults to
-- false, so the absence of a flag is not evidence of an unassisted run.

drop view if exists public.moonshine_catalogue;
create view public.moonshine_catalogue
with (security_invoker = true)
as
select
  g.id,
  g.user_id,
  g.created_at,
  p.username_lower as author_username_lower,
  i.route_key,
  i.route_area,
  i.route_episode,
  i.region,
  i.portable,
  i.source_profile,
  i.format_version,
  i.content_sha256,
  i.result_qf,
  case
    when (i.run_flags & 32) <> 0 or g.is_tas then 'tas'
    when (i.run_flags & 7) <> 0 then 'assisted'
    else 'unknown'
  end as assistance,
  jsonb_build_object(
    'id',          g.id,
    'title',       g.title,
    'description', g.description,
    'uploaded_at', g.created_at,
    'updated_at',  g.updated_at,
    'author', jsonb_build_object(
      'id', g.user_id, 'username', p.username, 'display_name', p.display_name
    ),
    'file', jsonb_build_object(
      'path',         g.file_path,
      'filename',     g.original_filename,
      'byte_length',  i.byte_length,
      'sha256',       i.content_sha256,
      'crc32',        i.file_crc32,
      'content_type', 'application/octet-stream'
    ),
    'format', jsonb_build_object(
      'magic',             'SGHF',
      'version',           i.format_version,
      'required_features', i.required_features,
      'features',          public.moonshine_feature_names(i.required_features),
      'validator',         i.validator,
      'validated_at',      i.validated_at
    ),
    'game', jsonb_build_object('game_id', i.game_id, 'region', i.region, 'disc_revision', 0),
    'profile', jsonb_build_object('source_profile', i.source_profile, 'name', i.profile_name),
    'route', jsonb_build_object(
      'key',                     i.route_key,
      'area',                    i.route_area,
      'episode',                 i.route_episode,
      'parent_area',             i.route_parent_area,
      'flags',                   i.route_flags,
      'variant',                 i.route_variant,
      'segment_count',           i.segment_count,
      'portable_across_regions', i.portable
    ),
    'timing', jsonb_build_object(
      'unit',               'qf',
      'result_qf',          i.result_qf,
      'start_qf',           i.start_qf,
      'end_qf',             i.end_qf,
      'duration_qf',        i.duration_qf,
      'export_duration_ms', floor(i.duration_qf * 1001 / 120)::bigint
    ),
    'recording', jsonb_build_object(
      'sample_count',        i.sample_count,
      'input_count',         i.input_count,
      'split_count',         i.split_count,
      'camera_sample_count', i.camera_sample_count,
      'initial_rng', case when i.initial_rng_seed is null then null else
        jsonb_build_object('seed', i.initial_rng_seed, 'provenance', 'first_recorded_pose') end,
      'header_ghost_id',     i.header_ghost_id,
      'created_unix',        i.created_unix
    ),
    'header_text', jsonb_build_object('name', i.header_name, 'author', i.header_author),
    'eligibility', jsonb_build_object(
      'run_flags', i.run_flags,
      'flags', jsonb_build_object(
        'assisted',          (i.run_flags & 1)  <> 0,
        'savestate_used',    (i.run_flags & 2)  <> 0,
        'fast_forward_used', (i.run_flags & 4)  <> 0,
        'incomplete',        (i.run_flags & 8)  <> 0,
        'custom_route',      (i.run_flags & 16) <> 0,
        'tas',               (i.run_flags & 32) <> 0
      ),
      'unknown_flag_bits', i.unknown_run_flags,
      'uploader_tas',      case when g.is_tas then true else null end,
      'assistance', case
        when (i.run_flags & 32) <> 0 or g.is_tas then 'tas'
        when (i.run_flags & 7) <> 0 then 'assisted'
        else 'unknown'
      end
    ),
    'site', jsonb_build_object(
      'level',          g.level,
      'time_ms',        g.time_ms,
      'download_count', g.download_count
    )
  ) as entry
from public.ghosts g
join public.profiles p on p.id = g.user_id
join public.ghost_moonshine_index i
  on i.ghost_id = g.id
 and i.file_path = g.file_path
 and i.byte_length = g.file_size
where i.status = 'compatible';

grant select on public.moonshine_catalogue to anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- moonshine_list_ghosts()
-- ----------------------------------------------------------------------------
-- Keyset pagination: every sort is ascending on (sort_key, id), so a cursor is
-- just the last row's pair and pages stay stable while ghosts are added.

create or replace function public.moonshine_list_ghosts(
  p_route_key      text    default null,
  p_area           integer default null,
  p_episode        integer default null,
  p_region         text    default null,
  p_playable_on    text    default null,
  p_source_profile integer default null,
  p_assistance     text    default null,
  p_format_version integer default null,
  p_author         text    default null,
  p_sha256         text    default null,
  p_sort           text    default 'newest',
  p_cursor         text    default null,
  p_limit          integer default null
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_cfg        jsonb   := public.moonshine_config();
  v_limit      integer := least(greatest(coalesce(p_limit, (v_cfg ->> 'page_size_default')::integer), 1),
                                (v_cfg ->> 'page_size_max')::integer);
  v_sort       text    := coalesce(p_sort, 'newest');
  v_prefix     text;
  v_cursor_key bigint;
  v_cursor_id  uuid;
  v_parts      text[];
  v_items      jsonb;
  v_last_key   bigint;
  v_last_id    uuid;
  v_count      integer;
  v_total      bigint;
begin
  v_prefix := case v_sort when 'newest' then 'n' when 'oldest' then 'o' when 'result_qf' then 'r' end;
  if v_prefix is null then
    raise exception 'invalid_parameter: sort' using errcode = '22023';
  end if;
  if p_region is not null and p_region not in ('jp', 'us', 'pal') then
    raise exception 'invalid_parameter: region' using errcode = '22023';
  end if;
  if p_playable_on is not null and p_playable_on not in ('jp', 'us', 'pal') then
    raise exception 'invalid_parameter: playable_on' using errcode = '22023';
  end if;
  if p_assistance is not null and p_assistance not in ('tas', 'assisted', 'unknown') then
    raise exception 'invalid_parameter: assistance' using errcode = '22023';
  end if;

  if p_cursor is not null then
    v_parts := string_to_array(p_cursor, '~');
    begin
      if array_length(v_parts, 1) <> 3 or v_parts[1] <> v_prefix then
        raise exception 'bad cursor';
      end if;
      v_cursor_key := v_parts[2]::bigint;
      v_cursor_id  := v_parts[3]::uuid;
    exception when others then
      raise exception 'invalid_parameter: cursor' using errcode = '22023';
    end;
  end if;

  with filtered as (
    select c.*,
           case v_sort
             when 'newest'    then -(extract(epoch from c.created_at) * 1000000)::bigint
             when 'oldest'    then  (extract(epoch from c.created_at) * 1000000)::bigint
             else coalesce(c.result_qf, 4294967296)
           end as sort_key
      from public.moonshine_catalogue c
     where (p_route_key      is null or c.route_key = p_route_key)
       and (p_area           is null or c.route_area = p_area)
       and (p_episode        is null or c.route_episode = p_episode)
       and (p_region         is null or c.region = p_region)
       and (p_playable_on    is null or c.region = p_playable_on or c.portable)
       and (p_source_profile is null or c.source_profile = p_source_profile)
       and (p_assistance     is null or c.assistance = p_assistance)
       and (p_format_version is null or c.format_version = p_format_version)
       and (p_author         is null or c.author_username_lower = lower(p_author))
       and (p_sha256         is null or c.content_sha256 = lower(p_sha256))
  ),
  page as (
    select f.id, f.sort_key, f.entry
      from filtered f
     where v_cursor_id is null or (f.sort_key, f.id) > (v_cursor_key, v_cursor_id)
     order by f.sort_key, f.id
     limit v_limit + 1
  ),
  numbered as (
    select pg.*, row_number() over (order by pg.sort_key, pg.id) as n from page pg
  )
  select
    coalesce(jsonb_agg(entry order by n) filter (where n <= v_limit), '[]'::jsonb),
    count(*)::integer,
    (array_agg(sort_key order by n) filter (where n <= v_limit))[v_limit],
    (array_agg(id order by n) filter (where n <= v_limit))[v_limit],
    (select count(*) from filtered)
    into v_items, v_count, v_last_key, v_last_id, v_total
    from numbered;

  return jsonb_build_object(
    'items', v_items,
    'next_cursor', case when v_count > v_limit
                        then v_prefix || '~' || v_last_key::text || '~' || v_last_id::text end,
    'total', v_total,
    'limit', v_limit,
    'sort', v_sort
  );
end;
$$;

grant execute on function public.moonshine_list_ghosts(
  text, integer, integer, text, text, integer, text, integer, text, text, text, text, integer
) to anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- moonshine_get_ghost()
-- ----------------------------------------------------------------------------
-- A compatible ghost returns its catalogue entry. Any other ghost that exists
-- on the website returns why it is not offered to Moonshine.

create or replace function public.moonshine_get_ghost(p_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select jsonb_build_object('compatible', true, 'entry', c.entry)
       from public.moonshine_catalogue c where c.id = p_id),
    (select jsonb_build_object(
              'compatible', false,
              'id', g.id,
              'status', case when i.ghost_id is null then 'not_indexed' else i.status end,
              'status_code', i.status_code,
              'detail', i.status_detail)
       from public.ghosts g
       left join public.ghost_moonshine_index i
         on i.ghost_id = g.id and i.file_path = g.file_path and i.byte_length = g.file_size
      where g.id = p_id)
  );
$$;

grant execute on function public.moonshine_get_ghost(uuid) to anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Indexing (Edge Function only)
-- ----------------------------------------------------------------------------

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
           'status', i.status)
    from public.ghosts g
    left join public.ghost_moonshine_index i
      on i.ghost_id = g.id and i.file_path = g.file_path and i.byte_length = g.file_size
   where g.id = p_ghost_id;
$$;

-- Records a validation result, but only if the ghost still points at the
-- object that was read; otherwise the caller read a stale file.
create or replace function public.moonshine_index_put(
  p_ghost_id    uuid,
  p_file_path   text,
  p_byte_length integer,
  p_sha256      text,
  p_status      text,
  p_code        text,
  p_detail      text,
  p_validator   text,
  p_source      text,
  p_fields      jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f jsonb := coalesce(p_fields, '{}'::jsonb);
begin
  if not exists (
    select 1 from public.ghosts
     where id = p_ghost_id and file_path = p_file_path and file_size = p_byte_length
  ) then
    return jsonb_build_object('error', 'stale');
  end if;

  insert into public.ghost_moonshine_index as x (
    ghost_id, file_path, byte_length, content_sha256, status, status_code, status_detail,
    validator, source, validated_at,
    format_version, required_features, run_flags, unknown_run_flags, game_id, region,
    source_profile, profile_name, route_area, route_episode, route_parent_area, route_flags,
    route_variant, route_key, portable, result_qf, start_qf, end_qf, duration_qf,
    sample_count, segment_count, input_count, split_count, camera_sample_count,
    initial_rng_seed, file_crc32, header_ghost_id, created_unix, header_name, header_author
  ) values (
    p_ghost_id, p_file_path, p_byte_length, lower(p_sha256), p_status, p_code, left(p_detail, 300),
    p_validator, p_source, now(),
    (f ->> 'format_version')::smallint, (f ->> 'required_features')::bigint,
    (f ->> 'run_flags')::bigint, (f ->> 'unknown_run_flags')::bigint, f ->> 'game_id',
    f ->> 'region', (f ->> 'source_profile')::smallint, f ->> 'profile_name',
    (f ->> 'route_area')::smallint, (f ->> 'route_episode')::smallint,
    (f ->> 'route_parent_area')::smallint, (f ->> 'route_flags')::smallint,
    (f ->> 'route_variant')::integer, f ->> 'route_key', (f ->> 'portable')::boolean,
    (f ->> 'result_qf')::bigint, (f ->> 'start_qf')::bigint, (f ->> 'end_qf')::bigint,
    (f ->> 'duration_qf')::bigint, (f ->> 'sample_count')::integer,
    (f ->> 'segment_count')::integer, (f ->> 'input_count')::integer,
    (f ->> 'split_count')::integer, (f ->> 'camera_sample_count')::integer,
    (f ->> 'initial_rng_seed')::bigint, f ->> 'file_crc32', f ->> 'header_ghost_id',
    (f ->> 'created_unix')::numeric, f ->> 'header_name', f ->> 'header_author'
  )
  on conflict (ghost_id) do update set
    file_path = excluded.file_path, byte_length = excluded.byte_length,
    content_sha256 = excluded.content_sha256, status = excluded.status,
    status_code = excluded.status_code, status_detail = excluded.status_detail,
    validator = excluded.validator, source = x.source, validated_at = excluded.validated_at,
    format_version = excluded.format_version, required_features = excluded.required_features,
    run_flags = excluded.run_flags, unknown_run_flags = excluded.unknown_run_flags,
    game_id = excluded.game_id, region = excluded.region,
    source_profile = excluded.source_profile, profile_name = excluded.profile_name,
    route_area = excluded.route_area, route_episode = excluded.route_episode,
    route_parent_area = excluded.route_parent_area, route_flags = excluded.route_flags,
    route_variant = excluded.route_variant, route_key = excluded.route_key,
    portable = excluded.portable, result_qf = excluded.result_qf,
    start_qf = excluded.start_qf, end_qf = excluded.end_qf, duration_qf = excluded.duration_qf,
    sample_count = excluded.sample_count, segment_count = excluded.segment_count,
    input_count = excluded.input_count, split_count = excluded.split_count,
    camera_sample_count = excluded.camera_sample_count,
    initial_rng_seed = excluded.initial_rng_seed, file_crc32 = excluded.file_crc32,
    header_ghost_id = excluded.header_ghost_id, created_unix = excluded.created_unix,
    header_name = excluded.header_name, header_author = excluded.header_author;

  return jsonb_build_object('ok', true, 'status', p_status);
end;
$$;

-- ============================================================================
-- Device links
-- ============================================================================
-- Modelled on OAuth 2.0 device authorization (RFC 8628). The game shows a
-- short user code; the player approves it on the website while signed in; the
-- game polls and receives an access/refresh token pair for this API only.
-- All codes and tokens are stored as SHA-256 hashes.

create table if not exists public.moonshine_device_links (
  id                 uuid primary key default gen_random_uuid(),
  device_code_hash   text        not null unique,
  user_code_hash     text        not null,
  client_name        text        not null,
  client_version     text,
  status             text        not null default 'pending',
  user_id            uuid references public.profiles (id) on delete cascade,
  created_at         timestamptz not null default now(),
  code_expires_at    timestamptz not null,
  poll_interval_s    integer     not null,
  last_polled_at     timestamptz,
  decided_at         timestamptz,
  tokens_issued_at   timestamptz,
  access_token_hash  text unique,
  access_expires_at  timestamptz,
  refresh_token_hash text unique,
  refresh_expires_at timestamptz,
  prev_refresh_hash  text,
  rotated_at         timestamptz,
  last_used_at       timestamptz,
  revoked_at         timestamptz,
  revoked_reason     text,

  constraint moonshine_device_links_status
    check (status in ('pending', 'approved', 'denied', 'expired', 'active', 'revoked')),
  constraint moonshine_device_links_client_name
    check (char_length(client_name) between 1 and 48 and client_name ~ '^[ -~]+$'),
  constraint moonshine_device_links_client_version
    check (client_version is null or (char_length(client_version) between 1 and 32
                                      and client_version ~ '^[ -~]+$')),
  constraint moonshine_device_links_owner
    check (status in ('pending', 'denied', 'expired') or user_id is not null)
);

create unique index if not exists moonshine_device_links_pending_code_idx
  on public.moonshine_device_links (user_code_hash) where status = 'pending';
create index if not exists moonshine_device_links_user_idx
  on public.moonshine_device_links (user_id, status);

alter table public.moonshine_device_links enable row level security;
-- No policies and no grants: clients reach this table only through the
-- functions below, which never return hashes.
revoke all on public.moonshine_device_links from anon, authenticated;

-- The user code as typed on a phone: case and separators do not matter.
create or replace function public.moonshine_user_code_hash(p_user_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(regexp_replace(upper(coalesce(p_user_code, '')), '[^A-Z0-9]', '', 'g'), 'UTF8')), 'hex');
$$;

create or replace function public.moonshine_link_user_json(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('id', p.id, 'username', p.username, 'display_name', p.display_name)
    from public.profiles p where p.id = p_user_id;
$$;

-- Game: start linking. Returns the link id and timings; the Edge Function
-- generated the codes and keeps the plaintext only long enough to answer.
create or replace function public.moonshine_device_start(
  p_device_code_hash text,
  p_user_code_hash   text,
  p_client_name      text,
  p_client_version   text,
  p_rate_key         text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cfg  jsonb := public.moonshine_config();
  v_rate jsonb;
  v_id   uuid;
begin
  v_rate := public.moonshine_rate_limit_hit('device_start', p_rate_key,
              (v_cfg ->> 'device_starts_per_10min')::integer, 600);
  if not (v_rate ->> 'allowed')::boolean then
    return jsonb_build_object('error', 'rate_limited', 'retry_after_s', (v_rate ->> 'retry_after_s')::integer);
  end if;

  -- Housekeeping: settle expired codes, forget long-dead ones.
  update public.moonshine_device_links
     set status = 'expired'
   where status = 'pending' and code_expires_at < now();
  delete from public.moonshine_device_links
   where status in ('pending', 'denied', 'expired') and code_expires_at < now() - interval '1 day';

  begin
    insert into public.moonshine_device_links (
      device_code_hash, user_code_hash, client_name, client_version, code_expires_at, poll_interval_s
    ) values (
      p_device_code_hash, p_user_code_hash, p_client_name, nullif(p_client_version, ''),
      now() + make_interval(secs => (v_cfg ->> 'device_code_ttl_s')::integer),
      (v_cfg ->> 'device_poll_interval_s')::integer
    )
    returning id into v_id;
  exception
    when unique_violation then
      return jsonb_build_object('error', 'code_collision');
    when check_violation then
      return jsonb_build_object('error', 'invalid_request', 'detail', 'client_name or client_version');
  end;

  return jsonb_build_object(
    'link_id', v_id,
    'expires_in', (v_cfg ->> 'device_code_ttl_s')::integer,
    'interval', (v_cfg ->> 'device_poll_interval_s')::integer
  );
end;
$$;

-- Issues a fresh token pair on a locked link row. Internal helper.
create or replace function public.moonshine_issue_tokens(
  p_link_id      uuid,
  p_access_hash  text,
  p_refresh_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cfg  jsonb := public.moonshine_config();
  v_user uuid;
begin
  update public.moonshine_device_links
     set status             = 'active',
         tokens_issued_at   = coalesce(tokens_issued_at, now()),
         access_token_hash  = p_access_hash,
         access_expires_at  = now() + make_interval(secs => (v_cfg ->> 'access_token_ttl_s')::integer),
         refresh_token_hash = p_refresh_hash,
         refresh_expires_at = now() + make_interval(secs => (v_cfg ->> 'refresh_token_ttl_s')::integer)
   where id = p_link_id
  returning user_id into v_user;

  return jsonb_build_object(
    'status', 'issued',
    'link_id', p_link_id,
    'access_expires_in', (v_cfg ->> 'access_token_ttl_s')::integer,
    'refresh_expires_in', (v_cfg ->> 'refresh_token_ttl_s')::integer,
    'user', public.moonshine_link_user_json(v_user)
  );
end;
$$;

revoke all on function public.moonshine_issue_tokens(uuid, text, text) from public, anon, authenticated;

-- Game: poll. Error codes follow RFC 8628 section 3.5.
create or replace function public.moonshine_device_poll(
  p_device_code_hash text,
  p_access_hash      text,
  p_refresh_hash     text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cfg  jsonb := public.moonshine_config();
  v_link public.moonshine_device_links;
begin
  select * into v_link from public.moonshine_device_links
   where device_code_hash = p_device_code_hash
   for update;

  if not found then
    return jsonb_build_object('error', 'invalid_grant');
  end if;

  if v_link.status = 'pending' then
    if v_link.code_expires_at < now() then
      update public.moonshine_device_links set status = 'expired' where id = v_link.id;
      return jsonb_build_object('error', 'expired_token');
    end if;
    -- Polling faster than the interval earns slow_down and a longer interval.
    if v_link.last_polled_at is not null
       and v_link.last_polled_at > now() - make_interval(secs => v_link.poll_interval_s) then
      update public.moonshine_device_links
         set poll_interval_s = least(poll_interval_s + 5, (v_cfg ->> 'device_poll_interval_max_s')::integer),
             last_polled_at  = now()
       where id = v_link.id
      returning poll_interval_s into v_link.poll_interval_s;
      return jsonb_build_object('error', 'slow_down', 'interval', v_link.poll_interval_s);
    end if;
    update public.moonshine_device_links set last_polled_at = now() where id = v_link.id;
    return jsonb_build_object('error', 'authorization_pending', 'interval', v_link.poll_interval_s);
  end if;

  if v_link.status in ('denied', 'revoked') then
    return jsonb_build_object('error', 'access_denied');
  end if;
  if v_link.status = 'expired' then
    return jsonb_build_object('error', 'expired_token');
  end if;

  if not exists (select 1 from public.profiles where id = v_link.user_id and deleted_at is null) then
    update public.moonshine_device_links
       set status = 'revoked', revoked_at = now(), revoked_reason = 'account_deleted'
     where id = v_link.id;
    return jsonb_build_object('error', 'access_denied');
  end if;

  if v_link.status = 'approved' then
    if v_link.code_expires_at + make_interval(secs => (v_cfg ->> 'device_collect_grace_s')::integer) < now() then
      update public.moonshine_device_links set status = 'expired' where id = v_link.id;
      return jsonb_build_object('error', 'expired_token');
    end if;
    return public.moonshine_issue_tokens(v_link.id, p_access_hash, p_refresh_hash);
  end if;

  -- 'active': the game may have lost the response that carried its tokens.
  -- Within a short grace window the same device code yields a replacement
  -- pair (the previous pair stops working); after that it is spent.
  if v_link.tokens_issued_at > now() - make_interval(secs => (v_cfg ->> 'device_collect_grace_s')::integer) then
    return public.moonshine_issue_tokens(v_link.id, p_access_hash, p_refresh_hash);
  end if;
  return jsonb_build_object('error', 'invalid_grant');
end;
$$;

-- Game: renew. Refresh tokens rotate on every use. Presenting the previous
-- refresh token again is accepted once within a short grace window (a lost
-- response); outside it, reuse is treated as theft and the link is revoked.
create or replace function public.moonshine_device_refresh(
  p_refresh_hash     text,
  p_new_access_hash  text,
  p_new_refresh_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cfg  jsonb := public.moonshine_config();
  v_link public.moonshine_device_links;
begin
  select * into v_link from public.moonshine_device_links
   where refresh_token_hash = p_refresh_hash or prev_refresh_hash = p_refresh_hash
   for update;

  if not found or v_link.status <> 'active' then
    return jsonb_build_object('error', 'invalid_grant');
  end if;

  if not exists (select 1 from public.profiles where id = v_link.user_id and deleted_at is null) then
    update public.moonshine_device_links
       set status = 'revoked', revoked_at = now(), revoked_reason = 'account_deleted'
     where id = v_link.id;
    return jsonb_build_object('error', 'invalid_grant');
  end if;

  if v_link.refresh_token_hash is distinct from p_refresh_hash then
    -- The previous token.
    if v_link.rotated_at > now() - make_interval(secs => (v_cfg ->> 'refresh_retry_grace_s')::integer) then
      return public.moonshine_issue_tokens(v_link.id, p_new_access_hash, p_new_refresh_hash);
    end if;
    update public.moonshine_device_links
       set status = 'revoked', revoked_at = now(), revoked_reason = 'refresh_token_reuse'
     where id = v_link.id;
    return jsonb_build_object('error', 'invalid_grant', 'reason', 'refresh_token_reuse');
  end if;

  if v_link.refresh_expires_at < now() then
    update public.moonshine_device_links
       set status = 'revoked', revoked_at = now(), revoked_reason = 'refresh_token_expired'
     where id = v_link.id;
    return jsonb_build_object('error', 'invalid_grant', 'reason', 'refresh_token_expired');
  end if;

  update public.moonshine_device_links
     set prev_refresh_hash = refresh_token_hash, rotated_at = now()
   where id = v_link.id;
  return public.moonshine_issue_tokens(v_link.id, p_new_access_hash, p_new_refresh_hash);
end;
$$;

-- Game: unlink itself, with either of its tokens. Idempotent.
create or replace function public.moonshine_device_revoke(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  update public.moonshine_device_links
     set status = 'revoked', revoked_at = coalesce(revoked_at, now()),
         revoked_reason = coalesce(revoked_reason, 'revoked_by_device')
   where access_token_hash = p_token_hash or refresh_token_hash = p_token_hash
  returning id into v_id;
  return jsonb_build_object('revoked', v_id is not null);
end;
$$;

-- Every authenticated API call: who holds this access token?
create or replace function public.moonshine_authenticate(p_access_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link public.moonshine_device_links;
begin
  select * into v_link from public.moonshine_device_links where access_token_hash = p_access_hash;
  if not found or v_link.status <> 'active' then
    return jsonb_build_object('error', 'invalid_token');
  end if;
  if v_link.access_expires_at < now() then
    return jsonb_build_object('error', 'token_expired');
  end if;
  if not exists (select 1 from public.profiles where id = v_link.user_id and deleted_at is null) then
    return jsonb_build_object('error', 'invalid_token');
  end if;
  if v_link.last_used_at is null or v_link.last_used_at < now() - interval '5 minutes' then
    update public.moonshine_device_links set last_used_at = now() where id = v_link.id;
  end if;
  return jsonb_build_object('link_id', v_link.id, 'user_id', v_link.user_id,
                            'user', public.moonshine_link_user_json(v_link.user_id));
end;
$$;

-- Website: what is asking to link? Shown before the player approves.
create or replace function public.moonshine_link_lookup(p_user_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rate jsonb;
  v_link public.moonshine_device_links;
begin
  if auth.uid() is null or not public.is_active_account() then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  v_rate := public.moonshine_rate_limit_hit('link_lookup', auth.uid()::text,
              (public.moonshine_config() ->> 'link_lookups_per_10min')::integer, 600);
  if not (v_rate ->> 'allowed')::boolean then
    return jsonb_build_object('error', 'rate_limited', 'retry_after_s', (v_rate ->> 'retry_after_s')::integer);
  end if;

  select * into v_link from public.moonshine_device_links
   where user_code_hash = public.moonshine_user_code_hash(p_user_code)
     and status = 'pending' and code_expires_at > now();
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('status', 'pending', 'client_name', v_link.client_name,
                            'client_version', v_link.client_version,
                            'requested_at', v_link.created_at, 'expires_at', v_link.code_expires_at);
end;
$$;

-- Website: approve or deny. Approval binds the link to the signed-in account.
create or replace function public.moonshine_link_decide(p_user_code text, p_approve boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_rate   jsonb;
  v_link   public.moonshine_device_links;
  v_active integer;
begin
  if v_uid is null or not public.is_active_account() then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  v_rate := public.moonshine_rate_limit_hit('link_lookup', v_uid::text,
              (public.moonshine_config() ->> 'link_lookups_per_10min')::integer, 600);
  if not (v_rate ->> 'allowed')::boolean then
    return jsonb_build_object('error', 'rate_limited', 'retry_after_s', (v_rate ->> 'retry_after_s')::integer);
  end if;

  select * into v_link from public.moonshine_device_links
   where user_code_hash = public.moonshine_user_code_hash(p_user_code)
     and status = 'pending' and code_expires_at > now()
   for update;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;

  if not coalesce(p_approve, false) then
    update public.moonshine_device_links set status = 'denied', decided_at = now() where id = v_link.id;
    return jsonb_build_object('status', 'denied');
  end if;

  perform pg_advisory_xact_lock(hashtext('moonshine_links:' || v_uid::text));
  select count(*) into v_active from public.moonshine_device_links
   where user_id = v_uid and status in ('approved', 'active');
  if v_active >= (public.moonshine_config() ->> 'max_linked_devices')::integer then
    return jsonb_build_object('error', 'too_many_devices');
  end if;

  update public.moonshine_device_links
     set status = 'approved', user_id = v_uid, decided_at = now()
   where id = v_link.id;
  return jsonb_build_object('status', 'approved', 'client_name', v_link.client_name);
end;
$$;

-- Website: the signed-in account's linked devices.
create or replace function public.moonshine_my_device_links()
returns table (
  id               uuid,
  client_name      text,
  client_version   text,
  status           text,
  linked_at        timestamptz,
  last_used_at     timestamptz,
  expires_at       timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select l.id, l.client_name, l.client_version, l.status,
         coalesce(l.tokens_issued_at, l.decided_at), l.last_used_at, l.refresh_expires_at
    from public.moonshine_device_links l
   where l.user_id = auth.uid() and l.status in ('approved', 'active')
   order by coalesce(l.tokens_issued_at, l.decided_at) desc;
$$;

-- Website: unlink a device. Takes effect on the device's next request.
create or replace function public.moonshine_revoke_device_link(p_link_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  update public.moonshine_device_links
     set status = 'revoked', revoked_at = now(), revoked_reason = 'revoked_by_user'
   where id = p_link_id and user_id = auth.uid() and status in ('approved', 'active')
  returning id into v_id;
  return v_id is not null;
end;
$$;

-- ============================================================================
-- Upload sessions
-- ============================================================================
-- create -> PUT content (validated) -> publish. Each step is safe to repeat.

create table if not exists public.moonshine_uploads (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid        not null references public.profiles (id) on delete cascade,
  link_id            uuid references public.moonshine_device_links (id) on delete set null,
  ghost_id           uuid        not null unique default gen_random_uuid(),
  idempotency_key    text,
  byte_length        integer     not null,
  content_sha256     text        not null,
  filename           text,
  title              text,
  description        text,
  tas_declared       boolean,
  status             text        not null default 'awaiting_content',
  staging_path       text        not null,
  staging_cleaned    boolean     not null default false,
  validation         jsonb,
  error_code         text,
  error_detail       text,
  content_attempts   integer     not null default 0,
  published_ghost_id uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  expires_at         timestamptz not null,
  published_at       timestamptz,

  constraint moonshine_uploads_status
    check (status in ('awaiting_content', 'validated', 'published', 'rejected', 'expired', 'cancelled')),
  constraint moonshine_uploads_length
    check (byte_length between 1 and 1297992),
  constraint moonshine_uploads_sha
    check (content_sha256 ~ '^[0-9a-f]+$' and char_length(content_sha256) = 64),
  constraint moonshine_uploads_idempotency_key
    check (idempotency_key is null or (char_length(idempotency_key) between 1 and 64
                                       and idempotency_key ~ '^[A-Za-z0-9_.:-]+$')),
  constraint moonshine_uploads_title
    check (title is null or char_length(btrim(title)) between 1 and 100),
  constraint moonshine_uploads_description
    check (description is null or char_length(description) <= 2000),
  constraint moonshine_uploads_filename
    check (filename is null or char_length(filename) between 1 and 200),
  constraint moonshine_uploads_idempotency unique (user_id, idempotency_key)
);

create unique index if not exists moonshine_uploads_open_sha_idx
  on public.moonshine_uploads (user_id, content_sha256)
  where status in ('awaiting_content', 'validated');
create index if not exists moonshine_uploads_cleanup_idx
  on public.moonshine_uploads (staging_cleaned, status, expires_at);

alter table public.moonshine_uploads enable row level security;
revoke all on public.moonshine_uploads from anon, authenticated;

create or replace function public.moonshine_upload_json(u public.moonshine_uploads)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'upload_id',    u.id,
    'status',       case when u.status in ('awaiting_content', 'validated') and u.expires_at < now()
                         then 'expired' else u.status end,
    'byte_length',  u.byte_length,
    'sha256',       u.content_sha256,
    'ghost_id',     case when u.status = 'published' then u.published_ghost_id end,
    'expires_at',   u.expires_at,
    'created_at',   u.created_at,
    'validation',   u.validation,
    'error',        case when u.error_code is null then null
                         else jsonb_build_object('code', u.error_code, 'detail', u.error_detail) end
  );
$$;

revoke all on function public.moonshine_upload_json(public.moonshine_uploads) from public, anon, authenticated;

-- A published ghost with these bytes, preferring one owned by p_user_id.
create or replace function public.moonshine_find_published(p_sha256 text, p_user_id uuid)
returns table (ghost_id uuid, owner_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select g.id, g.user_id
    from public.ghost_moonshine_index i
    join public.ghosts g on g.id = i.ghost_id and g.file_path = i.file_path and g.file_size = i.byte_length
   where i.content_sha256 = p_sha256
   order by (g.user_id = p_user_id) desc, g.created_at asc
   limit 1;
$$;

create or replace function public.moonshine_upload_create(
  p_user_id         uuid,
  p_link_id         uuid,
  p_byte_length     integer,
  p_sha256          text,
  p_filename        text,
  p_title           text,
  p_description     text,
  p_tas_declared    boolean,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cfg      jsonb := public.moonshine_config();
  v_sha      text  := lower(coalesce(p_sha256, ''));
  v_existing public.moonshine_uploads;
  v_pub      record;
  v_rate     jsonb;
  v_open     integer;
  v_id       uuid  := gen_random_uuid();
begin
  if not exists (select 1 from public.profiles where id = p_user_id and deleted_at is null) then
    return jsonb_build_object('error', 'invalid_token');
  end if;
  if p_byte_length is null or p_byte_length < 1 then
    return jsonb_build_object('error', 'invalid_request', 'detail', 'byte_length');
  end if;
  if p_byte_length > (v_cfg ->> 'max_upload_bytes')::integer then
    return jsonb_build_object('error', 'too_large');
  end if;
  if v_sha !~ '^[0-9a-f]+$' or char_length(v_sha) <> 64 then
    return jsonb_build_object('error', 'invalid_request', 'detail', 'sha256');
  end if;

  -- Serialise this user's session bookkeeping.
  perform pg_advisory_xact_lock(hashtext('moonshine_uploads:' || p_user_id::text));

  if p_idempotency_key is not null then
    select * into v_existing from public.moonshine_uploads
     where user_id = p_user_id and idempotency_key = p_idempotency_key;
    if found then
      if v_existing.content_sha256 <> v_sha or v_existing.byte_length <> p_byte_length then
        return jsonb_build_object('error', 'idempotency_key_reused');
      end if;
      return jsonb_build_object('result', 'existing', 'upload', public.moonshine_upload_json(v_existing));
    end if;
  end if;

  select * into v_pub from public.moonshine_find_published(v_sha, p_user_id);
  if v_pub.ghost_id is not null then
    if v_pub.owner_id = p_user_id then
      return jsonb_build_object('result', 'already_published', 'ghost_id', v_pub.ghost_id);
    end if;
    return jsonb_build_object('error', 'duplicate_content', 'ghost_id', v_pub.ghost_id);
  end if;

  select * into v_existing from public.moonshine_uploads
   where user_id = p_user_id and content_sha256 = v_sha
     and status in ('awaiting_content', 'validated') and expires_at > now();
  if found then
    return jsonb_build_object('result', 'existing', 'upload', public.moonshine_upload_json(v_existing));
  end if;

  -- An expired-but-unswept session must not block a new one for the same bytes.
  update public.moonshine_uploads set status = 'expired', updated_at = now()
   where user_id = p_user_id and status in ('awaiting_content', 'validated') and expires_at <= now();

  v_rate := public.moonshine_rate_limit_hit('upload_create', p_user_id::text,
              (v_cfg ->> 'upload_creates_per_hour')::integer, 3600);
  if not (v_rate ->> 'allowed')::boolean then
    return jsonb_build_object('error', 'rate_limited', 'retry_after_s', (v_rate ->> 'retry_after_s')::integer);
  end if;

  select count(*) into v_open from public.moonshine_uploads
   where user_id = p_user_id and status in ('awaiting_content', 'validated');
  if v_open >= (v_cfg ->> 'max_open_uploads')::integer then
    return jsonb_build_object('error', 'too_many_open_uploads');
  end if;

  begin
    insert into public.moonshine_uploads (
      id, user_id, link_id, idempotency_key, byte_length, content_sha256, filename, title,
      description, tas_declared, staging_path, expires_at
    ) values (
      v_id, p_user_id, p_link_id, p_idempotency_key, p_byte_length, v_sha,
      nullif(btrim(coalesce(p_filename, '')), ''), nullif(btrim(coalesce(p_title, '')), ''),
      nullif(btrim(coalesce(p_description, '')), ''), p_tas_declared,
      p_user_id::text || '/' || v_id::text || '.smsghost',
      now() + make_interval(secs => (v_cfg ->> 'upload_session_ttl_s')::integer)
    )
    returning * into v_existing;
  exception when check_violation then
    return jsonb_build_object('error', 'invalid_request', 'detail', 'title, description, filename or idempotency key');
  end;

  return jsonb_build_object('result', 'created', 'upload', public.moonshine_upload_json(v_existing));
end;
$$;

create or replace function public.moonshine_upload_get(p_user_id uuid, p_upload_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_upload public.moonshine_uploads;
begin
  update public.moonshine_uploads set status = 'expired', updated_at = now()
   where id = p_upload_id and status in ('awaiting_content', 'validated') and expires_at < now();
  select * into v_upload from public.moonshine_uploads where id = p_upload_id and user_id = p_user_id;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('upload', public.moonshine_upload_json(v_upload),
                            'staging_path', v_upload.staging_path,
                            'ghost_id', v_upload.ghost_id,
                            'filename', v_upload.filename,
                            'title', v_upload.title,
                            'description', v_upload.description,
                            'tas_declared', v_upload.tas_declared);
end;
$$;

-- Before the Edge Function reads a request body: may content be sent now?
create or replace function public.moonshine_upload_begin_content(p_user_id uuid, p_upload_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_upload public.moonshine_uploads;
begin
  select * into v_upload from public.moonshine_uploads
   where id = p_upload_id and user_id = p_user_id
   for update;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_upload.status in ('awaiting_content', 'validated') and v_upload.expires_at < now() then
    update public.moonshine_uploads set status = 'expired', updated_at = now() where id = v_upload.id;
    return jsonb_build_object('error', 'upload_expired');
  end if;
  if v_upload.status not in ('awaiting_content', 'validated') then
    return jsonb_build_object('error', 'upload_closed', 'upload', public.moonshine_upload_json(v_upload));
  end if;
  if v_upload.content_attempts >= (public.moonshine_config() ->> 'max_content_attempts')::integer then
    return jsonb_build_object('error', 'too_many_attempts');
  end if;
  update public.moonshine_uploads
     set content_attempts = content_attempts + 1, updated_at = now()
   where id = v_upload.id;
  return jsonb_build_object('ok', true, 'byte_length', v_upload.byte_length,
                            'sha256', v_upload.content_sha256, 'staging_path', v_upload.staging_path,
                            'status', v_upload.status);
end;
$$;

-- After validating bytes that matched the declared hash: record the verdict.
-- The bytes are fixed by the hash, so a rejection is final.
create or replace function public.moonshine_upload_finish_content(
  p_user_id    uuid,
  p_upload_id  uuid,
  p_valid      boolean,
  p_validation jsonb,
  p_error_code text,
  p_detail     text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_upload public.moonshine_uploads;
begin
  update public.moonshine_uploads
     set status       = case when p_valid then 'validated' else 'rejected' end,
         validation   = p_validation,
         error_code   = case when p_valid then null else p_error_code end,
         error_detail = case when p_valid then null else left(p_detail, 300) end,
         updated_at   = now()
   where id = p_upload_id and user_id = p_user_id and status in ('awaiting_content', 'validated')
  returning * into v_upload;
  if not found then
    select * into v_upload from public.moonshine_uploads where id = p_upload_id and user_id = p_user_id;
    if not found then
      return jsonb_build_object('error', 'not_found');
    end if;
  end if;
  return jsonb_build_object('upload', public.moonshine_upload_json(v_upload));
end;
$$;

-- Publish: inserts the website row and its validation in one transaction.
-- The Edge Function has already written the object to p_file_path.
create or replace function public.moonshine_upload_publish(
  p_user_id   uuid,
  p_upload_id uuid,
  p_file_path text,
  p_title     text,
  p_level     text,
  p_time_ms   integer,
  p_is_tas    boolean,
  p_tags      text[],
  p_filename  text,
  p_validator text,
  p_fields    jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_upload public.moonshine_uploads;
  v_pub    record;
  v_index  jsonb;
begin
  select * into v_upload from public.moonshine_uploads
   where id = p_upload_id and user_id = p_user_id
   for update;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_upload.status = 'published' then
    return jsonb_build_object('result', 'already_published', 'ghost_id', v_upload.published_ghost_id);
  end if;
  if v_upload.status in ('awaiting_content', 'validated') and v_upload.expires_at < now() then
    update public.moonshine_uploads set status = 'expired', updated_at = now() where id = v_upload.id;
    return jsonb_build_object('error', 'upload_expired');
  end if;
  if v_upload.status <> 'validated' then
    return jsonb_build_object('error', 'not_validated', 'upload', public.moonshine_upload_json(v_upload));
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id and deleted_at is null) then
    return jsonb_build_object('error', 'invalid_token');
  end if;
  if p_file_path not like p_user_id::text || '/' || v_upload.ghost_id::text || '/%' then
    return jsonb_build_object('error', 'internal', 'detail', 'unexpected file path');
  end if;

  -- Someone may have published the same bytes since the session was opened.
  select * into v_pub from public.moonshine_find_published(v_upload.content_sha256, p_user_id);
  if v_pub.ghost_id is not null then
    if v_pub.owner_id <> p_user_id then
      return jsonb_build_object('error', 'duplicate_content', 'ghost_id', v_pub.ghost_id);
    end if;
    update public.moonshine_uploads
       set status = 'published', published_ghost_id = v_pub.ghost_id, published_at = now(), updated_at = now()
     where id = v_upload.id;
    return jsonb_build_object('result', 'already_published', 'ghost_id', v_pub.ghost_id, 'object_unused', true);
  end if;

  begin
    insert into public.ghosts (
      id, user_id, title, description, level, time_ms, file_path, original_filename,
      file_size, is_tas, moonshine_version, tags
    ) values (
      v_upload.ghost_id, p_user_id, p_title, v_upload.description, p_level, p_time_ms, p_file_path,
      p_filename, v_upload.byte_length, coalesce(p_is_tas, false), null, coalesce(p_tags, '{}')
    );
  exception
    when raise_exception then
      if sqlerrm = 'ghost_limit_reached' then
        return jsonb_build_object('error', 'ghost_limit_reached');
      end if;
      raise;
    when check_violation then
      return jsonb_build_object('error', 'invalid_request', 'detail', 'title, level or filename rejected by the archive');
  end;

  v_index := public.moonshine_index_put(
    v_upload.ghost_id, p_file_path, v_upload.byte_length, v_upload.content_sha256,
    'compatible', 'ok', null, p_validator, 'moonshine_api', p_fields
  );
  if v_index ? 'error' then
    raise exception 'moonshine_index_put failed: %', v_index;
  end if;

  update public.moonshine_uploads
     set status = 'published', published_ghost_id = v_upload.ghost_id,
         published_at = now(), updated_at = now()
   where id = v_upload.id;
  return jsonb_build_object('result', 'published', 'ghost_id', v_upload.ghost_id);
end;
$$;

create or replace function public.moonshine_upload_cancel(p_user_id uuid, p_upload_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_upload public.moonshine_uploads;
begin
  update public.moonshine_uploads set status = 'cancelled', updated_at = now()
   where id = p_upload_id and user_id = p_user_id and status in ('awaiting_content', 'validated')
  returning * into v_upload;
  if not found then
    select * into v_upload from public.moonshine_uploads where id = p_upload_id and user_id = p_user_id;
    if not found then
      return jsonb_build_object('error', 'not_found');
    end if;
  end if;
  return jsonb_build_object('upload', public.moonshine_upload_json(v_upload));
end;
$$;

-- Sweeper: expire stale sessions and hand back staging objects to delete.
create or replace function public.moonshine_uploads_claim_cleanup(p_limit integer default 20)
returns table (upload_id uuid, staging_path text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.moonshine_uploads set status = 'expired', updated_at = now()
   where status in ('awaiting_content', 'validated') and expires_at < now();

  delete from public.moonshine_uploads
   where staging_cleaned and status <> 'published' and updated_at < now() - interval '30 days';

  return query
    select u.id, u.staging_path from public.moonshine_uploads u
     where not u.staging_cleaned and u.status in ('expired', 'rejected', 'cancelled', 'published')
     order by u.updated_at
     limit least(greatest(coalesce(p_limit, 20), 1), 100);
end;
$$;

create or replace function public.moonshine_uploads_mark_cleaned(p_upload_ids uuid[])
returns void
language sql
security definer
set search_path = ''
as $$
  update public.moonshine_uploads set staging_cleaned = true where id = any (p_upload_ids);
$$;

-- ============================================================================
-- Account deletion
-- ============================================================================
-- 0008 anonymises a deleted account's profile. Its devices stop working at
-- once (every token check also looks at deleted_at) and open uploads end.

create or replace function public.moonshine_on_profile_deleted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.moonshine_device_links
     set status = 'revoked', revoked_at = now(), revoked_reason = 'account_deleted'
   where user_id = new.id and status in ('approved', 'active');
  update public.moonshine_uploads set status = 'cancelled', updated_at = now()
   where user_id = new.id and status in ('awaiting_content', 'validated');
  return null;
end;
$$;

drop trigger if exists profiles_moonshine_deleted_trg on public.profiles;
create trigger profiles_moonshine_deleted_trg
  after update of deleted_at on public.profiles
  for each row
  when (old.deleted_at is null and new.deleted_at is not null)
  execute function public.moonshine_on_profile_deleted();

-- ============================================================================
-- Storage
-- ============================================================================

-- Private staging for API uploads between transfer and publish. No client
-- policies: only the Edge Function (service role) reads or writes it.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ghost-uploads', 'ghost-uploads', false, 1297992, array['application/octet-stream'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- A validated archive object is immutable: overwriting it in place would make
-- its recorded sha256 a lie. The website replaces files by uploading to a new
-- path instead (src/lib/ghosts.ts), which also clears the validation row.
drop policy if exists "ghosts_update_own_folder" on storage.objects;
create policy "ghosts_update_own_folder"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'ghosts'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.is_active_account()
    and not exists (select 1 from public.ghost_moonshine_index i where i.file_path = name)
  )
  with check (
    bucket_id = 'ghosts'
    and (storage.foldername(name))[1] = auth.uid()::text
    and storage.extension(name) = 'smsghost'
    and public.is_active_account()
  );

drop policy if exists "ghosts_delete_own_folder" on storage.objects;
create policy "ghosts_delete_own_folder"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'ghosts'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.is_active_account()
    and not exists (select 1 from public.ghost_moonshine_index i where i.file_path = name)
  );

-- ============================================================================
-- Grants
-- ============================================================================
-- Edge Function only.
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.moonshine_rate_limit_hit(text, text, integer, integer)',
    'public.moonshine_index_candidate(uuid)',
    'public.moonshine_index_put(uuid, text, integer, text, text, text, text, text, text, jsonb)',
    'public.moonshine_link_user_json(uuid)',
    'public.moonshine_device_start(text, text, text, text, text)',
    'public.moonshine_device_poll(text, text, text)',
    'public.moonshine_device_refresh(text, text, text)',
    'public.moonshine_device_revoke(text)',
    'public.moonshine_authenticate(text)',
    'public.moonshine_find_published(text, uuid)',
    'public.moonshine_upload_create(uuid, uuid, integer, text, text, text, text, boolean, text)',
    'public.moonshine_upload_get(uuid, uuid)',
    'public.moonshine_upload_begin_content(uuid, uuid)',
    'public.moonshine_upload_finish_content(uuid, uuid, boolean, jsonb, text, text)',
    'public.moonshine_upload_publish(uuid, uuid, text, text, text, integer, boolean, text[], text, text, jsonb)',
    'public.moonshine_upload_cancel(uuid, uuid)',
    'public.moonshine_uploads_claim_cleanup(integer)',
    'public.moonshine_uploads_mark_cleaned(uuid[])'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;

-- Website (signed-in players).
revoke all on function public.moonshine_link_lookup(text) from public, anon;
revoke all on function public.moonshine_link_decide(text, boolean) from public, anon;
revoke all on function public.moonshine_my_device_links() from public, anon;
revoke all on function public.moonshine_revoke_device_link(uuid) from public, anon;
grant execute on function public.moonshine_link_lookup(text) to authenticated;
grant execute on function public.moonshine_link_decide(text, boolean) to authenticated;
grant execute on function public.moonshine_my_device_links() to authenticated;
grant execute on function public.moonshine_revoke_device_link(uuid) to authenticated;
grant execute on function public.moonshine_user_code_hash(text) to anon, authenticated, service_role;
grant execute on function public.moonshine_feature_names(bigint) to anon, authenticated, service_role;
