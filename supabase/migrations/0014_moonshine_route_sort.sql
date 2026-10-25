-- ============================================================================
-- 0014: Moonshine catalogue - browse by starting route, filter-bound cursors
-- ============================================================================
-- Additive change to moonshine_list_ghosts() (same arguments, same result
-- shape, so catalogue_schema stays 1):
--
--   * p_sort = 'route' orders by the header (segment 0) route tuple
--     (area, episode, parent_area, flags, variant), then newest first within a
--     route, then id. It groups ghosts by where they start. It is not a
--     ranking and does not say two ghosts share an IL objective.
--
--   * Cursors now carry a short hash of the filters they were issued for. A
--     cursor sent back with different filters (or a different sort) is
--     refused as invalid_parameter: cursor, instead of silently returning a
--     page of some other listing. Cursors issued before this migration
--     (three parts, no hash) are still accepted for the original sorts.
--
-- Safe to re-run. Changes no rows.

create or replace function public.moonshine_list_ghosts(
  p_route_key      text    default null,
  p_area           integer default null,
  p_episode        integer default null,
  p_region         text    default null,
  p_playable_on    text    default null,
  p_source_profile integer default null,
  p_assistance     text    default null,
  p_format_version integer default null,
  p_author         text    default null,
  p_sha256         text    default null,
  p_sort           text    default 'newest',
  p_cursor         text    default null,
  p_limit          integer default null
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_cfg        jsonb   := public.moonshine_config();
  v_limit      integer := least(greatest(coalesce(p_limit, (v_cfg ->> 'page_size_default')::integer), 1),
                                (v_cfg ->> 'page_size_max')::integer);
  v_sort       text    := coalesce(p_sort, 'newest');
  v_prefix     text;
  v_key_len    integer;
  v_filters    text;
  v_cursor_key bigint[];
  v_cursor_id  uuid;
  v_parts      text[];
  v_items      jsonb;
  v_last_key   bigint[];
  v_last_id    uuid;
  v_count      integer;
  v_total      bigint;
begin
  v_prefix := case v_sort when 'newest' then 'n' when 'oldest' then 'o' when 'result_qf' then 'r'
                          when 'route' then 'a' end;
  if v_prefix is null then
    raise exception 'invalid_parameter: sort' using errcode = '22023';
  end if;
  v_key_len := case v_sort when 'route' then 6 else 1 end;
  if p_region is not null and p_region not in ('jp', 'us', 'pal') then
    raise exception 'invalid_parameter: region' using errcode = '22023';
  end if;
  if p_playable_on is not null and p_playable_on not in ('jp', 'us', 'pal') then
    raise exception 'invalid_parameter: playable_on' using errcode = '22023';
  end if;
  if p_assistance is not null and p_assistance not in ('tas', 'assisted', 'unknown') then
    raise exception 'invalid_parameter: assistance' using errcode = '22023';
  end if;

  -- Every filter, in a fixed order, null as empty. Limit is deliberately not
  -- part of it: changing the page size mid-browse is fine.
  v_filters := left(md5(concat_ws('|',
    coalesce(p_route_key, ''), coalesce(p_area::text, ''), coalesce(p_episode::text, ''),
    coalesce(p_region, ''), coalesce(p_playable_on, ''), coalesce(p_source_profile::text, ''),
    coalesce(p_assistance, ''), coalesce(p_format_version::text, ''),
    coalesce(lower(p_author), ''), coalesce(lower(p_sha256), ''))), 8);

  if p_cursor is not null then
    v_parts := string_to_array(p_cursor, '~');
    begin
      if v_parts[1] <> v_prefix
         or not (array_length(v_parts, 1) = 4 and v_parts[4] = v_filters
                 or array_length(v_parts, 1) = 3 and v_prefix in ('n', 'o', 'r')) then
        raise exception 'bad cursor';
      end if;
      v_cursor_key := string_to_array(v_parts[2], '.')::bigint[];
      v_cursor_id  := v_parts[3]::uuid;
      if coalesce(array_length(v_cursor_key, 1), 0) <> v_key_len then
        raise exception 'bad cursor';
      end if;
    exception when others then
      raise exception 'invalid_parameter: cursor' using errcode = '22023';
    end;
  end if;

  with filtered as (
    select c.*,
           case v_sort
             when 'newest'    then array[-(extract(epoch from c.created_at) * 1000000)::bigint]
             when 'oldest'    then array[(extract(epoch from c.created_at) * 1000000)::bigint]
             when 'route'     then array[
               c.route_area::bigint,
               c.route_episode::bigint,
               (c.entry -> 'route' ->> 'parent_area')::bigint,
               (c.entry -> 'route' ->> 'flags')::bigint,
               (c.entry -> 'route' ->> 'variant')::bigint,
               -(extract(epoch from c.created_at) * 1000000)::bigint]
             else array[coalesce(c.result_qf, 4294967296)]
           end as sort_key
      from public.moonshine_catalogue c
     where (p_route_key      is null or c.route_key = p_route_key)
       and (p_area           is null or c.route_area = p_area)
       and (p_episode        is null or c.route_episode = p_episode)
       and (p_region         is null or c.region = p_region)
       and (p_playable_on    is null or c.region = p_playable_on or c.portable)
       and (p_source_profile is null or c.source_profile = p_source_profile)
       and (p_assistance     is null or c.assistance = p_assistance)
       and (p_format_version is null or c.format_version = p_format_version)
       and (p_author         is null or c.author_username_lower = lower(p_author))
       and (p_sha256         is null or c.content_sha256 = lower(p_sha256))
  ),
  page as (
    select f.id, f.sort_key, f.entry
      from filtered f
     where v_cursor_id is null or (f.sort_key, f.id) > (v_cursor_key, v_cursor_id)
     order by f.sort_key, f.id
     limit v_limit + 1
  ),
  numbered as (
    select pg.*, row_number() over (order by pg.sort_key, pg.id) as n from page pg
  )
  select
    coalesce(jsonb_agg(entry order by n) filter (where n <= v_limit), '[]'::jsonb),
    count(*)::integer,
    (select nb.sort_key from numbered nb where nb.n = v_limit),
    (select nb.id from numbered nb where nb.n = v_limit),
    (select count(*) from filtered)
    into v_items, v_count, v_last_key, v_last_id, v_total
    from numbered;

  return jsonb_build_object(
    'items', v_items,
    'next_cursor', case when v_count > v_limit
                        then v_prefix || '~' || array_to_string(v_last_key, '.') || '~'
                             || v_last_id::text || '~' || v_filters end,
    'total', v_total,
    'limit', v_limit,
    'sort', v_sort
  );
end;
$$;

grant execute on function public.moonshine_list_ghosts(
  text, integer, integer, text, text, integer, text, integer, text, text, text, text, integer
) to anon, authenticated, service_role;
