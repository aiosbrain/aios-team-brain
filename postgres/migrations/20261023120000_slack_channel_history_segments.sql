-- AIO-1170 AM-F2 + AC-02 deep history: bounded Slack cursor histories and timestamp segments
-- for public.slack_sync_channels (accepted consolidated contract
-- `aio1170-am-f2-deep-history-consolidated-accepted-spec-migration-v1-20261023.md`, §9 and §9.3).
--
-- In order, this block: requires UTF8; takes ACCESS EXCLUSIVE; validates any present new columns
-- and the existing validator's metadata; (re)creates the history validator; prevalidates every
-- row; introduces the absent columns; drops any prior copy of the four named CHECKs; restarts each
-- affected active lane exactly once; validates every row again; and installs the two named history
-- and two named progress CHECKs. Pending isolated MR-01–MR-05 proof; not publication evidence.
--
-- The executable body is ONE self-contained atomic DO statement, byte-identical to the block
-- inside the dedicated slack-channel-history-segments-upgrade marker pair in postgres/schema.sql
-- (the pair below encloses it here). Nothing else in this file executes.
-- Ownership: PR714 owns this file and the bounded Slack history/segment block; PR743 retains
-- Drive schema/migrations and the loader/pool. Nothing here is wired or activated.
--
-- slack-channel-history-segments-upgrade:begin
do $slack_channel_history_segments$
declare
  newest_history_present boolean;
  historical_history_present boolean;
  newest_segment_columns integer;
  historical_segment_columns integer;
  newest_affected boolean;
  historical_affected boolean;
begin
  if pg_catalog.current_setting('server_encoding') <> 'UTF8' then
    raise exception using errcode = 'P0001', message = 'AM_F2_UPGRADE_INVALID_STATE';
  end if;

  -- The lock comes BEFORE any presence observation, so two concurrent upgrades serialize here and
  -- cannot both observe absence.
  lock table public.slack_sync_channels in access exclusive mode;

  -- ── Column observation: present columns must have the exact accepted metadata. ──
  if exists (
    select 1 from pg_catalog.pg_attribute a
      left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where a.attrelid = 'public.slack_sync_channels'::pg_catalog.regclass and a.attnum > 0 and not a.attisdropped
       and a.attname in ('newest_cursor_history', 'historical_cursor_history')
       and not coalesce(a.atttypid = 'pg_catalog.jsonb'::pg_catalog.regtype and a.attnotnull
                and a.attgenerated = '' and a.attidentity = ''
                and pg_catalog.pg_get_expr(d.adbin, d.adrelid) = '''[]''::jsonb', false)
  ) then
    raise exception using errcode = 'P0001', message = 'AM_F2_UPGRADE_INVALID_STATE';
  end if;
  if exists (
    select 1 from pg_catalog.pg_attribute a
      left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where a.attrelid = 'public.slack_sync_channels'::pg_catalog.regclass and a.attnum > 0 and not a.attisdropped
       and a.attname in ('newest_request_lower_ts', 'newest_segment_lower_ts', 'newest_segment_upper_ts',
                         'historical_segment_lower_ts', 'historical_segment_upper_ts',
                         'historical_completed_segments_oldest_ts')
       and not coalesce(a.atttypid = 'pg_catalog.text'::pg_catalog.regtype and not a.attnotnull
                and a.attgenerated = '' and a.attidentity = '' and d.adbin is null, false)
  ) then
    raise exception using errcode = 'P0001', message = 'AC02_PROGRESS_UPGRADE_INVALID_STATE';
  end if;
  -- The same facts through information_schema: built-in types (never a domain) and exact defaults.
  if exists (
    select 1 from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = 'slack_sync_channels'
       and c.column_name in ('newest_cursor_history', 'historical_cursor_history')
       and not coalesce(c.data_type = 'jsonb' and c.udt_schema = 'pg_catalog' and c.udt_name = 'jsonb'
                and c.domain_name is null and c.is_nullable = 'NO' and c.column_default = '''[]''::jsonb'
                and c.is_generated = 'NEVER' and c.is_identity = 'NO', false)
  ) then
    raise exception using errcode = 'P0001', message = 'AM_F2_UPGRADE_INVALID_STATE';
  end if;
  if exists (
    select 1 from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = 'slack_sync_channels'
       and c.column_name in ('newest_request_lower_ts', 'newest_segment_lower_ts', 'newest_segment_upper_ts',
                             'historical_segment_lower_ts', 'historical_segment_upper_ts',
                             'historical_completed_segments_oldest_ts')
       and not coalesce(c.data_type = 'text' and c.udt_schema = 'pg_catalog' and c.udt_name = 'text'
                and c.domain_name is null and c.is_nullable = 'YES' and c.column_default is null
                and c.is_generated = 'NEVER' and c.is_identity = 'NO', false)
  ) then
    raise exception using errcode = 'P0001', message = 'AC02_PROGRESS_UPGRADE_INVALID_STATE';
  end if;

  select pg_catalog.count(*) = 1 into newest_history_present from pg_catalog.pg_attribute
   where attrelid = 'public.slack_sync_channels'::pg_catalog.regclass and attnum > 0 and not attisdropped
     and attname = 'newest_cursor_history';
  select pg_catalog.count(*) = 1 into historical_history_present from pg_catalog.pg_attribute
   where attrelid = 'public.slack_sync_channels'::pg_catalog.regclass and attnum > 0 and not attisdropped
     and attname = 'historical_cursor_history';
  select pg_catalog.count(*) into newest_segment_columns from pg_catalog.pg_attribute
   where attrelid = 'public.slack_sync_channels'::pg_catalog.regclass and attnum > 0 and not attisdropped
     and attname in ('newest_request_lower_ts', 'newest_segment_lower_ts', 'newest_segment_upper_ts');
  select pg_catalog.count(*) into historical_segment_columns from pg_catalog.pg_attribute
   where attrelid = 'public.slack_sync_channels'::pg_catalog.regclass and attnum > 0 and not attisdropped
     and attname in ('historical_segment_lower_ts', 'historical_segment_upper_ts',
                     'historical_completed_segments_oldest_ts');
  -- A lane's segment columns are ONE introduction unit: all absent, or all present.
  if newest_segment_columns not in (0, 3) or historical_segment_columns not in (0, 3) then
    raise exception using errcode = 'P0001', message = 'AC02_PROGRESS_UPGRADE_INVALID_STATE';
  end if;

  -- ── Helper metadata: an existing validator must be exactly the accepted one before replacement. ──
  if exists (
    select 1 from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'slack_channel_cursor_history_valid'
       and not coalesce(p.prokind = 'f' and p.pronargs = 1 and p.pronargdefaults = 0
                and p.prosupport::pg_catalog.oid = 0::pg_catalog.oid
                and p.proargtypes[0] = 'pg_catalog.jsonb'::pg_catalog.regtype
                and p.proargnames = array['history']::text[]
                and p.prorettype = 'pg_catalog.bool'::pg_catalog.regtype
                and p.prolang = (select l.oid from pg_catalog.pg_language l where l.lanname = 'sql')
                and p.provolatile = 'i' and p.proisstrict and p.proparallel = 's'
                and not p.prosecdef and not p.proretset and not p.proleakproof
                and p.proconfig = array['search_path=pg_catalog']::text[], false)
  ) then
    raise exception using errcode = 'P0001', message = 'AM_F2_UPGRADE_INVALID_STATE';
  end if;

  create or replace function public.slack_channel_cursor_history_valid(history jsonb) returns boolean
  language sql immutable strict parallel safe security invoker
  set search_path = pg_catalog
  as $slack_channel_cursor_history_valid$
    select case
      when pg_catalog.jsonb_typeof(history) is distinct from 'array' then false
      when pg_catalog.jsonb_array_length(history) > 1000 then false
      when pg_catalog.octet_length(history::pg_catalog.text) > 1048576 then false
      else coalesce((
        select pg_catalog.bool_and(
                 pg_catalog.jsonb_typeof(x.e) = 'string'
                 and (x.e #>> '{}') collate pg_catalog."C" ~ ('[^' || pg_catalog.chr(9) || '-' || pg_catalog.chr(13)
                       || pg_catalog.chr(32) || pg_catalog.chr(160) || pg_catalog.chr(5760)
                       || pg_catalog.chr(8192) || '-' || pg_catalog.chr(8202) || pg_catalog.chr(8232)
                       || pg_catalog.chr(8233) || pg_catalog.chr(8239) || pg_catalog.chr(8287)
                       || pg_catalog.chr(12288) || pg_catalog.chr(65279) || ']')
                 and (x.e #>> '{}') collate pg_catalog."C" !~ ('[' || pg_catalog.chr(1) || '-' || pg_catalog.chr(31)
                       || pg_catalog.chr(127) || ']')
                 and pg_catalog.char_length(x.e #>> '{}')
                     + pg_catalog.char_length(pg_catalog.regexp_replace((x.e #>> '{}') collate pg_catalog."C",
                         '[^' || pg_catalog.chr(65536) || '-' || pg_catalog.chr(1114111) || ']', '', 'g')) <= 1024
               ) and pg_catalog.count(distinct x.e) = pg_catalog.count(*)
          from pg_catalog.jsonb_array_elements(history) as x(e)
      ), true)
    end
  $slack_channel_cursor_history_valid$;

  -- ── Prevalidation, BEFORE any restart could hide malformed legacy state. ──
  if exists (
    select 1 from public.slack_sync_channels s
     where (s.newest_anchor_ts is null and s.newest_cursor is not null)
        or (s.historical_anchor_ts is null and s.historical_cursor is not null)
  ) then
    raise exception using errcode = 'P0001', message = 'AM_F2_UPGRADE_INVALID_STATE';
  end if;
  if newest_history_present then
    if exists (
      select 1 from public.slack_sync_channels s
       where not coalesce(case when public.slack_channel_cursor_history_valid(s.newest_cursor_history) then
               case when s.newest_cursor is null then s.newest_cursor_history = '[]'::pg_catalog.jsonb
                    else s.newest_anchor_ts is not null
                         and pg_catalog.jsonb_array_length(s.newest_cursor_history) > 0
                         and (s.newest_cursor_history -> -1) = pg_catalog.to_jsonb(s.newest_cursor) end
             else false end, false)
    ) then
      raise exception using errcode = 'P0001', message = 'AM_F2_UPGRADE_INVALID_STATE';
    end if;
  end if;
  if historical_history_present then
    if exists (
      select 1 from public.slack_sync_channels s
       where not coalesce(case when public.slack_channel_cursor_history_valid(s.historical_cursor_history) then
               case when s.historical_cursor is null then s.historical_cursor_history = '[]'::pg_catalog.jsonb
                    else s.historical_anchor_ts is not null
                         and pg_catalog.jsonb_array_length(s.historical_cursor_history) > 0
                         and (s.historical_cursor_history -> -1) = pg_catalog.to_jsonb(s.historical_cursor) end
             else false end, false)
    ) then
      raise exception using errcode = 'P0001', message = 'AM_F2_UPGRADE_INVALID_STATE';
    end if;
  end if;

  -- Present progress tuples are validated now too, against the same predicates the named progress
  -- CHECKs install below. They never read a history column, so they also hold where it is absent.
  if newest_segment_columns = 3 then
    if exists (
      select 1 from public.slack_sync_channels
       where not coalesce(case
         when newest_anchor_ts is null then
           newest_request_lower_ts is null and newest_segment_lower_ts is null and newest_segment_upper_ts is null
         when newest_request_lower_ts is null and newest_segment_lower_ts is null and newest_segment_upper_ts is null then
           newest_cursor is null and newest_lower_ts is not null
         when newest_request_lower_ts ~ '^(0|[1-9][0-9]{0,11})[.][0-9]{6}$'
              and newest_segment_lower_ts ~ '^(0|[1-9][0-9]{0,11})[.][0-9]{6}$'
              and newest_segment_upper_ts ~ '^(0|[1-9][0-9]{0,11})[.][0-9]{6}$'
              and newest_anchor_ts ~ '^[0-9]+[.][0-9]{1,6}$'
              and pg_catalog.char_length(pg_catalog.ltrim(pg_catalog.split_part(newest_anchor_ts, '.', 1), '0')) <= 12
              and newest_lower_ts ~ '^[0-9]+[.][0-9]{1,6}$' then
           newest_segment_upper_ts::pg_catalog.numeric <= 253402300799.999999
           and newest_request_lower_ts::pg_catalog.numeric <= newest_segment_lower_ts::pg_catalog.numeric
           and newest_segment_lower_ts::pg_catalog.numeric <= newest_segment_upper_ts::pg_catalog.numeric
           and newest_segment_upper_ts::pg_catalog.numeric <= newest_anchor_ts::pg_catalog.numeric
           and case
                 when pg_catalog.char_length(pg_catalog.ltrim(pg_catalog.split_part(newest_lower_ts, '.', 1), '0')) > 12 then true
                 else newest_request_lower_ts::pg_catalog.numeric <= newest_lower_ts::pg_catalog.numeric
               end
         else false
       end, false)
    ) then
      raise exception using errcode = 'P0001', message = 'AC02_PROGRESS_UPGRADE_INVALID_STATE';
    end if;
  end if;
  if historical_segment_columns = 3 then
    if exists (
      select 1 from public.slack_sync_channels
       where not coalesce(case
         when historical_anchor_ts is null then
           historical_segment_lower_ts is null and historical_segment_upper_ts is null
           and historical_completed_segments_oldest_ts is null and historical_oldest_seen_ts is null
         when historical_segment_lower_ts is null and historical_segment_upper_ts is null then
           historical_completed_segments_oldest_ts is null and historical_oldest_seen_ts is null and historical_cursor is null
         when historical_segment_lower_ts ~ '^(0|[1-9][0-9]{0,11})[.][0-9]{6}$'
              and historical_segment_upper_ts ~ '^(0|[1-9][0-9]{0,11})[.][0-9]{6}$'
              and historical_anchor_ts ~ '^[0-9]+[.][0-9]{1,6}$'
              and pg_catalog.char_length(pg_catalog.ltrim(pg_catalog.split_part(historical_anchor_ts, '.', 1), '0')) <= 12
              and (historical_oldest_seen_ts is null
                   or (historical_oldest_seen_ts ~ '^[0-9]+[.][0-9]{1,6}$'
                       and pg_catalog.char_length(pg_catalog.ltrim(pg_catalog.split_part(historical_oldest_seen_ts, '.', 1), '0')) <= 12))
              and (historical_completed_segments_oldest_ts is null
                   or (historical_completed_segments_oldest_ts ~ '^[0-9]+[.][0-9]{1,6}$'
                       and pg_catalog.char_length(pg_catalog.ltrim(pg_catalog.split_part(historical_completed_segments_oldest_ts, '.', 1), '0')) <= 12)) then
           historical_segment_upper_ts::pg_catalog.numeric <= 253402300799.999999
           and historical_segment_lower_ts::pg_catalog.numeric <= historical_segment_upper_ts::pg_catalog.numeric
           and historical_segment_upper_ts::pg_catalog.numeric <= historical_anchor_ts::pg_catalog.numeric
           and case
                 when historical_oldest_seen_ts is null then true
                 else historical_segment_lower_ts::pg_catalog.numeric <= historical_oldest_seen_ts::pg_catalog.numeric
                      and historical_oldest_seen_ts::pg_catalog.numeric <= historical_segment_upper_ts::pg_catalog.numeric
               end
           and case
                 when historical_completed_segments_oldest_ts is null then true
                 else historical_segment_upper_ts::pg_catalog.numeric < historical_completed_segments_oldest_ts::pg_catalog.numeric
                      and historical_completed_segments_oldest_ts::pg_catalog.numeric <= historical_anchor_ts::pg_catalog.numeric
               end
         else false
       end, false)
    ) then
      raise exception using errcode = 'P0001', message = 'AC02_PROGRESS_UPGRADE_INVALID_STATE';
    end if;
  end if;

  -- ── Introduction: each absent unit is added once; a lane is affected if either of its units was absent. ──
  newest_affected := not newest_history_present or newest_segment_columns = 0;
  historical_affected := not historical_history_present or historical_segment_columns = 0;
  if not newest_history_present then
    alter table public.slack_sync_channels add column newest_cursor_history pg_catalog.jsonb not null default '[]'::pg_catalog.jsonb;
  end if;
  if not historical_history_present then
    alter table public.slack_sync_channels add column historical_cursor_history pg_catalog.jsonb not null default '[]'::pg_catalog.jsonb;
  end if;
  if newest_segment_columns = 0 then
    alter table public.slack_sync_channels
      add column newest_request_lower_ts pg_catalog.text,
      add column newest_segment_lower_ts pg_catalog.text,
      add column newest_segment_upper_ts pg_catalog.text;
  end if;
  if historical_segment_columns = 0 then
    alter table public.slack_sync_channels
      add column historical_segment_lower_ts pg_catalog.text,
      add column historical_segment_upper_ts pg_catalog.text,
      add column historical_completed_segments_oldest_ts pg_catalog.text;
  end if;

  -- ── Any prior copy of the four named CHECKs is dropped here, catalog-guarded (no skip NOTICE), so a
  -- conflicting same-named CHECK cannot fail the restart with a value-bearing failing-row DETAIL. The
  -- explicit validation below still gates their canonical reinstallation. ──
  if exists (select 1 from pg_catalog.pg_constraint
              where conrelid = 'public.slack_sync_channels'::pg_catalog.regclass
                and conname = 'slack_sync_channels_newest_cursor_history_check') then
    alter table public.slack_sync_channels drop constraint slack_sync_channels_newest_cursor_history_check;
  end if;
  if exists (select 1 from pg_catalog.pg_constraint
              where conrelid = 'public.slack_sync_channels'::pg_catalog.regclass
                and conname = 'slack_sync_channels_historical_cursor_history_check') then
    alter table public.slack_sync_channels drop constraint slack_sync_channels_historical_cursor_history_check;
  end if;
  if exists (select 1 from pg_catalog.pg_constraint
              where conrelid = 'public.slack_sync_channels'::pg_catalog.regclass
                and conname = 'slack_sync_channels_newest_progress_check') then
    alter table public.slack_sync_channels drop constraint slack_sync_channels_newest_progress_check;
  end if;
  if exists (select 1 from pg_catalog.pg_constraint
              where conrelid = 'public.slack_sync_channels'::pg_catalog.regclass
                and conname = 'slack_sync_channels_historical_progress_check') then
    alter table public.slack_sync_channels drop constraint slack_sync_channels_historical_progress_check;
  end if;

  -- ── The once-only restart of each affected ACTIVE lane (anchor present, cursor-null claims included).
  -- Clears that lane's cursor, history and attempt-oldest and increments its generation; preserves the
  -- anchor, logical lower, segment bounds and aggregate as they are (newly introduced ones are null).
  -- A claim on the restarted lane is invalidated: lease cleared, lease generation incremented, and the
  -- turn handed to that lane. Any other claim and turn are preserved. Only restarted rows move updated_at,
  -- and ONE union update writes each row once even when both of its lanes restart.
  if newest_affected or historical_affected then
    update public.slack_sync_channels set
      newest_cursor = case when newest_affected and newest_anchor_ts is not null
        then null else newest_cursor end,
      newest_cursor_history = case when newest_affected and newest_anchor_ts is not null
        then '[]'::pg_catalog.jsonb else newest_cursor_history end,
      newest_scan_generation = case when newest_affected and newest_anchor_ts is not null
        then newest_scan_generation + 1 else newest_scan_generation end,
      historical_cursor = case when historical_affected and historical_anchor_ts is not null
        then null else historical_cursor end,
      historical_cursor_history = case when historical_affected and historical_anchor_ts is not null
        then '[]'::pg_catalog.jsonb else historical_cursor_history end,
      historical_oldest_seen_ts = case when historical_affected and historical_anchor_ts is not null
        then null else historical_oldest_seen_ts end,
      historical_scan_generation = case when historical_affected and historical_anchor_ts is not null
        then historical_scan_generation + 1 else historical_scan_generation end,
      lease_owner = case
        when (claimed_lane = 'newest' and newest_affected and newest_anchor_ts is not null)
          or (claimed_lane = 'historical' and historical_affected and historical_anchor_ts is not null)
        then null else lease_owner end,
      lease_expires_at = case
        when (claimed_lane = 'newest' and newest_affected and newest_anchor_ts is not null)
          or (claimed_lane = 'historical' and historical_affected and historical_anchor_ts is not null)
        then null else lease_expires_at end,
      lease_generation = case
        when (claimed_lane = 'newest' and newest_affected and newest_anchor_ts is not null)
          or (claimed_lane = 'historical' and historical_affected and historical_anchor_ts is not null)
        then lease_generation + 1 else lease_generation end,
      next_lane = case
        when (claimed_lane = 'newest' and newest_affected and newest_anchor_ts is not null)
          or (claimed_lane = 'historical' and historical_affected and historical_anchor_ts is not null)
        then claimed_lane else next_lane end,
      claimed_lane = case
        when (claimed_lane = 'newest' and newest_affected and newest_anchor_ts is not null)
          or (claimed_lane = 'historical' and historical_affected and historical_anchor_ts is not null)
        then null else claimed_lane end,
      updated_at = pg_catalog.clock_timestamp()
     where (newest_affected and newest_anchor_ts is not null)
        or (historical_affected and historical_anchor_ts is not null);
  end if;

  -- ── Explicit validation of every row BEFORE the named CHECKs are installed. ──
  if exists (
    select 1 from public.slack_sync_channels s
     where not coalesce(case when public.slack_channel_cursor_history_valid(s.newest_cursor_history) then
             case when s.newest_cursor is null then s.newest_cursor_history = '[]'::pg_catalog.jsonb
                  else s.newest_anchor_ts is not null
                       and pg_catalog.jsonb_array_length(s.newest_cursor_history) > 0
                       and (s.newest_cursor_history -> -1) = pg_catalog.to_jsonb(s.newest_cursor) end
           else false end, false)
        or not coalesce(case when public.slack_channel_cursor_history_valid(s.historical_cursor_history) then
             case when s.historical_cursor is null then s.historical_cursor_history = '[]'::pg_catalog.jsonb
                  else s.historical_anchor_ts is not null
                       and pg_catalog.jsonb_array_length(s.historical_cursor_history) > 0
                       and (s.historical_cursor_history -> -1) = pg_catalog.to_jsonb(s.historical_cursor) end
           else false end, false)
  ) then
    raise exception using errcode = 'P0001', message = 'AM_F2_UPGRADE_INVALID_STATE';
  end if;

  if exists (
    select 1 from public.slack_sync_channels
     where not coalesce(case
       when newest_anchor_ts is null then
         newest_request_lower_ts is null and newest_segment_lower_ts is null and newest_segment_upper_ts is null
       when newest_request_lower_ts is null and newest_segment_lower_ts is null and newest_segment_upper_ts is null then
         newest_cursor is null and newest_lower_ts is not null
       when newest_request_lower_ts ~ '^(0|[1-9][0-9]{0,11})[.][0-9]{6}$'
            and newest_segment_lower_ts ~ '^(0|[1-9][0-9]{0,11})[.][0-9]{6}$'
            and newest_segment_upper_ts ~ '^(0|[1-9][0-9]{0,11})[.][0-9]{6}$'
            and newest_anchor_ts ~ '^[0-9]+[.][0-9]{1,6}$'
            and pg_catalog.char_length(pg_catalog.ltrim(pg_catalog.split_part(newest_anchor_ts, '.', 1), '0')) <= 12
            and newest_lower_ts ~ '^[0-9]+[.][0-9]{1,6}$' then
         newest_segment_upper_ts::pg_catalog.numeric <= 253402300799.999999
         and newest_request_lower_ts::pg_catalog.numeric <= newest_segment_lower_ts::pg_catalog.numeric
         and newest_segment_lower_ts::pg_catalog.numeric <= newest_segment_upper_ts::pg_catalog.numeric
         and newest_segment_upper_ts::pg_catalog.numeric <= newest_anchor_ts::pg_catalog.numeric
         and case
               when pg_catalog.char_length(pg_catalog.ltrim(pg_catalog.split_part(newest_lower_ts, '.', 1), '0')) > 12 then true
               else newest_request_lower_ts::pg_catalog.numeric <= newest_lower_ts::pg_catalog.numeric
             end
       else false
     end, false)
        or not coalesce(case
       when historical_anchor_ts is null then
         historical_segment_lower_ts is null and historical_segment_upper_ts is null
         and historical_completed_segments_oldest_ts is null and historical_oldest_seen_ts is null
       when historical_segment_lower_ts is null and historical_segment_upper_ts is null then
         historical_completed_segments_oldest_ts is null and historical_oldest_seen_ts is null and historical_cursor is null
       when historical_segment_lower_ts ~ '^(0|[1-9][0-9]{0,11})[.][0-9]{6}$'
            and historical_segment_upper_ts ~ '^(0|[1-9][0-9]{0,11})[.][0-9]{6}$'
            and historical_anchor_ts ~ '^[0-9]+[.][0-9]{1,6}$'
            and pg_catalog.char_length(pg_catalog.ltrim(pg_catalog.split_part(historical_anchor_ts, '.', 1), '0')) <= 12
            and (historical_oldest_seen_ts is null
                 or (historical_oldest_seen_ts ~ '^[0-9]+[.][0-9]{1,6}$'
                     and pg_catalog.char_length(pg_catalog.ltrim(pg_catalog.split_part(historical_oldest_seen_ts, '.', 1), '0')) <= 12))
            and (historical_completed_segments_oldest_ts is null
                 or (historical_completed_segments_oldest_ts ~ '^[0-9]+[.][0-9]{1,6}$'
                     and pg_catalog.char_length(pg_catalog.ltrim(pg_catalog.split_part(historical_completed_segments_oldest_ts, '.', 1), '0')) <= 12)) then
         historical_segment_upper_ts::pg_catalog.numeric <= 253402300799.999999
         and historical_segment_lower_ts::pg_catalog.numeric <= historical_segment_upper_ts::pg_catalog.numeric
         and historical_segment_upper_ts::pg_catalog.numeric <= historical_anchor_ts::pg_catalog.numeric
         and case
               when historical_oldest_seen_ts is null then true
               else historical_segment_lower_ts::pg_catalog.numeric <= historical_oldest_seen_ts::pg_catalog.numeric
                    and historical_oldest_seen_ts::pg_catalog.numeric <= historical_segment_upper_ts::pg_catalog.numeric
             end
         and case
               when historical_completed_segments_oldest_ts is null then true
               else historical_segment_upper_ts::pg_catalog.numeric < historical_completed_segments_oldest_ts::pg_catalog.numeric
                    and historical_completed_segments_oldest_ts::pg_catalog.numeric <= historical_anchor_ts::pg_catalog.numeric
             end
       else false
     end, false)
  ) then
    raise exception using errcode = 'P0001', message = 'AC02_PROGRESS_UPGRADE_INVALID_STATE';
  end if;

  -- ── Named history CHECKs, reinstalled canonically (any prior copy was dropped before the restart). ──
  alter table public.slack_sync_channels add constraint slack_sync_channels_newest_cursor_history_check check (
    case when public.slack_channel_cursor_history_valid(newest_cursor_history) then
      case when newest_cursor is null then newest_cursor_history = '[]'::pg_catalog.jsonb
           else newest_anchor_ts is not null
                and pg_catalog.jsonb_array_length(newest_cursor_history) > 0
                and (newest_cursor_history -> -1) = pg_catalog.to_jsonb(newest_cursor) end
    else false end
  );
  alter table public.slack_sync_channels add constraint slack_sync_channels_historical_cursor_history_check check (
    case when public.slack_channel_cursor_history_valid(historical_cursor_history) then
      case when historical_cursor is null then historical_cursor_history = '[]'::pg_catalog.jsonb
           else historical_anchor_ts is not null
                and pg_catalog.jsonb_array_length(historical_cursor_history) > 0
                and (historical_cursor_history -> -1) = pg_catalog.to_jsonb(historical_cursor) end
    else false end
  );

  -- ── Named progress CHECKs (§4): inactive, all-null initialization and initialized branches, every
  -- bound shape-guarded before an exact numeric cast, and every other shape false — never SQL NULL. ──
  alter table public.slack_sync_channels add constraint slack_sync_channels_newest_progress_check check (
    case
      when newest_anchor_ts is null then
        newest_request_lower_ts is null and newest_segment_lower_ts is null and newest_segment_upper_ts is null
      when newest_request_lower_ts is null and newest_segment_lower_ts is null and newest_segment_upper_ts is null then
        newest_cursor is null and newest_lower_ts is not null
      when newest_request_lower_ts ~ '^(0|[1-9][0-9]{0,11})[.][0-9]{6}$'
           and newest_segment_lower_ts ~ '^(0|[1-9][0-9]{0,11})[.][0-9]{6}$'
           and newest_segment_upper_ts ~ '^(0|[1-9][0-9]{0,11})[.][0-9]{6}$'
           and newest_anchor_ts ~ '^[0-9]+[.][0-9]{1,6}$'
           and pg_catalog.char_length(pg_catalog.ltrim(pg_catalog.split_part(newest_anchor_ts, '.', 1), '0')) <= 12
           and newest_lower_ts ~ '^[0-9]+[.][0-9]{1,6}$' then
        newest_segment_upper_ts::pg_catalog.numeric <= 253402300799.999999
        and newest_request_lower_ts::pg_catalog.numeric <= newest_segment_lower_ts::pg_catalog.numeric
        and newest_segment_lower_ts::pg_catalog.numeric <= newest_segment_upper_ts::pg_catalog.numeric
        and newest_segment_upper_ts::pg_catalog.numeric <= newest_anchor_ts::pg_catalog.numeric
        and case
              when pg_catalog.char_length(pg_catalog.ltrim(pg_catalog.split_part(newest_lower_ts, '.', 1), '0')) > 12 then true
              else newest_request_lower_ts::pg_catalog.numeric <= newest_lower_ts::pg_catalog.numeric
            end
      else false
    end
  );
  alter table public.slack_sync_channels add constraint slack_sync_channels_historical_progress_check check (
    case
      when historical_anchor_ts is null then
        historical_segment_lower_ts is null and historical_segment_upper_ts is null
        and historical_completed_segments_oldest_ts is null and historical_oldest_seen_ts is null
      when historical_segment_lower_ts is null and historical_segment_upper_ts is null then
        historical_completed_segments_oldest_ts is null and historical_oldest_seen_ts is null and historical_cursor is null
      when historical_segment_lower_ts ~ '^(0|[1-9][0-9]{0,11})[.][0-9]{6}$'
           and historical_segment_upper_ts ~ '^(0|[1-9][0-9]{0,11})[.][0-9]{6}$'
           and historical_anchor_ts ~ '^[0-9]+[.][0-9]{1,6}$'
           and pg_catalog.char_length(pg_catalog.ltrim(pg_catalog.split_part(historical_anchor_ts, '.', 1), '0')) <= 12
           and (historical_oldest_seen_ts is null
                or (historical_oldest_seen_ts ~ '^[0-9]+[.][0-9]{1,6}$'
                    and pg_catalog.char_length(pg_catalog.ltrim(pg_catalog.split_part(historical_oldest_seen_ts, '.', 1), '0')) <= 12))
           and (historical_completed_segments_oldest_ts is null
                or (historical_completed_segments_oldest_ts ~ '^[0-9]+[.][0-9]{1,6}$'
                    and pg_catalog.char_length(pg_catalog.ltrim(pg_catalog.split_part(historical_completed_segments_oldest_ts, '.', 1), '0')) <= 12)) then
        historical_segment_upper_ts::pg_catalog.numeric <= 253402300799.999999
        and historical_segment_lower_ts::pg_catalog.numeric <= historical_segment_upper_ts::pg_catalog.numeric
        and historical_segment_upper_ts::pg_catalog.numeric <= historical_anchor_ts::pg_catalog.numeric
        and case
              when historical_oldest_seen_ts is null then true
              else historical_segment_lower_ts::pg_catalog.numeric <= historical_oldest_seen_ts::pg_catalog.numeric
                   and historical_oldest_seen_ts::pg_catalog.numeric <= historical_segment_upper_ts::pg_catalog.numeric
            end
        and case
              when historical_completed_segments_oldest_ts is null then true
              else historical_segment_upper_ts::pg_catalog.numeric < historical_completed_segments_oldest_ts::pg_catalog.numeric
                   and historical_completed_segments_oldest_ts::pg_catalog.numeric <= historical_anchor_ts::pg_catalog.numeric
            end
      else false
    end
  );
end
$slack_channel_history_segments$;
-- slack-channel-history-segments-upgrade:end
