-- AIO-1167 R50: a provider minimum outlives a selection generation.
--
-- The coordinator's fenced progress carries the provider minimums it learned — the account hold
-- (`account_hold`), per-resource restrictions (`document_restrictions`) and the evidence it carries
-- for other verified accounts of the same connection (`retained_restrictions`). Their lifetime is
-- the verified connection/account and stable provider resource; a selection generation is only the
-- context they were observed in. Until now a scope or credential transition reset `progress` to
-- `{}`, so the first worker of the new generation could read a restricted resource early — a scope
-- edit or a reconnect worked as an implicit provider override (Astra R48/R49).
--
-- The transition still resets every generation-specific section (streams, cursors, roots, watches)
-- and still advances generation, revision and lease exactly as before; it now KEEPS only those three
-- restriction sections. Applicability stays the sidecar's: it adopts only its own verified account's
-- evidence and carries any other account's forward unchanged. Execution, cursor, membership and
-- publication authority remain generation-bound — a stale worker is still refused.
--
-- Additive and replay-safe: `create or replace` only. `postgres/schema.sql` mirrors the final
-- function and trigger body for from-zero loads.

create or replace function gdrive_retained_restriction_progress(p_progress jsonb)
returns jsonb language plpgsql immutable as $$
declare
  retained jsonb := '{}'::jsonb;
  section text;
begin
  if p_progress is null or jsonb_typeof(p_progress) <> 'object' then
    return retained;
  end if;
  foreach section in array array['account_hold', 'document_restrictions', 'retained_restrictions'] loop
    if p_progress ? section then
      retained := retained || jsonb_build_object(section, p_progress -> section);
    end if;
  end loop;
  return retained;
end
$$;

create or replace function sync_gdrive_connection_authority()
returns trigger language plpgsql as $$
declare
  next_hash text;
  scope_changed boolean;
  credential_changed boolean;
  status_changed boolean;
begin
  if new.type <> 'gdrive' then
    return new;
  end if;
  next_hash := gdrive_selection_fingerprint(new.config);
  if tg_op = 'INSERT' then
    insert into gdrive_connection_authority(integration_id, team_id, scope_hash)
    values (new.id, new.team_id, next_hash)
    on conflict (integration_id) do nothing;
    return new;
  end if;

  scope_changed := next_hash is distinct from gdrive_selection_fingerprint(old.config);
  credential_changed := new.secret_ciphertext is distinct from old.secret_ciphertext;
  status_changed := new.status is distinct from old.status;
  insert into gdrive_connection_authority(integration_id, team_id, scope_hash)
  values (new.id, new.team_id, next_hash)
  on conflict (integration_id) do update set
    team_id = excluded.team_id,
    scope_hash = excluded.scope_hash,
    generation = gdrive_connection_authority.generation
      + case when scope_changed or credential_changed then 1 else 0 end,
    credential_revision = gdrive_connection_authority.credential_revision
      + case when credential_changed then 1 else 0 end,
    fence = gdrive_connection_authority.fence + case when status_changed then 1 else 0 end,
    lease_owner = case when scope_changed or credential_changed or status_changed then null else gdrive_connection_authority.lease_owner end,
    lease_until = case when scope_changed or credential_changed or status_changed then null else gdrive_connection_authority.lease_until end,
    -- Generation-specific progress is reset; provider-minimum evidence is kept (AIO-1167 R50).
    progress = case
      when scope_changed or credential_changed
        then gdrive_retained_restriction_progress(gdrive_connection_authority.progress)
      else gdrive_connection_authority.progress
    end,
    progress_revision = gdrive_connection_authority.progress_revision
      + case when scope_changed or credential_changed then 1 else 0 end,
    progress_updated_at = case when scope_changed or credential_changed then null else gdrive_connection_authority.progress_updated_at end,
    updated_at = now();
  return new;
end
$$;
