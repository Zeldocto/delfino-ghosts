-- ============================================================================
-- Delfino Ghosts - security checks
-- ----------------------------------------------------------------------------
-- Run against a *disposable* database after applying both migrations. Each
-- block states what should happen; several deliberately provoke errors, and
-- those errors are the passing result.
--
--   psql -d delfino -f supabase/tests/local_stubs.sql
--   psql -d delfino -f supabase/migrations/0001_init.sql
--   psql -d delfino -f supabase/migrations/0002_storage.sql
--   psql -d delfino -f supabase/tests/security_checks.sql
--
-- Re-run this after changing any policy, trigger or grant.
-- ============================================================================

\pset pager off
\set ON_ERROR_STOP 0

\echo ''
\echo '=== accounts ==============================================='

insert into auth.users (id, email, raw_user_meta_data) values
 ('11111111-1111-1111-1111-111111111111','theo@example.com','{"username":"Zeldocto"}'),
 ('22222222-2222-2222-2222-222222222222','doge@example.com','{"username":"Doge"}'),
 ('33333333-3333-3333-3333-333333333333','x@example.com',   '{"username":"zeldocto"}'),
 ('44444444-4444-4444-4444-444444444444','admin@example.com','{"username":"admin"}');

\echo 'PASS if: Zeldocto and Doge kept their names; the duplicate and the'
\echo 'reserved name both got safe derived fallbacks instead of failing signup.'
select username from public.profiles order by created_at;

set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',false) \g /dev/null

\echo ''
\echo '=== a normal upload ========================================'
insert into public.ghosts (user_id,title,description,file_path,original_filename,file_size,tags)
values ('11111111-1111-1111-1111-111111111111','Bianco Hills 3 - 0:37.337','clean run',
        '11111111-1111-1111-1111-111111111111/a/g.smsghost','g.smsghost',18384,
        array['Any Percent','  bianco hills  ','Any Percent']);
\echo 'PASS if: counter is 0 and tags are lowercased, trimmed and deduplicated.'
select title, download_count, tags from public.ghosts;

\echo ''
\echo '=== attacks ================================================'

\echo '-- forged ownership on insert -> rejected'
insert into public.ghosts (user_id,title,file_path,original_filename,file_size)
values ('22222222-2222-2222-2222-222222222222','stolen',
        '22222222-2222-2222-2222-222222222222/b/g.smsghost','g.smsghost',100);

\echo '-- path traversal -> rejected'
insert into public.ghosts (user_id,title,file_path,original_filename,file_size)
values ('11111111-1111-1111-1111-111111111111','traversal',
        '11111111-1111-1111-1111-111111111111/../2222/x.smsghost','x.smsghost',100);

\echo '-- writing my own download_count -> silently pinned'
update public.ghosts set download_count = 9999999 where title like 'Bianco%';
\echo 'PASS if: 0'
select download_count from public.ghosts where title like 'Bianco%';

\echo '-- transferring ownership -> silently pinned'
update public.ghosts set user_id='22222222-2222-2222-2222-222222222222' where title like 'Bianco%';
\echo 'PASS if: 1111...'
select user_id from public.ghosts where title like 'Bianco%';

\echo '-- writing the download log directly -> permission denied'
insert into public.ghost_downloads (ghost_id, user_id)
select id,'11111111-1111-1111-1111-111111111111' from public.ghosts limit 1;

\echo '-- inflating my own profile totals -> pinned'
update public.profiles set total_downloads = 999999 where id='11111111-1111-1111-1111-111111111111';
\echo 'PASS if: 0'
select total_downloads from public.profiles where id='11111111-1111-1111-1111-111111111111';

\echo '-- editing another persons profile -> no rows affected'
update public.profiles set bio='hacked' where id='22222222-2222-2222-2222-222222222222';
\echo 'PASS if: (untouched)'
select coalesce(bio,'(untouched)') from public.profiles where id='22222222-2222-2222-2222-222222222222';

\echo ''
\echo '=== download counting ======================================'

\echo '-- guest calls the RPC -> not_authenticated'
select set_config('request.jwt.claim.sub','',false) \g /dev/null
select public.record_authenticated_download((select id from public.ghosts limit 1));

\echo '-- signed in -> counts once; repeat within the hour -> holds'
select set_config('request.jwt.claim.sub','22222222-2222-2222-2222-222222222222',false) \g /dev/null
\echo 'PASS if: 1 then 1'
select public.record_authenticated_download((select id from public.ghosts limit 1));
select public.record_authenticated_download((select id from public.ghosts limit 1));

\echo '-- a different account does count'
select set_config('request.jwt.claim.sub','33333333-3333-3333-3333-333333333333',false) \g /dev/null
\echo 'PASS if: 2'
select public.record_authenticated_download((select id from public.ghosts limit 1));

\echo '-- the author downloading their own ghost -> does not count'
select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',false) \g /dev/null
\echo 'PASS if: 2 (unchanged)'
select public.record_authenticated_download((select id from public.ghosts limit 1));

\echo '-- unknown ghost -> ghost_not_found'
select public.record_authenticated_download('99999999-9999-9999-9999-999999999999');

\echo ''
\echo '=== the 200-ghost limit ===================================='
select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',false) \g /dev/null
insert into public.ghosts (user_id,title,file_path,original_filename,file_size,is_tas)
select '11111111-1111-1111-1111-111111111111','Ghost '||i,
       '11111111-1111-1111-1111-111111111111/'||gen_random_uuid()||'/g.smsghost','g.smsghost',5000, i%7=0
from generate_series(2,200) i;
\echo 'PASS if: 200'
select count(*) from public.ghosts where user_id='11111111-1111-1111-1111-111111111111';

\echo '-- the 201st, bypassing the frontend entirely -> ghost_limit_reached'
insert into public.ghosts (user_id,title,file_path,original_filename,file_size)
values ('11111111-1111-1111-1111-111111111111','over the line',
        '11111111-1111-1111-1111-111111111111/x/g.smsghost','g.smsghost',5000);

\echo ''
\echo '=== MDP moves on its own ==================================='
select set_config('request.jwt.claim.sub','22222222-2222-2222-2222-222222222222',false) \g /dev/null
insert into public.ghosts (user_id,title,file_path,original_filename,file_size)
values ('22222222-2222-2222-2222-222222222222','Doge run',
        '22222222-2222-2222-2222-222222222222/z/g.smsghost','g.smsghost',5000) \g /dev/null

select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',false) \g /dev/null
select public.record_authenticated_download((select id from public.ghosts where title='Doge run')) \g /dev/null
select set_config('request.jwt.claim.sub','33333333-3333-3333-3333-333333333333',false) \g /dev/null
select public.record_authenticated_download((select id from public.ghosts where title='Doge run')) \g /dev/null
select set_config('request.jwt.claim.sub','44444444-4444-4444-4444-444444444444',false) \g /dev/null
select public.record_authenticated_download((select id from public.ghosts where title='Doge run')) \g /dev/null

\echo 'PASS if: Doge with 3'
select username, total_downloads from public.current_mdp();

\echo ''
\echo '=== listing ================================================'
-- Named arguments, so adding a filter to list_ghosts does not break these.
\echo 'PASS if: search matches title, author prefix and description'
select title, author_username from public.list_ghosts(p_search => 'bianco', p_limit => 5);
select title, author_username from public.list_ghosts(p_search => 'doge', p_limit => 5);
select title from public.list_ghosts(p_search => 'clean run', p_limit => 5);

\echo 'PASS if: ordered by downloads, highest first'
select title, download_count from public.list_ghosts(p_sort => 'downloads', p_limit => 3);

\echo 'PASS if: the level filter narrows to Bianco Hills 3 only'
-- Act as the owner: RLS refuses the update otherwise, which is the point.
select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',false) \g /dev/null
update public.ghosts set level = 'Bianco Hills 3' where title like 'Bianco%';
select title, level from public.list_ghosts(p_level => 'bianco hills 3', p_limit => 10);
select level, ghost_count from public.levels_in_use();

\echo 'PASS if: t | t  (TAS filter returns only TAS rows, and all of them)'
select bool_and(is_tas) as only_tas,
       max(total_count) = (select count(*) from public.ghosts where is_tas) as all_tas
  from public.list_ghosts(p_tas => true, p_limit => 100);

\echo ''
\echo '=== deletion ==============================================='
\echo '-- deleting someone elses ghost -> no rows affected (PASS if: 1)'
select set_config('request.jwt.claim.sub','44444444-4444-4444-4444-444444444444',false) \g /dev/null
delete from public.ghosts where title='Doge run';
select count(*) from public.ghosts where title='Doge run';

\echo '-- the owner deletes it -> totals fall back (PASS if: 0 and 0)'
select set_config('request.jwt.claim.sub','22222222-2222-2222-2222-222222222222',false) \g /dev/null
delete from public.ghosts where title='Doge run';
select total_ghosts, total_downloads from public.profiles where username='Doge';

\echo 'PASS if: MDP is Zeldocto again'
select username, total_downloads from public.current_mdp();

\echo ''
\echo '=== aggregate integrity ===================================='
\echo 'PASS if: zero rows - the triggers kept the counters honest with no repair'
set role postgres;
select p.username, p.total_ghosts, count(g.id) as real_ghosts,
       p.total_downloads, coalesce(sum(g.download_count),0) as real_downloads
from public.profiles p left join public.ghosts g on g.user_id = p.id
group by p.id, p.username, p.total_ghosts, p.total_downloads
having p.total_ghosts <> count(g.id)
    or p.total_downloads <> coalesce(sum(g.download_count),0);

\echo ''
\echo '=== storage ================================================'
\echo 'PASS if: four policies, bucket public with a 10 MiB limit'
select policyname, cmd from pg_policies where schemaname='storage' order by policyname;
select id, public, file_size_limit from storage.buckets;

\echo ''
\echo '=== account deletion (needs 0008) =========================='
set role postgres;
insert into auth.users (id, email, raw_user_meta_data) values
 ('55555555-5555-5555-5555-555555555555','leaver@example.com','{"username":"Leaver"}');
update public.profiles set display_name='Leaver L', bio='bye', avatar_url='https://i.imgur.com/x.png'
 where id='55555555-5555-5555-5555-555555555555';
-- The local stub schema has no grants; give the roles what Supabase gives them.
grant usage on schema storage to authenticated;
grant select, insert, update, delete on storage.objects to authenticated;
-- Sign-in history for Leaver, plus one for Doge that must survive.
insert into auth.audit_log_entries (payload, ip_address) values
 ('{"actor_id":"55555555-5555-5555-5555-555555555555","action":"login"}','203.0.113.5'),
 ('{"actor_id":"55555555-5555-5555-5555-555555555555","action":"token_refreshed"}','203.0.113.5'),
 ('{"actor_id":"00000000-0000-0000-0000-000000000000","action":"user_modified","traits":{"user_id":"55555555-5555-5555-5555-555555555555"}}','198.51.100.1'),
 ('{"actor_id":"22222222-2222-2222-2222-222222222222","action":"login"}','192.0.2.9');

set role authenticated;
select set_config('request.jwt.claim.sub','55555555-5555-5555-5555-555555555555',false) \g /dev/null
insert into public.ghosts (user_id,title,file_path,original_filename,file_size)
values ('55555555-5555-5555-5555-555555555555','Leaver run',
        '55555555-5555-5555-5555-555555555555/l/g.smsghost','g.smsghost',100);
-- Leaver downloads someone else's ghost, and Doge downloads Leaver's.
select public.record_authenticated_download((select id from public.ghosts where title like 'Bianco%')) \g /dev/null
select set_config('request.jwt.claim.sub','22222222-2222-2222-2222-222222222222',false) \g /dev/null
select public.record_authenticated_download((select id from public.ghosts where title='Leaver run')) \g /dev/null

\echo '-- a guest cannot call delete_own_account -> permission denied'
set role anon;
select public.delete_own_account();

\echo '-- Leaver deletes their account'
set role authenticated;
select set_config('request.jwt.claim.sub','55555555-5555-5555-5555-555555555555',false) \g /dev/null
select public.delete_own_account();

set role postgres;
\echo 'PASS if: 0 (login is gone)'
select count(*) from auth.users where id='55555555-5555-5555-5555-555555555555';
\echo 'PASS if: anonymous-1 | Anonymous 1 | null avatar | null bio | deleted | 1 ghost | 1 download'
select username, display_name, avatar_url is null as no_avatar, bio is null as no_bio,
       deleted_at is not null as deleted, total_ghosts, total_downloads
  from public.profiles where id='55555555-5555-5555-5555-555555555555';
\echo 'PASS if: 0 (their sign-in log is purged, needs 0009) and 1 (Doge keeps theirs)'
select count(*) from auth.audit_log_entries
 where payload->>'actor_id'='55555555-5555-5555-5555-555555555555'
    or payload->'traits'->>'user_id'='55555555-5555-5555-5555-555555555555';
select count(*) from auth.audit_log_entries where payload->>'actor_id'='22222222-2222-2222-2222-222222222222';
\echo 'PASS if: the ghost survives with its count of 1'
select title, download_count from public.ghosts where title='Leaver run';
\echo 'PASS if: 0 (their own download log is cleared) and 1 (downloads OF their ghost stay)'
select count(*) from public.ghost_downloads where user_id='55555555-5555-5555-5555-555555555555';
select count(*) from public.ghost_downloads d join public.ghosts g on g.id=d.ghost_id where g.title='Leaver run';

\echo '-- the leftover token tries to act -> nothing changes'
set role authenticated;
select set_config('request.jwt.claim.sub','55555555-5555-5555-5555-555555555555',false) \g /dev/null
update public.ghosts set title='vandalised' where title='Leaver run';
delete from public.ghosts where title='Leaver run';
update public.profiles set bio='back' where id='55555555-5555-5555-5555-555555555555';
\echo 'PASS if: Leaver run | null bio'
select title from public.ghosts where title in ('Leaver run','vandalised');
select bio from public.profiles where id='55555555-5555-5555-5555-555555555555';
\echo '-- leftover token uploads -> rejected by RLS'
insert into public.ghosts (user_id,title,file_path,original_filename,file_size)
values ('55555555-5555-5555-5555-555555555555','ghost from beyond',
        '55555555-5555-5555-5555-555555555555/m/g.smsghost','g.smsghost',100);
\echo '-- leftover token counts a download -> not_authenticated'
select public.record_authenticated_download((select id from public.ghosts where title like 'Bianco%'));
\echo '-- leftover token writes to Storage -> rejected by RLS'
insert into storage.objects (bucket_id, name) values ('ghosts','55555555-5555-5555-5555-555555555555/n/g.smsghost');
\echo '-- control: an active account can still write to its own folder (PASS if: INSERT 0 1)'
select set_config('request.jwt.claim.sub','22222222-2222-2222-2222-222222222222',false) \g /dev/null
insert into storage.objects (bucket_id, name) values ('ghosts','22222222-2222-2222-2222-222222222222/n/g.smsghost');

\echo '-- nobody can take an anonymous name'
select set_config('request.jwt.claim.sub','22222222-2222-2222-2222-222222222222',false) \g /dev/null
\echo 'PASS if: check violation'
update public.profiles set username='Anonymous-2' where id='22222222-2222-2222-2222-222222222222';
set role postgres;
insert into auth.users (id, email, raw_user_meta_data) values
 ('66666666-6666-6666-6666-666666666666','sneaky@example.com','{"username":"anonymous-2"}');
\echo 'PASS if: signup still succeeded, with a derived name (not anonymous-2)'
select username from public.profiles where id='66666666-6666-6666-6666-666666666666';

\echo '-- deleting by hand (dashboard) anonymises too, with the next number'
delete from auth.users where id='66666666-6666-6666-6666-666666666666';
\echo 'PASS if: anonymous-2 | Anonymous 2'
select username, display_name from public.profiles where id='66666666-6666-6666-6666-666666666666';
