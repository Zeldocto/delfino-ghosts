-- ============================================================================
-- Delfino Ghosts - self-serve account deletion
-- ----------------------------------------------------------------------------
-- Deleting an account removes the login (email, password, sessions) but keeps
-- the archive intact: the profile row survives as "Anonymous N", its ghosts
-- stay downloadable, and its counted downloads still stand.
--
-- How it fits together:
--   * profiles no longer cascades from auth.users, so removing the login does
--     not take the ghosts with it.
--   * An AFTER DELETE trigger on auth.users anonymises the profile. It fires
--     however the user is removed - through delete_own_account() or by hand in
--     the Supabase dashboard - so neither path can leave a named orphan.
--   * delete_own_account() is the client entry point. It can only ever delete
--     the caller.
--   * The caller's access token stays valid until it expires (up to an hour).
--     The write policies below check is_active_account() so that token cannot
--     edit, delete or upload anything once the account is gone.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Detach profiles from auth.users
-- ----------------------------------------------------------------------------
-- The constraint name is generated, so find it rather than assume it.
do $$
declare
  r record;
begin
  for r in
    select conname
      from pg_constraint
     where conrelid  = 'public.profiles'::regclass
       and confrelid = 'auth.users'::regclass
       and contype   = 'f'
  loop
    execute format('alter table public.profiles drop constraint %I', r.conname);
  end loop;
end;
$$;

alter table public.profiles add column if not exists deleted_at timestamptz;

-- ----------------------------------------------------------------------------
-- 2. Reserve the anonymous-N namespace
-- ----------------------------------------------------------------------------
-- Only deleted accounts may be called "anonymous" or "anonymous-<number>", so
-- nobody can pose as a departed runner. NOT VALID leaves any pre-existing name
-- alone; every new signup and rename is checked. handle_new_user() already
-- retries with a derived name on check_violation, so signup cannot dead-end.
alter table public.profiles drop constraint if exists profiles_anonymous_reserved;
alter table public.profiles
  add constraint profiles_anonymous_reserved
  check (deleted_at is not null or lower(username) !~ '^anonymous(-[0-9]+)?$')
  not valid;

create sequence if not exists public.anonymous_profile_seq;
revoke all on sequence public.anonymous_profile_seq from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3. Anonymise on deletion
-- ----------------------------------------------------------------------------
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

drop trigger if exists on_auth_user_deleted on auth.users;
create trigger on_auth_user_deleted
  after delete on auth.users
  for each row execute function public.anonymize_deleted_user();

-- ----------------------------------------------------------------------------
-- 4. delete_own_account()
-- ----------------------------------------------------------------------------
create or replace function public.delete_own_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  delete from auth.users where id = v_uid;
end;
$$;

revoke all on function public.delete_own_account() from public, anon;
grant execute on function public.delete_own_account() to authenticated;

-- ----------------------------------------------------------------------------
-- 5. Shut out the leftover access token
-- ----------------------------------------------------------------------------
create or replace function public.is_active_account()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid() and deleted_at is null
  );
$$;

revoke all on function public.is_active_account() from public;
grant execute on function public.is_active_account() to anon, authenticated;

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
  on public.profiles for update
  to authenticated
  using (auth.uid() = id and deleted_at is null)
  with check (auth.uid() = id and deleted_at is null);

drop policy if exists ghosts_insert_own on public.ghosts;
create policy ghosts_insert_own
  on public.ghosts for insert
  to authenticated
  with check (auth.uid() = user_id and public.is_active_account());

drop policy if exists ghosts_update_own on public.ghosts;
create policy ghosts_update_own
  on public.ghosts for update
  to authenticated
  using (auth.uid() = user_id and public.is_active_account())
  with check (auth.uid() = user_id and public.is_active_account());

drop policy if exists ghosts_delete_own on public.ghosts;
create policy ghosts_delete_own
  on public.ghosts for delete
  to authenticated
  using (auth.uid() = user_id and public.is_active_account());

drop policy if exists "ghosts_insert_own_folder" on storage.objects;
create policy "ghosts_insert_own_folder"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'ghosts'
    and (storage.foldername(name))[1] = auth.uid()::text
    and array_length(storage.foldername(name), 1) = 2
    and storage.extension(name) = 'smsghost'
    and public.is_active_account()
  );

drop policy if exists "ghosts_update_own_folder" on storage.objects;
create policy "ghosts_update_own_folder"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'ghosts'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.is_active_account()
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
  );

-- A leftover token must not be able to count downloads either: that would
-- recreate the log rows the trigger just removed.
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
  if v_uid is null or not public.is_active_account() then
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
