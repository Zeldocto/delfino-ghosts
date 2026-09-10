-- ============================================================================
-- Delfino Ghosts - 0004: level and time
-- ----------------------------------------------------------------------------
-- Adds the two things every SMS ghost is actually identified by: which level
-- it is for, and what time it achieves.
--
-- Time is stored as integer milliseconds rather than text so it can be sorted
-- and compared. Formatting for display is the frontend's job.
--
-- Both columns are nullable: ghosts uploaded before this migration have no
-- level or time, and the archive should keep serving them rather than hiding
-- them. The upload form asks for both going forward.
--
-- Safe to run on a live database. The search vector is dropped and rebuilt so
-- existing rows pick up their level text; on a large archive that rewrite takes
-- a moment.
-- ============================================================================

alter table public.ghosts
  add column if not exists level   text,
  add column if not exists time_ms integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ghosts_level_len') then
    alter table public.ghosts
      add constraint ghosts_level_len
      check (level is null or char_length(btrim(level)) between 1 and 48);
  end if;

  -- Upper bound is 24 hours; enough for any conceivable run, low enough that a
  -- junk value cannot be stored.
  if not exists (select 1 from pg_constraint where conname = 'ghosts_time_ms_range') then
    alter table public.ghosts
      add constraint ghosts_time_ms_range
      check (time_ms is null or (time_ms > 0 and time_ms <= 86400000));
  end if;
end;
$$;

-- Ranking runs within a level is the obvious query, so index it that way.
create index if not exists ghosts_level_time_idx
  on public.ghosts (lower(level), time_ms asc);
create index if not exists ghosts_time_idx
  on public.ghosts (time_ms asc);

-- ----------------------------------------------------------------------------
-- Search: fold the level into the document
-- ----------------------------------------------------------------------------
-- The generated column has to be dropped and rebuilt: replacing the function
-- alone would leave existing rows holding their old vectors.

create or replace function public.ghost_search_document(
  p_title       text,
  p_description text,
  p_tags        text[],
  p_level       text default null
)
returns tsvector
language sql
immutable
set search_path = ''
as $$
  select to_tsvector('simple',
    coalesce(p_title, '') || ' ' ||
    coalesce(p_level, '') || ' ' ||
    coalesce(p_description, '') || ' ' ||
    coalesce(array_to_string(coalesce(p_tags, '{}'::text[]), ' '), '')
  );
$$;

alter table public.ghosts drop column if exists search_vector;

alter table public.ghosts
  add column search_vector tsvector
  generated always as (public.ghost_search_document(title, description, tags, level)) stored;

create index if not exists ghosts_search_idx on public.ghosts using gin (search_vector);

-- ----------------------------------------------------------------------------
-- Normalisation on write
-- ----------------------------------------------------------------------------
-- Trim the level the same way title and description are trimmed, and treat an
-- empty string as absent.

create or replace function public.ghosts_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if auth.uid() is not null then
    new.user_id := auth.uid();
  end if;

  new.download_count := 0;
  new.title          := btrim(new.title);
  new.description    := nullif(btrim(coalesce(new.description, '')), '');
  new.level          := nullif(btrim(coalesce(new.level, '')), '');
  new.tags           := public.normalize_tags(new.tags);
  new.created_at     := now();
  new.updated_at     := now();

  perform pg_advisory_xact_lock(hashtext('delfino_ghost_limit:' || new.user_id::text));

  select count(*) into v_count from public.ghosts where user_id = new.user_id;

  if v_count >= 200 then
    raise exception 'ghost_limit_reached'
      using errcode = 'P0001',
            hint = 'This account already holds the maximum of 200 ghosts.';
  end if;

  return new;
end;
$$;

create or replace function public.ghosts_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.user_id    := old.user_id;
  new.created_at := old.created_at;
  new.updated_at := now();

  if current_setting('delfino.counter_ctx', true) is distinct from 'on' then
    new.download_count := old.download_count;
  end if;

  new.title       := btrim(new.title);
  new.description := nullif(btrim(coalesce(new.description, '')), '');
  new.level       := nullif(btrim(coalesce(new.level, '')), '');
  new.tags        := public.normalize_tags(new.tags);

  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- list_ghosts: return the new columns, and allow sorting by time
-- ----------------------------------------------------------------------------
-- Dropped first because the return type changes.

drop function if exists public.list_ghosts(text, text, uuid, integer, integer);

create or replace function public.list_ghosts(
  p_search text default null,
  p_sort   text default 'recent',
  p_user   uuid default null,
  p_limit  integer default 25,
  p_offset integer default 0
)
returns table (
  id                uuid,
  user_id           uuid,
  title             text,
  description       text,
  level             text,
  time_ms           integer,
  file_path         text,
  original_filename text,
  file_size         integer,
  is_tas            boolean,
  moonshine_version text,
  tags              text[],
  download_count    integer,
  created_at        timestamptz,
  updated_at        timestamptz,
  author_username   text,
  author_display_name text,
  author_total_downloads bigint,
  total_count       bigint
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_order  text;
  v_limit  integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_search text    := nullif(btrim(coalesce(p_search, '')), '');
begin
  v_order := case coalesce(p_sort, 'recent')
    when 'recent'    then 'g.created_at desc, g.id desc'
    when 'oldest'    then 'g.created_at asc, g.id asc'
    when 'downloads' then 'g.download_count desc, g.created_at desc, g.id desc'
    when 'updated'   then 'g.updated_at desc, g.id desc'
    when 'title'     then 'lower(g.title) asc, g.id asc'
    -- Ghosts with no recorded time sort last rather than first.
    when 'time'      then 'g.time_ms asc nulls last, g.created_at desc, g.id desc'
    else 'g.created_at desc, g.id desc'
  end;

  return query execute format($q$
    select g.id, g.user_id, g.title, g.description, g.level, g.time_ms, g.file_path,
           g.original_filename, g.file_size, g.is_tas, g.moonshine_version,
           g.tags, g.download_count, g.created_at, g.updated_at,
           p.username, p.display_name, p.total_downloads,
           count(*) over () as total_count
      from public.ghosts g
      join public.profiles p on p.id = g.user_id
     where ($1::uuid is null or g.user_id = $1::uuid)
       and (
         $2::text is null
         or g.search_vector @@ websearch_to_tsquery('simple', $2::text)
         or p.username_lower like lower($2::text) || '%%'
         or g.title ilike '%%' || $2::text || '%%'
         or g.level ilike '%%' || $2::text || '%%'
       )
     order by %s
     limit $3 offset $4
  $q$, v_order)
  using p_user, v_search, v_limit, v_offset;
end;
$$;

grant execute on function public.list_ghosts(text, text, uuid, integer, integer) to anon, authenticated;
