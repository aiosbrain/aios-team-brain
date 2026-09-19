-- AIO-1170: inactive until an attended migration sets one team's marker in the same
-- transaction as its identity row changes. This migration does not set a marker or alter rows.
alter table teams add column if not exists slack_identity_cutover_at timestamptz;

-- Match the ECMAScript String.trim whitespace/line-terminator set used by
-- lib/identity/resolve.ts providerKey. PostgreSQL's one-argument btrim removes only U+0020.
-- The set is U+0009-000D, U+0020, U+00A0, U+1680, U+2000-200A,
-- U+2028-2029, U+202F, U+205F, U+3000, and U+FEFF.
create or replace function is_slack_identity_provider(provider text)
returns boolean language sql immutable strict as $$
  select lower(btrim($1, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) = 'slack';
$$;

-- A Slack identity write locks its team row before testing the marker. A concurrent marker
-- UPDATE takes a conflicting row lock, so an old worker cannot commit a raw mapping after
-- the attended transaction commits. All existing rows and writes retain their behavior
-- while the marker is NULL. Classify provider variants before this lock, but require exact
-- stored spelling after cutover. DELETE is deliberately unrestricted.
create or replace function enforce_slack_identity_cutover()
returns trigger language plpgsql as $$
declare cutover_at timestamptz;
begin
  if not is_slack_identity_provider(new.provider) then
    return new;
  end if;
  select slack_identity_cutover_at into cutover_at
    from teams where id = new.team_id for share;
  if cutover_at is not null
     and (new.provider collate "C" <> 'slack'
          or new.external_id collate "C" !~ '^[A-Z0-9]+:[A-Z0-9]+$') then
    raise exception using errcode = '23514',
      message = 'Slack identity requires canonical WORKSPACE:USER after team cutover';
  end if;
  return new;
end;
$$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'member_identities_slack_cutover_guard'
                 and tgrelid = 'member_identities'::regclass and not tgisinternal) then
    create trigger member_identities_slack_cutover_guard
      before insert or update on member_identities
      for each row execute function enforce_slack_identity_cutover();
  end if;
end $$;

-- Keep an activated team fenced on schema replay and ordinary team updates. Team deletion
-- remains available through the existing cascade.
create or replace function protect_slack_identity_cutover_marker()
returns trigger language plpgsql as $$
begin
  if old.slack_identity_cutover_at is not null
     and new.slack_identity_cutover_at is distinct from old.slack_identity_cutover_at then
    raise exception using errcode = '23514',
      message = 'Slack identity cutover marker cannot be changed';
  end if;
  return new;
end;
$$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'teams_slack_identity_cutover_marker_guard'
                 and tgrelid = 'teams'::regclass and not tgisinternal) then
    create trigger teams_slack_identity_cutover_marker_guard
      before update of slack_identity_cutover_at on teams
      for each row execute function protect_slack_identity_cutover_marker();
  end if;
end $$;
