-- ============================================================================
-- TEST-ONLY stand-ins for migrations 0007 and 0011
-- ----------------------------------------------------------------------------
-- README and CLAUDE.md list 0007 (per-user levels_in_use) and 0011 (TAS filter
-- for list_ghosts), and the live project has both: on 2026-10-24 the public API
-- accepted levels_in_use(p_user) and list_ghosts(p_tas). The original files
-- were never committed. These reconstructions exist only so the local test
-- database matches the live signatures. NEVER run this against a real
-- project, and replace it with the real 0007/0011 files when they are found.
-- ============================================================================

drop function if exists public.levels_in_use();
create or replace function public.levels_in_use(p_user uuid default null)
returns table (level text, ghost_count bigint)
language sql
stable
set search_path = ''
as $$
  select min(g.level) as level, count(*) as ghost_count
    from public.ghosts g
   where g.level is not null and btrim(g.level) <> ''
     and (p_user is null or g.user_id = p_user)
   group by lower(g.level)
   order by count(*) desc, lower(min(g.level)) asc;
$$;
grant execute on function public.levels_in_use(uuid) to anon, authenticated;

drop function if exists public.list_ghosts(text, text, text, uuid, integer, integer);
create or replace function public.list_ghosts(
  p_search text default null,
  p_sort   text default 'recent',
  p_level  text default null,
  p_user   uuid default null,
  p_limit  integer default 25,
  p_offset integer default 0,
  p_tas    boolean default false
)
returns table (
  id uuid, user_id uuid, title text, description text, level text, time_ms integer,
  file_path text, original_filename text, file_size integer, is_tas boolean,
  moonshine_version text, tags text[], download_count integer, created_at timestamptz,
  updated_at timestamptz, author_username text, author_display_name text,
  author_total_downloads bigint, total_count bigint
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
  v_level  text    := nullif(btrim(coalesce(p_level, '')), '');
begin
  v_order := case coalesce(p_sort, 'recent')
    when 'recent'    then 'g.created_at desc, g.id desc'
    when 'oldest'    then 'g.created_at asc, g.id asc'
    when 'downloads' then 'g.download_count desc, g.created_at desc, g.id desc'
    when 'updated'   then 'g.updated_at desc, g.id desc'
    when 'title'     then 'lower(g.title) asc, g.id asc'
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
       and ($5::text is null or lower(g.level) = lower($5::text))
       and (not $6::boolean or g.is_tas)
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
  using p_user, v_search, v_limit, v_offset, v_level, coalesce(p_tas, false);
end;
$$;
grant execute on function public.list_ghosts(text, text, text, uuid, integer, integer, boolean)
  to anon, authenticated;
