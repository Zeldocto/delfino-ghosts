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
\echo 'PASS if: search matches title, author prefix and description'
select title, author_username from public.list_ghosts('bianco',null,null,5,0);
select title, author_username from public.list_ghosts('doge',null,null,5,0);
select title from public.list_ghosts('clean run',null,null,5,0);

\echo 'PASS if: ordered by downloads, highest first'
select title, download_count from public.list_ghosts(null,'downloads',null,3,0);

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
\echo 'PASS if: four policies, bucket public with a 2 MiB limit'
select policyname, cmd from pg_policies where schemaname='storage' order by policyname;
select id, public, file_size_limit from storage.buckets;
