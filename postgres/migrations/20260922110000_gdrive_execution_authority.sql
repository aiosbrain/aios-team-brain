-- AIO-1167 Batch 1: brain-authoritative Google Drive execution authority.
--
-- A selection hash is descriptive only. `generation` is a monotonic counter that changes on every
-- scope transition (including A -> B -> A), credential replacement, pause, resume, or disconnect.
-- `fence` changes whenever a new worker owns the lease. The HTTP sink locks this row and the
-- integration row in one transaction with each content/progress/reconciliation commit.

create table if not exists gdrive_connection_authority (
  integration_id uuid primary key references integrations(id) on delete cascade,
  team_id uuid not null references teams(id) on delete cascade,
  generation bigint not null default 1 check (generation > 0),
  scope_hash text not null,
  credential_revision bigint not null default 1 check (credential_revision > 0),
  connector_member_id uuid references members(id) on delete set null,
  connector_api_key_id uuid references api_keys(id) on delete set null,
  lease_owner text,
  fence bigint not null default 0 check (fence >= 0),
  lease_until timestamptz,
  progress jsonb not null default '{}',
  progress_revision bigint not null default 0 check (progress_revision >= 0),
  progress_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, integration_id),
  check ((lease_owner is null) = (lease_until is null)),
  check ((connector_member_id is null) = (connector_api_key_id is null))
);
alter table gdrive_connection_authority add column if not exists progress_revision bigint not null default 0;
create index if not exists gdrive_connection_authority_principal_idx
  on gdrive_connection_authority (team_id, connector_api_key_id);

create or replace function gdrive_selection_fingerprint(p_config jsonb)
returns text language sql immutable parallel safe as $$
  select md5(jsonb_build_object(
    'fileIds', coalesce(p_config->'fileIds', '[]'::jsonb),
    'folderIds', coalesce(p_config->'folderIds', '[]'::jsonb),
    'sharedDriveIds', coalesce(p_config->'sharedDriveIds', '[]'::jsonb),
    'recursive', coalesce(p_config->'recursive', 'false'::jsonb),
    'selectionState', coalesce(p_config->'selectionState', '"absent"'::jsonb),
    'projectSlug', coalesce(p_config->'projectSlug', 'null'::jsonb),
    'access', coalesce(p_config->'access', '"team"'::jsonb),
    'authMode', coalesce(p_config->'authMode', '"oauth"'::jsonb),
    'authenticatedAccountId', coalesce(p_config->'authenticatedAccountId', 'null'::jsonb),
    'scopeSet', coalesce(p_config->'scopeSet', '[]'::jsonb),
    'audienceProjectIds', coalesce(p_config->'audienceProjectIds', '[]'::jsonb)
  )::text)
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
    progress = case when scope_changed or credential_changed then '{}'::jsonb else gdrive_connection_authority.progress end,
    progress_revision = gdrive_connection_authority.progress_revision
      + case when scope_changed or credential_changed then 1 else 0 end,
    progress_updated_at = case when scope_changed or credential_changed then null else gdrive_connection_authority.progress_updated_at end,
    updated_at = now();
  return new;
end
$$;

drop trigger if exists integrations_gdrive_authority on integrations;
create trigger integrations_gdrive_authority
  after insert or update of config, status, secret_ciphertext on integrations
  for each row execute function sync_gdrive_connection_authority();

insert into gdrive_connection_authority(integration_id, team_id, scope_hash)
select id, team_id, gdrive_selection_fingerprint(config)
from integrations where type = 'gdrive'
on conflict (integration_id) do nothing;

-- The fingerprint gained account/auth inputs before release. Replaying this additive migration on
-- an already-initialized test or self-host database must bring the descriptive hash up to date
-- without changing generation or durable progress.
update gdrive_connection_authority authority
set scope_hash = gdrive_selection_fingerprint(integration.config), updated_at = now()
from integrations integration
where integration.id = authority.integration_id and integration.type = 'gdrive';
