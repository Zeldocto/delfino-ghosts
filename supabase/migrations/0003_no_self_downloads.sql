-- ============================================================================
-- Delfino Ghosts - 0003: do not count self-downloads
-- ----------------------------------------------------------------------------
-- A download only moves the counter when the person downloading is signed in
-- AND is not the ghost's author. Otherwise every upload could be inflated by
-- its owner, which would make the MDP ranking meaningless.
--
-- The file is still delivered in that case; only the bookkeeping changes.
--
-- Safe to run on an existing database: it replaces one function and touches no
-- data. Existing counters are left alone - see the note at the end if you want
-- to retroactively strip self-downloads that were counted before this ran.
-- ============================================================================

create or replace function public.record_authenticated_download(p_ghost_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_owner   uuid;
  v_count   integer;
  v_recent  boolean;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select user_id, download_count into v_owner, v_count
  from public.ghosts where id = p_ghost_id;

  if v_owner is null then
    raise exception 'ghost_not_found' using errcode = 'P0002';
  end if;

  -- Your own ghosts never count toward your own total.
  if v_owner = v_uid then
    return v_count;
  end if;

  -- Cooldown: the same account re-downloading the same ghost within an hour
  -- still gets the file, it just does not move the number again.
  select exists (
    select 1 from public.ghost_downloads
     where user_id = v_uid
       and ghost_id = p_ghost_id
       and created_at > now() - interval '1 hour'
  ) into v_recent;

  if v_recent then
    return v_count;
  end if;

  perform set_config('delfino.counter_ctx', 'on', true);

  update public.ghosts
     set download_count = download_count + 1
   where id = p_ghost_id
  returning download_count into v_count;

  update public.profiles
     set total_downloads = total_downloads + 1
   where id = v_owner;

  perform set_config('delfino.counter_ctx', 'off', true);

  insert into public.ghost_downloads (ghost_id, user_id) values (p_ghost_id, v_uid);

  return v_count;
end;
$$;

revoke all on function public.record_authenticated_download(uuid) from public, anon;
grant execute on function public.record_authenticated_download(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Optional cleanup
-- ----------------------------------------------------------------------------
-- Only useful if self-downloads were counted before this migration ran. It
-- subtracts logged self-downloads from each ghost, removes those log rows, then
-- rebuilds the profile aggregates. Review before running.
--
--   begin;
--     select set_config('delfino.counter_ctx', 'on', true);
--     update public.ghosts g
--        set download_count = greatest(g.download_count - s.n, 0)
--       from (
--         select d.ghost_id, count(*) as n
--           from public.ghost_downloads d
--           join public.ghosts gh on gh.id = d.ghost_id
--          where d.user_id = gh.user_id
--          group by d.ghost_id
--       ) s
--      where s.ghost_id = g.id;
--     delete from public.ghost_downloads d
--      using public.ghosts gh
--      where gh.id = d.ghost_id and d.user_id = gh.user_id;
--     select public.recompute_profile_stats();
--   commit;
