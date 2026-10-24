-- ============================================================================
-- Delfino Ghosts - 0013: retention limits for Moonshine device and upload data
-- ----------------------------------------------------------------------------
-- 0012 kept some records longer than they are useful. This puts a clear end
-- date on each, so the privacy policy can state it plainly:
--
--   * Deleting an account deletes its linked-device records outright (0012
--     only revoked them). Open upload sessions are still cancelled, and the
--     sweeper removes them as below.
--   * An unlinked (revoked) device record is deleted 30 days after unlinking.
--   * Every finished upload session (published, rejected, cancelled or
--     expired) is deleted 30 days after it finished, once its staged file has
--     been removed. 0012 kept published sessions indefinitely.
--   * Rate-limit counters older than a day are deleted on every sweep, not
--     only at random.
--
-- The sweeper runs on every upload request. Safe to run on the live database;
-- it only replaces two functions and adds one.
-- ============================================================================

create or replace function public.moonshine_purge_old_records()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.moonshine_device_links
   where (status = 'revoked' and revoked_at < now() - interval '30 days')
      or (status in ('pending', 'denied', 'expired') and code_expires_at < now() - interval '1 day');

  delete from public.moonshine_uploads
   where staging_cleaned and updated_at < now() - interval '30 days';

  delete from public.moonshine_rate_limits
   where window_start < now() - interval '1 day';
$$;

revoke all on function public.moonshine_purge_old_records() from public, anon, authenticated;
grant execute on function public.moonshine_purge_old_records() to service_role;

create or replace function public.moonshine_uploads_claim_cleanup(p_limit integer default 20)
returns table (upload_id uuid, staging_path text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.moonshine_uploads set status = 'expired', updated_at = now()
   where status in ('awaiting_content', 'validated') and expires_at < now();

  perform public.moonshine_purge_old_records();

  return query
    select u.id, u.staging_path from public.moonshine_uploads u
     where not u.staging_cleaned and u.status in ('expired', 'rejected', 'cancelled', 'published')
     order by u.updated_at
     limit least(greatest(coalesce(p_limit, 20), 1), 100);
end;
$$;

create or replace function public.moonshine_on_profile_deleted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Device names and usage times go with the login; any token still on a
  -- device stops working because its row no longer exists.
  delete from public.moonshine_device_links where user_id = new.id;
  update public.moonshine_uploads set status = 'cancelled', updated_at = now()
   where user_id = new.id and status in ('awaiting_content', 'validated');
  return null;
end;
$$;
