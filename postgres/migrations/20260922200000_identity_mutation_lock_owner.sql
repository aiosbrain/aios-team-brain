-- AIO-1167 Batch 4 closure: application-owned identity mutation serialization.
--
-- Production writers now acquire `${team_id}:identity-authority` before affected rows. The trigger
-- must only advance durable revision/repair/cache bookkeeping; acquiring the authority after a row
-- mutation would recreate the row -> authority inversion this boundary removes.

create or replace function bump_team_identity_authority()
returns trigger language plpgsql as $$
declare
  v_team_id uuid;
  v_changed boolean := true;
  v_had_authority boolean;
begin
  v_team_id := case when tg_op='DELETE' then old.team_id else new.team_id end;
  if tg_table_name='members' then
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
  if not exists (select 1 from teams where id=v_team_id) then return coalesce(new,old); end if;

  -- Lock ordering belongs to the application mutation boundary. This trigger is bookkeeping only.
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
  if not exists (select 1 from items where team_id=v_team_id)
     and not exists (select 1 from code_contributions where team_id=v_team_id)
     and not exists (select 1 from gdrive_contribution_evidence where team_id=v_team_id) then
    update team_identity_authority
       set repair_status='complete',completed_at=now()
     where team_id=v_team_id;
  end if;
  if v_had_authority then
    insert into team_authorization_epochs(team_id,epoch,updated_at) values (v_team_id,2,now())
    on conflict (team_id) do update set
      epoch=team_authorization_epochs.epoch+1,updated_at=now();
  end if;
  return coalesce(new,old);
end $$;
