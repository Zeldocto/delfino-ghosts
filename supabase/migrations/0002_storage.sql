-- ============================================================================
-- Delfino Ghosts - Storage bucket and policies
-- ----------------------------------------------------------------------------
-- Object layout:  ghosts/<user-id>/<ghost-id>/<name>.smsghost
-- The first path segment is the owner's auth uid, which is what every write
-- policy below checks against auth.uid().
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'ghosts',
  'ghosts',
  true,                                    -- guests must be able to download
  2097152,                                 -- 2 MiB, enforced by Storage itself
  array['application/octet-stream', 'text/plain']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ----------------------------------------------------------------------------
-- Read: anyone, signed in or not.
-- ----------------------------------------------------------------------------
drop policy if exists "ghosts_public_read" on storage.objects;
create policy "ghosts_public_read"
  on storage.objects for select
  using (bucket_id = 'ghosts');

-- ----------------------------------------------------------------------------
-- Write: only into your own folder, only .smsghost, only at the expected depth.
-- ----------------------------------------------------------------------------
drop policy if exists "ghosts_insert_own_folder" on storage.objects;
create policy "ghosts_insert_own_folder"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'ghosts'
    and (storage.foldername(name))[1] = auth.uid()::text
    and array_length(storage.foldername(name), 1) = 2
    and storage.extension(name) = 'smsghost'
  );

drop policy if exists "ghosts_update_own_folder" on storage.objects;
create policy "ghosts_update_own_folder"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'ghosts'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'ghosts'
    and (storage.foldername(name))[1] = auth.uid()::text
    and storage.extension(name) = 'smsghost'
  );

drop policy if exists "ghosts_delete_own_folder" on storage.objects;
create policy "ghosts_delete_own_folder"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'ghosts'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
