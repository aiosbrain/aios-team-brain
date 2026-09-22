-- AIO-1167 Batch 4 correction: one durable team-wide identity snapshot fence.
--
-- Every roster/alias/provider-identity mutation advances this authority in the same
-- transaction, including writes that do not pass through the application helpers. A
-- repair snapshot and each bounded item commit take the matching advisory lock and
-- compare `revision`, so an older P worker cannot publish after a newer Q mapping.

create table if not exists team_identity_authority (
  team_id uuid primary key references teams(id) on delete cascade,
  revision bigint not null default 1 check (revision > 0),
  repair_revision bigint not null default 1 check (repair_revision > 0),
  repair_status text not null default 'complete'
    check (repair_status in ('pending','running','retry','awaiting_cache','complete')),
  cursor_item_id uuid,
  items_scanned bigint not null default 0,
  items_updated bigint not null default 0,
  versions_updated bigint not null default 0,
  contributions_updated bigint not null default 0,
  attempts integer not null default 0,
  last_error text,
  next_attempt_at timestamptz,
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  check (repair_revision <= revision)
);
create index if not exists team_identity_authority_pending_idx
  on team_identity_authority(repair_status,next_attempt_at,updated_at)
  where repair_status in ('pending','running','retry','awaiting_cache');

alter table gdrive_contribution_evidence
  add column if not exists authority_revision bigint;

-- Existing teams need one bounded convergence pass under the new complete-read protocol; treating
-- upgrade state as complete would strand stale non-Drive attribution until a later mapping edit.
insert into team_identity_authority(team_id,revision,repair_revision,repair_status,completed_at)
select id,1,1,'pending',null from teams
on conflict (team_id) do nothing;

create or replace function bump_team_identity_authority()
returns trigger language plpgsql as $$
declare
  v_team_id uuid;
  v_changed boolean := true;
  v_had_authority boolean;
begin
  v_team_id := case when tg_op='DELETE' then old.team_id else new.team_id end;
  if tg_table_name='members' then
    v_team_id := case when tg_op='DELETE' then old.team_id else new.team_id end;
    if tg_op='UPDATE' then
      v_changed := old.email is distinct from new.email
        or old.actor_handle is distinct from new.actor_handle
        or old.status is distinct from new.status
        or old.is_connector is distinct from new.is_connector;
    end if;
  elsif tg_table_name='member_emails' and tg_op='UPDATE' then
    v_changed := old.team_id is distinct from new.team_id
      or old.member_id is distinct from new.member_id
      or old.email is distinct from new.email;
  elsif tg_table_name='member_identities' and tg_op='UPDATE' then
    v_changed := old.team_id is distinct from new.team_id
      or old.member_id is distinct from new.member_id
      or old.provider is distinct from new.provider
      or old.external_id is distinct from new.external_id
      or old.handle is distinct from new.handle
      or old.email is distinct from new.email;
  end if;
  if not v_changed then return coalesce(new,old); end if;
  -- A parent-team delete cascades through all three watched tables. Do not recreate
  -- authority while the referenced team is disappearing.
  if not exists (select 1 from teams where id=v_team_id) then return coalesce(new,old); end if;
  perform pg_advisory_xact_lock(hashtextextended(v_team_id::text || ':identity-authority',0));
  select exists(select 1 from team_identity_authority where team_id=v_team_id)
    into v_had_authority;
  insert into team_identity_authority(
    team_id,revision,repair_revision,repair_status,cursor_item_id,
    items_scanned,items_updated,versions_updated,contributions_updated,
    attempts,last_error,next_attempt_at,updated_at,completed_at
  ) values (
    v_team_id,1,1,'pending',null,0,0,0,0,0,null,null,now(),null
  ) on conflict (team_id) do update set
    revision=team_identity_authority.revision+1,
    repair_revision=team_identity_authority.revision+1,
    repair_status='pending',cursor_item_id=null,
    items_scanned=0,items_updated=0,versions_updated=0,contributions_updated=0,
    attempts=0,last_error=null,next_attempt_at=null,updated_at=now(),completed_at=null;
  -- A roster mutation on a team with no attribution-bearing data needs no repair work. Marking that
  -- initial state complete keeps a newly-created empty team readable while preserving the barrier for
  -- every team where stale credit could exist.
  if not exists (select 1 from items where team_id=v_team_id)
     and not exists (select 1 from code_contributions where team_id=v_team_id)
     and not exists (select 1 from gdrive_contribution_evidence where team_id=v_team_id) then
    update team_identity_authority
       set repair_status='complete',completed_at=now()
     where team_id=v_team_id;
  end if;
  -- Identity attribution is part of every cached visibility variant. Establish the durable cache
  -- barrier in the SAME transaction as the mapping/alias/roster mutation; physical purge may retry.
  -- The very first roster row creates this authority for a brand-new team. There cannot yet be a
  -- prior attribution payload to invalidate, so preserve the canonical initial epoch (1). Every
  -- subsequent roster/alias/provider mutation advances the shared barrier, even on an empty team.
  if v_had_authority then
    insert into team_authorization_epochs(team_id,epoch,updated_at) values (v_team_id,2,now())
    on conflict (team_id) do update set
      epoch=team_authorization_epochs.epoch+1,updated_at=now();
  end if;
  return coalesce(new,old);
end $$;

drop trigger if exists members_identity_authority_trg on members;
create trigger members_identity_authority_trg
after insert or delete or update on members
for each row execute function bump_team_identity_authority();

drop trigger if exists member_emails_identity_authority_trg on member_emails;
create trigger member_emails_identity_authority_trg
after insert or delete or update on member_emails
for each row execute function bump_team_identity_authority();

drop trigger if exists member_identities_identity_authority_trg on member_identities;
create trigger member_identities_identity_authority_trg
after insert or delete or update on member_identities
for each row execute function bump_team_identity_authority();
