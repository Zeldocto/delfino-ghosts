-- ============================================================================
-- Delfino Ghosts - 0011: TAS filter for list_ghosts
-- ----------------------------------------------------------------------------
-- Adds p_tas to list_ghosts for the Browse "TAS" checkbox: null means no
-- filter, true only TAS runs, false only non-TAS runs.
--
-- RECOVERED 2026-10-24: this migration was applied to the live project but the
-- file was never committed. The function body below is pg_get_functiondef()
-- output from the live database, so it is exactly what is deployed. It is safe
-- to re-run (it drops the 0006 signature and replaces the function).
-- ============================================================================

drop function if exists public.list_ghosts(text, text, text, uuid, integer, integer);

CREATE OR REPLACE FUNCTION public.list_ghosts(p_search text DEFAULT NULL::text, p_sort text DEFAULT 'recent'::text, p_level text DEFAULT NULL::text, p_user uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 25, p_offset integer DEFAULT 0, p_tas boolean DEFAULT NULL::boolean)
 RETURNS TABLE(id uuid, user_id uuid, title text, description text, level text, time_ms integer, file_path text, original_filename text, file_size integer, is_tas boolean, moonshine_version text, tags text[], download_count integer, created_at timestamp with time zone, updated_at timestamp with time zone, author_username text, author_display_name text, author_total_downloads bigint, total_count bigint)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
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
       and ($6::boolean is null or g.is_tas = $6::boolean)
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
  using p_user, v_search, v_limit, v_offset, v_level, p_tas;
end;
$function$;

grant execute on function public.list_ghosts(text, text, text, uuid, integer, integer, boolean)
  to anon, authenticated;
