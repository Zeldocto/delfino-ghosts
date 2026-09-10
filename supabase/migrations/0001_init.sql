-- ============================================================================
-- Delfino Ghosts - core schema
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL editor (or via `supabase db push`) before
-- starting the frontend. Every rule that actually protects data lives here,
-- not in React.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

-- ============================================================================
-- profiles
-- ============================================================================
-- One row per auth.users row, created automatically by a trigger on signup.
-- total_ghosts / total_downloads are denormalised aggregates maintained by
-- triggers so that MDP and the leaderboard never need a full-table SUM.

create table if not exists public.profiles (
  id              uuid primary key references auth.users (id) on delete cascade,
  username        text not null,
  username_lower  text generated always as (lower(username)) stored,
  display_name    text,
  avatar_url      text,
  bio             text,
  total_ghosts    integer not null default 0,
  total_downloads bigint  not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- URL-safe, short, unambiguous. Rejects whitespace, slashes, dots and any
  -- character that could be used for path or markup tricks.
  constraint profiles_username_format
    check (username ~ '^[A-Za-z0-9_-]{3,24}$'),
  -- Reserved words that would collide with application routes.
  constraint profiles_username_reserved
    check (lower(username) <> all (array[
      'admin','root','system','support','moderator','mod','api','auth',
      'profile','ghost','ghosts','browse','upload','community','about',
      'login','register','settings','delfino','moonshine','new','edit'
    ])),
  constraint profiles_display_name_len
    check (display_name is null or char_length(display_name) between 1 and 40),
  constraint profiles_bio_len
    check (bio is null or char_length(bio) <= 500),
  -- Avatars are remote URLs; only https, no javascript: or data: payloads.
  constraint profiles_avatar_url_valid
    check (avatar_url is null or avatar_url ~ '^https://[^\s<>"]{1,400}$'),
  constraint profiles_totals_nonnegative
    check (total_ghosts >= 0 and total_downloads >= 0)
);

-- Case-insensitive uniqueness: "Theo", "theo" and "THEO" cannot coexist.
create unique index if not exists profiles_username_lower_key
  on public.profiles (username_lower);

-- Leaderboard / MDP lookups are a single index scan.
create index if not exists profiles_total_downloads_idx
  on public.profiles (total_downloads desc, username_lower asc);

create index if not exists profiles_created_at_idx
  on public.profiles (created_at desc);

-- ============================================================================
-- ghosts
-- ============================================================================

create table if not exists public.ghosts (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles (id) on delete cascade,
  title             text not null,
  description       text,
  file_path         text not null unique,
  original_filename text not null,
  file_size         integer not null,
  is_tas            boolean not null default false,
  moonshine_version text,
  tags              text[] not null default '{}',
  download_count    integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint ghosts_title_len
    check (char_length(btrim(title)) between 1 and 100),
  constraint ghosts_description_len
    check (description is null or char_length(description) <= 2000),
  constraint ghosts_moonshine_version_len
    check (moonshine_version is null or moonshine_version ~ '^[A-Za-z0-9 ._-]{1,32}$'),
  -- 2 MiB ceiling. A real Moonshine ghost is tens of kilobytes; this leaves
  -- generous headroom for longer runs while making bulk-storage abuse pointless.
  constraint ghosts_file_size_range
    check (file_size > 0 and file_size <= 2097152),
  constraint ghosts_original_filename_len
    check (char_length(original_filename) between 1 and 200),
  -- Storage key must live under the owner's folder, so a row can never point at
  -- someone else's object, and can never contain a traversal segment.
  constraint ghosts_file_path_scoped
    check (file_path like (user_id::text || '/%')),
  constraint ghosts_file_path_no_traversal
    check (position('..' in file_path) = 0),
  constraint ghosts_tag_count
    check (coalesce(array_length(tags, 1), 0) <= 8),
  constraint ghosts_download_count_nonnegative
    check (download_count >= 0)
);

-- Full-text search over the metadata a user actually types.
--
-- The document is built by a wrapper function because array_to_string() is
-- only STABLE, and a generated column requires a strictly immutable
-- expression. Flattening the tags inside an IMMUTABLE function is safe here:
-- the inputs are plain text, so the result depends on nothing but its
-- arguments.
create or replace function public.ghost_search_document(
  p_title       text,
  p_description text,
  p_tags        text[]
)
returns tsvector
language sql
immutable
set search_path = ''
as $$
  select to_tsvector('simple',
    coalesce(p_title, '') || ' ' ||
    coalesce(p_description, '') || ' ' ||
    coalesce(array_to_string(coalesce(p_tags, '{}'::text[]), ' '), '')
  );
$$;

alter table public.ghosts
  add column if not exists search_vector tsvector
  generated always as (public.ghost_search_document(title, description, tags)) stored;

create index if not exists ghosts_search_idx      on public.ghosts using gin (search_vector);
create index if not exists ghosts_created_at_idx  on public.ghosts (created_at desc, id desc);
create index if not exists ghosts_updated_at_idx  on public.ghosts (updated_at desc, id desc);
create index if not exists ghosts_downloads_idx   on public.ghosts (download_count desc, id desc);
create index if not exists ghosts_user_id_idx     on public.ghosts (user_id, created_at desc);
create index if not exists ghosts_title_idx       on public.ghosts (lower(title));

-- ============================================================================
-- ghost_downloads
-- ============================================================================
-- Append-only log of counted (authenticated) downloads. Used for the per-user
-- cooldown and as an audit trail if the counters ever need rebuilding.

create table if not exists public.ghost_downloads (
  id         bigint generated always as identity primary key,
  ghost_id   uuid not null references public.ghosts (id)   on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists ghost_downloads_dedupe_idx
  on public.ghost_downloads (user_id, ghost_id, created_at desc);
create index if not exists ghost_downloads_ghost_idx
  on public.ghost_downloads (ghost_id, created_at desc);

-- ============================================================================
-- helpers
-- ============================================================================

create or replace function public.normalize_tags(p_tags text[])
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    (
      select array_agg(distinct t order by t)
      from (
        select btrim(lower(unnest)) as t
        from unnest(coalesce(p_tags, '{}'::text[]))
      ) s
      where t <> '' and t ~ '^[a-z0-9][a-z0-9 _-]{0,23}$'
    ),
    '{}'::text[]
  );
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- Profile creation on signup
-- ----------------------------------------------------------------------------
-- The client passes `username` in the signUp metadata. If it is missing or
-- unusable we derive a safe fallback so signup never dead-ends.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_username text;
  v_base     text;
  v_try      integer := 0;
  v_reserved text[] := array[
    'admin','root','system','support','moderator','mod','api','auth',
    'profile','ghost','ghosts','browse','upload','community','about',
    'login','register','settings','delfino','moonshine','new','edit'
  ];
begin
  v_username := btrim(coalesce(new.raw_user_meta_data ->> 'username', ''));

  -- Anything unusable — malformed, absent, or reserved — becomes a derived
  -- name rather than a failed signup. Signup must never dead-end here: the
  -- account is already being created, and the client cannot recover from an
  -- exception raised inside this trigger.
  if v_username !~ '^[A-Za-z0-9_-]{3,24}$' or lower(v_username) = any (v_reserved) then
    v_base := regexp_replace(split_part(coalesce(new.email, 'runner'), '@', 1), '[^A-Za-z0-9_-]', '', 'g');
    if char_length(v_base) < 3 or lower(v_base) = any (v_reserved) then
      v_base := 'runner';
    end if;
    v_username := left(v_base, 18) || '_' || substr(replace(new.id::text, '-', ''), 1, 5);
  end if;

  loop
    begin
      insert into public.profiles (id, username) values (new.id, v_username);
      return new;
    exception
      -- Both cases resolve the same way: pick another name and retry, so a
      -- collision or an unexpected constraint never blocks account creation.
      when unique_violation or check_violation then
        v_try := v_try + 1;
        if v_try > 5 then
          raise exception 'username_taken' using errcode = '23505';
        end if;
        v_username := 'runner_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);
    end;
  end loop;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- Ghost insert guard: ownership, counters, the 200 limit
-- ----------------------------------------------------------------------------

create or replace function public.ghosts_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  -- Ownership is taken from the session, never from the payload.
  if auth.uid() is not null then
    new.user_id := auth.uid();
  end if;

  new.download_count := 0;
  new.title          := btrim(new.title);
  new.description    := nullif(btrim(coalesce(new.description, '')), '');
  new.tags           := public.normalize_tags(new.tags);
  new.created_at     := now();
  new.updated_at     := now();

  -- Serialise concurrent inserts for this user so two parallel requests cannot
  -- both observe 199 and both succeed.
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

drop trigger if exists ghosts_before_insert_trg on public.ghosts;
create trigger ghosts_before_insert_trg
  before insert on public.ghosts
  for each row execute function public.ghosts_before_insert();

-- ----------------------------------------------------------------------------
-- Ghost update guard: no ownership transfer, no client-set counters
-- ----------------------------------------------------------------------------
-- RLS WITH CHECK cannot see OLD, so immutability is enforced here. The counter
-- is only writable while record_authenticated_download() has flipped the
-- transaction-local flag, which no PostgREST client can set.

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
  new.tags        := public.normalize_tags(new.tags);

  return new;
end;
$$;

drop trigger if exists ghosts_before_update_trg on public.ghosts;
create trigger ghosts_before_update_trg
  before update on public.ghosts
  for each row execute function public.ghosts_before_update();

-- ----------------------------------------------------------------------------
-- Aggregate maintenance
-- ----------------------------------------------------------------------------

create or replace function public.ghosts_after_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform set_config('delfino.counter_ctx', 'on', true);

  if tg_op = 'INSERT' then
    update public.profiles
       set total_ghosts = total_ghosts + 1
     where id = new.user_id;
  elsif tg_op = 'DELETE' then
    update public.profiles
       set total_ghosts    = greatest(total_ghosts - 1, 0),
           total_downloads = greatest(total_downloads - old.download_count, 0)
     where id = old.user_id;
  end if;

  perform set_config('delfino.counter_ctx', 'off', true);
  return null;
end;
$$;

drop trigger if exists ghosts_after_change_trg on public.ghosts;
create trigger ghosts_after_change_trg
  after insert or delete on public.ghosts
  for each row execute function public.ghosts_after_change();

create or replace function public.profiles_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.created_at := old.created_at;
  new.id := old.id;
  -- Aggregates are trigger-maintained. They are writable only inside the
  -- trusted context flag, which only our SECURITY DEFINER routines set, so a
  -- client UPDATE on profiles can never move them.
  if current_setting('delfino.counter_ctx', true) is distinct from 'on' then
    new.total_ghosts    := old.total_ghosts;
    new.total_downloads := old.total_downloads;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_before_update_trg on public.profiles;
create trigger profiles_before_update_trg
  before update on public.profiles
  for each row execute function public.profiles_set_updated_at();

-- ============================================================================
-- Row Level Security
-- ============================================================================

alter table public.profiles        enable row level security;
alter table public.ghosts          enable row level security;
alter table public.ghost_downloads enable row level security;

-- profiles ------------------------------------------------------------------
drop policy if exists profiles_select_public on public.profiles;
create policy profiles_select_public
  on public.profiles for select
  using (true);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
  on public.profiles for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- No INSERT or DELETE policy: rows are created by the signup trigger and
-- removed by the auth.users cascade only.

-- ghosts --------------------------------------------------------------------
drop policy if exists ghosts_select_public on public.ghosts;
create policy ghosts_select_public
  on public.ghosts for select
  using (true);

drop policy if exists ghosts_insert_own on public.ghosts;
create policy ghosts_insert_own
  on public.ghosts for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists ghosts_update_own on public.ghosts;
create policy ghosts_update_own
  on public.ghosts for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists ghosts_delete_own on public.ghosts;
create policy ghosts_delete_own
  on public.ghosts for delete
  to authenticated
  using (auth.uid() = user_id);

-- ghost_downloads -----------------------------------------------------------
-- Clients get no direct access at all; only the SECURITY DEFINER RPC writes
-- here, and only the owner of a row may read it back.
drop policy if exists ghost_downloads_select_own on public.ghost_downloads;
create policy ghost_downloads_select_own
  on public.ghost_downloads for select
  to authenticated
  using (auth.uid() = user_id);

revoke insert, update, delete on public.ghost_downloads from anon, authenticated;

-- ============================================================================
-- RPCs
-- ============================================================================

-- ----------------------------------------------------------------------------
-- username_available()
-- ----------------------------------------------------------------------------
create or replace function public.username_available(p_username text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_username !~ '^[A-Za-z0-9_-]{3,24}$' then
    return false;
  end if;
  return not exists (
    select 1 from public.profiles where username_lower = lower(p_username)
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- record_authenticated_download()
-- ----------------------------------------------------------------------------
-- The only path that may move a download counter. Guests never reach it
-- (execute is granted to `authenticated` only), the increment is a single
-- atomic UPDATE, and a per-user-per-ghost cooldown stops click-spamming.
-- Returns the ghost's counter as it now stands.

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

  -- Your own ghosts never count toward your own total, or an author could
  -- inflate their own ranking one click at a time.
  if v_owner = v_uid then
    return v_count;
  end if;

  -- Cooldown: the same account re-downloading the same ghost within an hour
  -- still gets the file (the frontend downloads regardless), it just does not
  -- move the number again.
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
-- list_ghosts()
-- ----------------------------------------------------------------------------
-- One query returns the page and the total row count, so Browse never pulls
-- the archive into the browser. SECURITY INVOKER, so RLS still applies.

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
    else 'g.created_at desc, g.id desc'
  end;

  return query execute format($q$
    select g.id, g.user_id, g.title, g.description, g.file_path,
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
       )
     order by %s
     limit $3 offset $4
  $q$, v_order)
  using p_user, v_search, v_limit, v_offset;
end;
$$;

-- ----------------------------------------------------------------------------
-- top_players() / community_stats()
-- ----------------------------------------------------------------------------
-- Both read the maintained aggregates on profiles, so the leaderboard and the
-- MDP lookup are index scans rather than a GROUP BY over every ghost.

create or replace function public.top_players(p_limit integer default 25)
returns table (
  id              uuid,
  username        text,
  display_name    text,
  avatar_url      text,
  total_ghosts    integer,
  total_downloads bigint
)
language sql
stable
set search_path = ''
as $$
  select p.id, p.username, p.display_name, p.avatar_url,
         p.total_ghosts, p.total_downloads
    from public.profiles p
   where p.total_ghosts > 0
   order by p.total_downloads desc, p.username_lower asc
   limit least(greatest(coalesce(p_limit, 25), 1), 100);
$$;

create or replace function public.community_stats()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'total_users',     (select count(*) from public.profiles),
    'total_ghosts',    (select count(*) from public.ghosts),
    'total_downloads', (select coalesce(sum(download_count), 0) from public.ghosts),
    'mdp', (
      select jsonb_build_object('id', p.id, 'username', p.username,
                                'total_downloads', p.total_downloads)
        from public.profiles p
       where p.total_downloads > 0
       order by p.total_downloads desc, p.username_lower asc
       limit 1
    ),
    'top_ghost', (
      select jsonb_build_object('id', g.id, 'title', g.title,
                                'download_count', g.download_count,
                                'author', p.username)
        from public.ghosts g join public.profiles p on p.id = g.user_id
       order by g.download_count desc, g.created_at desc
       limit 1
    ),
    'latest_ghost', (
      select jsonb_build_object('id', g.id, 'title', g.title,
                                'created_at', g.created_at,
                                'author', p.username)
        from public.ghosts g join public.profiles p on p.id = g.user_id
       order by g.created_at desc
       limit 1
    )
  );
$$;

-- ----------------------------------------------------------------------------
-- current_mdp()
-- ----------------------------------------------------------------------------
-- Cheap single-row lookup used by the <AuthorName /> component. Always derived
-- from live data - no user is ever pinned as MDP.

create or replace function public.current_mdp()
returns table (id uuid, username text, total_downloads bigint)
language sql
stable
set search_path = ''
as $$
  select p.id, p.username, p.total_downloads
    from public.profiles p
   where p.total_downloads > 0
   order by p.total_downloads desc, p.username_lower asc
   limit 1;
$$;

-- ----------------------------------------------------------------------------
-- recompute_profile_stats()
-- ----------------------------------------------------------------------------
-- Maintenance only. Rebuilds the denormalised aggregates from the ghosts table
-- if they ever drift. Not exposed to clients.

create or replace function public.recompute_profile_stats()
returns void
language sql
security definer
set search_path = ''
as $$
  update public.profiles p
     set total_ghosts    = coalesce(s.n, 0),
         total_downloads = coalesce(s.d, 0)
    from (
      select pr.id,
             count(g.id) as n,
             coalesce(sum(g.download_count), 0) as d
        from public.profiles pr
        left join public.ghosts g on g.user_id = pr.id
       group by pr.id
    ) s
   where s.id = p.id;
$$;

revoke all on function public.recompute_profile_stats() from public, anon, authenticated;

-- ============================================================================
-- Grants
-- ============================================================================

grant execute on function public.username_available(text)                  to anon, authenticated;
grant execute on function public.list_ghosts(text, text, uuid, int, int)   to anon, authenticated;
grant execute on function public.top_players(int)                          to anon, authenticated;
grant execute on function public.community_stats()                         to anon, authenticated;
grant execute on function public.current_mdp()                             to anon, authenticated;
