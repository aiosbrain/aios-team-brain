-- AIO-1170 AM-F2 + AC-02 deep history: bounded Slack cursor histories and timestamp segments
-- for public.slack_sync_channels (accepted consolidated contract
-- `aio1170-am-f2-deep-history-consolidated-accepted-spec-migration-v1-20261023.md`, §9 and §9.3).
--
-- ⚠️ PARTIAL — NOT PUBLISHABLE. This block introduces the two cursor histories, the six
-- segment/progress columns, the history validator and the two named history CHECKs, with the
-- once-only lane restart. The named PROGRESS-BOUND CHECKs (§4/§9: canonical bound domain, exact
-- cross-field tick relations, inactive/active/all-null-initialization branches, the
-- historical_completed_segments_oldest_ts grammar) are NOT yet installed.
--
-- The executable body is ONE self-contained atomic DO statement, byte-identical to the block
-- between `-- slack-channel-history-segments-upgrade:begin` and
-- `-- slack-channel-history-segments-upgrade:end` in postgres/schema.sql. Nothing else in this file
-- executes. Ownership: PR714 owns this file and the bounded Slack history/segment block; PR743
-- retains Drive schema/migrations and the loader/pool. Nothing here is wired or activated.
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
       and not coalesce(p.prokind = 'f' and p.pronargs = 1
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

  -- ── The once-only restart of each affected ACTIVE lane (anchor present, cursor-null claims included).
  -- Clears that lane's cursor, history and attempt-oldest and increments its generation; preserves the
  -- anchor, logical lower, segment bounds and aggregate as they are (newly introduced ones are null).
  -- A claim on the restarted lane is invalidated: lease cleared, lease generation incremented, and the
  -- turn handed to that lane. Any other claim and turn are preserved. Only restarted rows move updated_at.
  if newest_affected then
    update public.slack_sync_channels set
      newest_cursor = null,
      newest_cursor_history = '[]'::pg_catalog.jsonb,
      newest_scan_generation = newest_scan_generation + 1,
      lease_owner = case when claimed_lane = 'newest' then null else lease_owner end,
      lease_expires_at = case when claimed_lane = 'newest' then null else lease_expires_at end,
      lease_generation = case when claimed_lane = 'newest' then lease_generation + 1 else lease_generation end,
      next_lane = case when claimed_lane = 'newest' then 'newest' else next_lane end,
      claimed_lane = case when claimed_lane = 'newest' then null else claimed_lane end,
      updated_at = pg_catalog.clock_timestamp()
     where newest_anchor_ts is not null;
  end if;
  if historical_affected then
    update public.slack_sync_channels set
      historical_cursor = null,
      historical_cursor_history = '[]'::pg_catalog.jsonb,
      historical_oldest_seen_ts = null,
      historical_scan_generation = historical_scan_generation + 1,
      lease_owner = case when claimed_lane = 'historical' then null else lease_owner end,
      lease_expires_at = case when claimed_lane = 'historical' then null else lease_expires_at end,
      lease_generation = case when claimed_lane = 'historical' then lease_generation + 1 else lease_generation end,
      next_lane = case when claimed_lane = 'historical' then 'historical' else next_lane end,
      claimed_lane = case when claimed_lane = 'historical' then null else claimed_lane end,
      updated_at = pg_catalog.clock_timestamp()
     where historical_anchor_ts is not null;
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

  -- ── Named history CHECKs: dropped only when present (no skip NOTICE), then re-added identically. ──
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
end
$slack_channel_history_segments$;
-- slack-channel-history-segments-upgrade:end
