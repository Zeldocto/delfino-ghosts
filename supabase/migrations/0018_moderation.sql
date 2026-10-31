-- ============================================================================
-- Delfino Ghosts - 0018: moderation (staff roles, ghost removal and editing,
-- account suspension, moderation log)
-- ----------------------------------------------------------------------------
-- Two roles, held in public.staff:
--   * admin      - everything a moderator can do, plus adding and removing
--                  moderators.
--   * moderator  - removes or edits any ghost; suspends and restores accounts.
-- Admins are granted only in the SQL editor (README section 4), never through
-- the website, so a compromised moderator or admin session cannot mint admins.
-- Who is staff is public (staff_directory), so names can be marked on the site.
--
-- Every rule is here, not in React. Clients have no grants on the tables;
-- they go through the SECURITY DEFINER functions below, which check the
-- caller's role from auth.uid() on every call.
--
-- Removing a ghost deletes the row exactly as an owner delete does (the
-- download log and Moonshine verdict cascade; ghosts_after_change keeps the
-- author's totals right). The file is then deleted by the ghost-storage Edge
-- Function, which lets staff delete an object outside their own folder once
-- no row points at it. Editing changes metadata only, never the file.
--
-- A suspended account is read-only: is_active_account() now also requires no
-- suspension, which blocks every owner-write policy (ghosts, profile, the old
-- storage policies), device linking and download counting. moonshine_authenticate
-- refuses its devices, and ghost-storage asks account_is_active(). The account
-- can still sign in, browse, download and delete itself. Staff cannot be
-- suspended; the admin removes the moderator role first.
--
-- A deleted account loses its role and any suspension (staff_on_profile_deleted).
-- Every action is recorded in public.moderation_log, readable only by staff.
--
-- Safe to run on a live database. Run this BEFORE deploying the ghost-storage
-- function from the same commit (it falls back to the old check if not, but
-- then suspensions are not enforced on uploads until this runs).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Tables
-- ----------------------------------------------------------------------------

create table if not exists public.staff (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  role       text        not null,
  granted_by uuid references public.profiles (id) on delete set null,
  granted_at timestamptz not null default now(),

  constraint staff_role check (role in ('admin', 'moderator'))
);

alter table public.staff enable row level security;
revoke all on public.staff from anon, authenticated;

create table if not exists public.account_suspensions (
  user_id      uuid primary key references public.profiles (id) on delete cascade,
  suspended_by uuid references public.profiles (id) on delete set null,
  suspended_at timestamptz not null default now(),
  reason       text,

  constraint account_suspensions_reason_len check (reason is null or char_length(reason) <= 500)
);

alter table public.account_suspensions enable row level security;
revoke all on public.account_suspensions from anon, authenticated;

create table if not exists public.moderation_log (
  id             bigint generated always as identity primary key,
  created_at     timestamptz not null default now(),
  actor_id       uuid references public.profiles (id) on delete set null,
  action         text not null,
  target_user_id uuid references public.profiles (id) on delete set null,
  -- No foreign key: a removed ghost no longer exists. Title and path are kept
  -- so the entry still says what was removed, and the file can be retried.
  ghost_id       uuid,
  ghost_title    text,
  file_path      text,
  reason         text,
  -- edit_ghost: {field: {"from": old, "to": new}} for each changed field.
  details        jsonb,

  constraint moderation_log_action check (action in (
    'remove_ghost', 'edit_ghost', 'suspend_account', 'unsuspend_account',
    'add_moderator', 'remove_moderator'
  )),
  constraint moderation_log_reason_len
    check (reason is null or char_length(reason) <= 500)
);

create index if not exists moderation_log_created_idx on public.moderation_log (created_at desc);

alter table public.moderation_log enable row level security;
revoke all on public.moderation_log from anon, authenticated;

-- ----------------------------------------------------------------------------
-- Account state
-- ----------------------------------------------------------------------------

-- Not deleted and not suspended. Internal, and for ghost-storage (service role).
create or replace function public.account_is_active(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.profiles where id = p_user_id and deleted_at is null)
     and not exists (select 1 from public.account_suspensions where user_id = p_user_id);
$$;

-- Same signature as 0008, so its grants and every policy that calls it carry over.
create or replace function public.is_active_account()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.account_is_active(auth.uid());
$$;

-- 0008 checked deleted_at directly here; a suspended account must not edit its profile either.
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
  on public.profiles for update
  to authenticated
  using (auth.uid() = id and public.is_active_account())
  with check (auth.uid() = id and public.is_active_account());

-- Identical to 0012 except the account check, so a suspended account's devices stop working.
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
  if not public.account_is_active(v_link.user_id) then
    return jsonb_build_object('error', 'invalid_token');
  end if;
  if v_link.last_used_at is null or v_link.last_used_at < now() - interval '5 minutes' then
    update public.moonshine_device_links set last_used_at = now() where id = v_link.id;
  end if;
  return jsonb_build_object('link_id', v_link.id, 'user_id', v_link.user_id,
                            'user', public.moonshine_link_user_json(v_link.user_id));
end;
$$;

-- ----------------------------------------------------------------------------
-- Role lookups
-- ----------------------------------------------------------------------------

-- Internal, and for the ghost-storage function (service role).
create or replace function public.staff_role_of(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.role
    from public.staff s
    join public.profiles p on p.id = s.user_id
   where s.user_id = p_user_id and p.deleted_at is null;
$$;

-- Raises unless the caller is active staff (or an admin, when p_admin).
create or replace function public.staff_require(p_admin boolean default false)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role text;
begin
  if auth.uid() is null or not public.is_active_account() then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  v_role := public.staff_role_of(auth.uid());
  if v_role is null or (p_admin and v_role <> 'admin') then
    raise exception '%', case when p_admin then 'not_admin' else 'not_staff' end using errcode = '42501';
  end if;
  return v_role;
end;
$$;

-- Website: the signed-in account's role and suspension (with the reason, so
-- the account holder is told why).
create or replace function public.my_moderation_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'role', public.staff_role_of(auth.uid()),
    'suspended', s.user_id is not null,
    'suspended_at', s.suspended_at,
    'reason', s.reason
  )
  from (select auth.uid() as uid) me
  left join public.account_suspensions s on s.user_id = me.uid;
$$;

-- Public: who is staff, so their names can be marked wherever they appear.
create or replace function public.staff_directory()
returns table (username text, role text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.username, s.role
    from public.staff s
    join public.profiles p on p.id = s.user_id
   where p.deleted_at is null;
$$;

-- ----------------------------------------------------------------------------
-- Ghost actions
-- ----------------------------------------------------------------------------

-- Staff: remove any ghost. Returns its file path for ghost-storage to delete.
create or replace function public.moderator_remove_ghost(p_ghost_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_ghost  public.ghosts;
begin
  perform public.staff_require(false);
  if char_length(v_reason) > 500 then
    raise exception 'reason_too_long' using errcode = '22023';
  end if;

  delete from public.ghosts where id = p_ghost_id returning * into v_ghost;
  if not found then
    raise exception 'ghost_not_found' using errcode = 'P0002';
  end if;

  insert into public.moderation_log (actor_id, action, target_user_id, ghost_id, ghost_title, file_path, reason)
  values (auth.uid(), 'remove_ghost', v_ghost.user_id, v_ghost.id, v_ghost.title, v_ghost.file_path, v_reason);

  return jsonb_build_object('ghost_id', v_ghost.id, 'file_path', v_ghost.file_path);
end;
$$;

-- Staff: edit any ghost's details (never its file). ghosts_before_update still
-- pins the owner and the download count, and normalises the text fields.
create or replace function public.moderator_update_ghost(
  p_ghost_id          uuid,
  p_title             text,
  p_description       text,
  p_level             text,
  p_time_ms           integer,
  p_is_tas            boolean,
  p_moonshine_version text,
  p_tags              text[],
  p_reason            text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_old     public.ghosts;
  v_new     public.ghosts;
  v_changes jsonb := '{}'::jsonb;
  k         text;
begin
  perform public.staff_require(false);
  if char_length(v_reason) > 500 then
    raise exception 'reason_too_long' using errcode = '22023';
  end if;

  select * into v_old from public.ghosts where id = p_ghost_id for update;
  if not found then
    raise exception 'ghost_not_found' using errcode = 'P0002';
  end if;

  update public.ghosts
     set title = p_title, description = p_description, level = p_level, time_ms = p_time_ms,
         is_tas = coalesce(p_is_tas, false), moonshine_version = p_moonshine_version,
         tags = coalesce(p_tags, '{}')
   where id = p_ghost_id
  returning * into v_new;

  foreach k in array array['title', 'description', 'level', 'time_ms', 'is_tas', 'moonshine_version', 'tags'] loop
    if (to_jsonb(v_old) -> k) is distinct from (to_jsonb(v_new) -> k) then
      v_changes := v_changes || jsonb_build_object(k, jsonb_build_object('from', to_jsonb(v_old) -> k, 'to', to_jsonb(v_new) -> k));
    end if;
  end loop;

  if v_changes <> '{}'::jsonb then
    insert into public.moderation_log (actor_id, action, target_user_id, ghost_id, ghost_title, reason, details)
    values (auth.uid(), 'edit_ghost', v_new.user_id, v_new.id, v_new.title, v_reason, v_changes);
  end if;

  return jsonb_build_object('ghost_id', v_new.id, 'changed', v_changes <> '{}'::jsonb);
end;
$$;

-- ----------------------------------------------------------------------------
-- Account actions
-- ----------------------------------------------------------------------------

-- An active, non-anonymised profile by username, or raises user_not_found.
create or replace function public.staff_find_account(p_username text)
returns public.profiles
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_target public.profiles;
begin
  select * into v_target from public.profiles
   where username_lower = lower(btrim(coalesce(p_username, ''))) and deleted_at is null;
  if not found then
    raise exception 'user_not_found' using errcode = 'P0002';
  end if;
  return v_target;
end;
$$;

-- Staff: suspend an account. Staff accounts cannot be suspended.
create or replace function public.suspend_account(p_username text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_target public.profiles;
begin
  perform public.staff_require(false);
  if char_length(v_reason) > 500 then
    raise exception 'reason_too_long' using errcode = '22023';
  end if;
  v_target := public.staff_find_account(p_username);
  if public.staff_role_of(v_target.id) is not null then
    raise exception 'target_is_staff' using errcode = '42501';
  end if;

  insert into public.account_suspensions (user_id, suspended_by, reason)
  values (v_target.id, auth.uid(), v_reason)
  on conflict (user_id) do nothing;
  if found then
    insert into public.moderation_log (actor_id, action, target_user_id, reason)
    values (auth.uid(), 'suspend_account', v_target.id, v_reason);
  end if;

  return jsonb_build_object('username', v_target.username, 'suspended', true);
end;
$$;

-- Staff: lift a suspension.
create or replace function public.unsuspend_account(p_username text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target public.profiles;
begin
  perform public.staff_require(false);
  v_target := public.staff_find_account(p_username);

  delete from public.account_suspensions where user_id = v_target.id;
  if found then
    insert into public.moderation_log (actor_id, action, target_user_id)
    values (auth.uid(), 'unsuspend_account', v_target.id);
  end if;

  return jsonb_build_object('username', v_target.username, 'suspended', false);
end;
$$;

-- Admin: make an account a moderator, or stop it being one. Admin rows are
-- never changed here.
create or replace function public.set_moderator(p_username text, p_moderator boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target  public.profiles;
  v_current text;
begin
  perform public.staff_require(true);
  v_target := public.staff_find_account(p_username);

  select role into v_current from public.staff where user_id = v_target.id for update;
  if v_current = 'admin' then
    raise exception 'target_is_admin' using errcode = '42501';
  end if;

  if coalesce(p_moderator, false) and v_current is null then
    if exists (select 1 from public.account_suspensions where user_id = v_target.id) then
      raise exception 'target_is_suspended' using errcode = '42501';
    end if;
    insert into public.staff (user_id, role, granted_by) values (v_target.id, 'moderator', auth.uid())
      on conflict (user_id) do nothing;
    insert into public.moderation_log (actor_id, action, target_user_id)
    values (auth.uid(), 'add_moderator', v_target.id);
  elsif not coalesce(p_moderator, false) and v_current = 'moderator' then
    delete from public.staff where user_id = v_target.id;
    insert into public.moderation_log (actor_id, action, target_user_id)
    values (auth.uid(), 'remove_moderator', v_target.id);
  end if;

  return jsonb_build_object('username', v_target.username,
                            'role', case when coalesce(p_moderator, false) then 'moderator' end);
end;
$$;

-- ----------------------------------------------------------------------------
-- Staff-only reads
-- ----------------------------------------------------------------------------

-- One account's moderation state, for its profile page.
create or replace function public.staff_account_status(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform public.staff_require(false);
  select jsonb_build_object(
           'role', public.staff_role_of(p_user_id),
           'suspended', s.user_id is not null,
           'suspended_at', s.suspended_at,
           'reason', s.reason,
           'suspended_by_username', b.username)
    into v_result
    from (select p_user_id as uid) t
    left join public.account_suspensions s on s.user_id = t.uid
    left join public.profiles b on b.id = s.suspended_by;
  return v_result;
end;
$$;

create or replace function public.list_staff()
returns table (
  user_id      uuid,
  username     text,
  display_name text,
  role         text,
  granted_at   timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.staff_require(false);
  return query
    select s.user_id, p.username, p.display_name, s.role, s.granted_at
      from public.staff s
      join public.profiles p on p.id = s.user_id
     where p.deleted_at is null
     order by (s.role = 'admin') desc, p.username_lower;
end;
$$;

create or replace function public.list_suspensions()
returns table (
  user_id               uuid,
  username              text,
  display_name          text,
  suspended_at          timestamptz,
  reason                text,
  suspended_by_username text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.staff_require(false);
  return query
    select s.user_id, p.username, p.display_name, s.suspended_at, s.reason, b.username
      from public.account_suspensions s
      join public.profiles p on p.id = s.user_id
      left join public.profiles b on b.id = s.suspended_by
     order by s.suspended_at desc;
end;
$$;

create or replace function public.moderation_log_recent(p_limit integer default 50)
returns table (
  id                  bigint,
  created_at          timestamptz,
  action              text,
  actor_username      text,
  actor_display_name  text,
  target_username     text,
  target_display_name text,
  ghost_id            uuid,
  ghost_title         text,
  file_path           text,
  reason              text,
  details             jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.staff_require(false);
  return query
    select l.id, l.created_at, l.action, a.username, a.display_name, t.username, t.display_name,
           l.ghost_id, l.ghost_title, l.file_path, l.reason, l.details
      from public.moderation_log l
      left join public.profiles a on a.id = l.actor_id
      left join public.profiles t on t.id = l.target_user_id
     order by l.created_at desc, l.id desc
     limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

-- ----------------------------------------------------------------------------
-- A deleted account loses its role and any suspension
-- ----------------------------------------------------------------------------

create or replace function public.staff_on_profile_deleted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.staff where user_id = new.id;
  delete from public.account_suspensions where user_id = new.id;
  return null;
end;
$$;

drop trigger if exists staff_on_profile_deleted_trg on public.profiles;
create trigger staff_on_profile_deleted_trg
  after update of deleted_at on public.profiles
  for each row
  when (old.deleted_at is null and new.deleted_at is not null)
  execute function public.staff_on_profile_deleted();

-- ----------------------------------------------------------------------------
-- Grants
-- ----------------------------------------------------------------------------

-- Internal helpers; the first two also for ghost-storage.
revoke all on function public.account_is_active(uuid) from public, anon, authenticated;
revoke all on function public.staff_role_of(uuid) from public, anon, authenticated;
revoke all on function public.staff_require(boolean) from public, anon, authenticated;
revoke all on function public.staff_find_account(text) from public, anon, authenticated;
grant execute on function public.account_is_active(uuid) to service_role;
grant execute on function public.staff_role_of(uuid) to service_role;

-- Public.
revoke all on function public.staff_directory() from public;
grant execute on function public.staff_directory() to anon, authenticated;

-- Signed-in website users; each function checks the role itself.
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.my_moderation_status()',
    'public.moderator_remove_ghost(uuid, text)',
    'public.moderator_update_ghost(uuid, text, text, text, integer, boolean, text, text[], text)',
    'public.suspend_account(text, text)',
    'public.unsuspend_account(text)',
    'public.set_moderator(text, boolean)',
    'public.staff_account_status(uuid)',
    'public.list_staff()',
    'public.list_suspensions()',
    'public.moderation_log_recent(integer)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
