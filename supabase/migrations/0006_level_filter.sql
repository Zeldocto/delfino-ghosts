-- ============================================================================
-- Delfino Ghosts - 0006: filter Browse by level
-- ----------------------------------------------------------------------------
-- Adds a `p_level` argument to list_ghosts so the archive can be narrowed to a
-- single level ("show me every Pinna Park 3 ghost"), and a levels_in_use()
-- helper that returns the levels actually present along with their counts, so
-- the dropdown only ever offers levels that will return something.
--
-- Matching is case-insensitive and uses the existing lower(level) index.
--
-- Safe to run on a live database: it replaces one function and adds another.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- levels_in_use()
-- ----------------------------------------------------------------------------
-- Grouped on lower(level) so "Pinna Park 3" and "pinna park 3" collapse into a
-- single entry; min(level) picks a stable representative spelling. The result
-- set is one row per distinct level - tens of rows, not thousands - and the
-- frontend fetches it once per page load.

create or replace function public.levels_in_use()
returns table (level text, ghost_count bigint)
language sql
stable
set search_path = ''
as $$
  select min(g.level) as level, count(*) as ghost_count
    from public.ghosts g
   where g.level is not null and btrim(g.level) <> ''
   group by lower(g.level)
   order by count(*) desc, lower(min(g.level)) asc;
$$;

grant execute on function public.levels_in_use() to anon, authenticated;

-- ----------------------------------------------------------------------------
-- list_ghosts() with a level filter
-- ----------------------------------------------------------------------------
-- Dropped first because the argument list changes.

drop function if exists public.list_ghosts(text, text, uuid, integer, integer);

create or replace function public.list_ghosts(
  p_search text default null,
  p_sort   text default 'recent',
  p_level  text default null,
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
  using p_user, v_search, v_limit, v_offset, v_level;
end;
$$;

grant execute on function public.list_ghosts(text, text, text, uuid, integer, integer)
  to anon, authenticated;
