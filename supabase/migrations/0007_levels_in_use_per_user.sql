-- ============================================================================
-- Delfino Ghosts - 0007: levels_in_use() per user
-- ----------------------------------------------------------------------------
-- Adds an optional p_user argument so a profile page can list only the levels
-- that runner has ghosts for, with their counts.
--
-- RECOVERED 2026-10-24: this migration was applied to the live project but the
-- file was never committed. The function body below is pg_get_functiondef()
-- output from the live database, so it is exactly what is deployed. It is safe
-- to re-run (it only replaces the function).
-- ============================================================================

drop function if exists public.levels_in_use();

CREATE OR REPLACE FUNCTION public.levels_in_use(p_user uuid DEFAULT NULL::uuid)
 RETURNS TABLE(level text, ghost_count bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select min(g.level) as level, count(*) as ghost_count
    from public.ghosts g
   where g.level is not null and btrim(g.level) <> ''
     and (p_user is null or g.user_id = p_user)
   group by lower(g.level)
   order by count(*) desc, lower(min(g.level)) asc;
$function$;

grant execute on function public.levels_in_use(uuid) to anon, authenticated;
