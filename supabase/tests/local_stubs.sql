-- ============================================================================
-- Local stand-ins for the Supabase-managed schemas
-- ----------------------------------------------------------------------------
-- Only for testing the migrations against a plain PostgreSQL instance. Never
-- run this against a real Supabase project - it would shadow the genuine auth
-- and storage objects.
--
--   createdb delfino
--   psql -d delfino -f supabase/tests/local_stubs.sql
--   psql -d delfino -f supabase/migrations/0001_init.sql
--   psql -d delfino -f supabase/migrations/0002_storage.sql
--   psql -d delfino -f supabase/tests/security_checks.sql
--
-- The roles may already exist on the cluster; those errors are harmless.
-- ============================================================================

create schema if not exists extensions;
create schema if not exists auth;
create schema if not exists storage;
create role anon;
create role authenticated;
create role service_role;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb
);

-- Supabase reads the uid from the request JWT claims GUC.
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create table storage.buckets (
  id text primary key, name text, public boolean,
  file_size_limit bigint, allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text, name text, owner uuid
);
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[]
  language sql immutable as $$ select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1]; $$;
create or replace function storage.extension(name text) returns text
  language sql immutable as $$ select lower(split_part(name,'.',array_length(string_to_array(name,'.'),1))); $$;

grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
