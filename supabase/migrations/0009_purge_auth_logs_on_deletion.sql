-- ============================================================================
-- Delfino Ghosts - purge sign-in logs when an account is deleted
-- ----------------------------------------------------------------------------
-- Supabase Auth writes an audit log (auth.audit_log_entries) of sign-ups,
-- sign-ins, token refreshes, password resets and so on, with the IP address
-- each came from. Those rows are not tied to auth.users by a foreign key, so
-- they survive account deletion. This replaces anonymize_deleted_user() from
-- 0008 so the same trigger also removes every entry about the deleted user.
--
-- Sessions and refresh tokens (which also carry IP and user agent) already go
-- with the auth.users row via Supabase's own cascades.
-- ============================================================================

create or replace function public.anonymize_deleted_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n    bigint;
  v_name text;
begin
  -- The download log only served the per-user cooldown; the counters it fed
  -- have already moved and stay as they are. Nothing else needs these rows.
  delete from public.ghost_downloads where user_id = old.id;

  -- Sign-in history with IP addresses. The user appears as the actor of their
  -- own events, or in traits when an admin acted on the account.
  delete from auth.audit_log_entries
   where payload ->> 'actor_id' = old.id::text
      or payload -> 'traits' ->> 'user_id' = old.id::text;

  -- Skip any number already in use (e.g. a name that predates the reservation).
  loop
    v_n    := nextval('public.anonymous_profile_seq');
    v_name := 'anonymous-' || v_n;
    exit when not exists (select 1 from public.profiles where username_lower = v_name);
  end loop;

  -- total_ghosts / total_downloads are untouched: the update trigger pins them.
  update public.profiles
     set username     = v_name,
         display_name = 'Anonymous ' || v_n,
         avatar_url   = null,
         bio          = null,
         deleted_at   = now()
   where id = old.id;

  return old;
end;
$$;
