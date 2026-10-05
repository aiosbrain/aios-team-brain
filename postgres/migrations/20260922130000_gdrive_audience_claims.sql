-- AIO-1167 Batch 2: canonical Drive items, per-connection audience claims, and a
-- durable cache-publication barrier for authorization changes.

create table if not exists team_authorization_epochs (
  team_id uuid primary key references teams(id) on delete cascade,
  epoch bigint not null default 1 check (epoch > 0),
  updated_at timestamptz not null default now()
);
insert into team_authorization_epochs(team_id)
select id from teams on conflict (team_id) do nothing;

create table if not exists gdrive_item_claims (
  team_id uuid not null references teams(id) on delete cascade,
  integration_id uuid not null,
  provider_id text not null,
  item_id uuid not null,
  active boolean not null default true,
  generation bigint not null check (generation > 0),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (team_id, integration_id, provider_id),
  foreign key (team_id, integration_id) references gdrive_connection_authority(team_id, integration_id) on delete cascade,
  foreign key (team_id, item_id) references items(team_id, id) on delete cascade
);
create index if not exists gdrive_item_claims_item_idx
  on gdrive_item_claims(team_id, item_id) where active;

create table if not exists gdrive_item_claim_projects (
  team_id uuid not null,
  integration_id uuid not null,
  provider_id text not null,
  project_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (team_id, integration_id, provider_id, project_id),
  foreign key (team_id, integration_id, provider_id)
    references gdrive_item_claims(team_id, integration_id, provider_id) on delete cascade,
  foreign key (team_id, project_id) references projects(team_id, id) on delete cascade
);
create index if not exists gdrive_item_claim_projects_project_idx
  on gdrive_item_claim_projects(team_id, project_id);

-- Durable second phase of a final-claim revocation. The short authority transaction retracts the
-- context unit and creates this row; graph/item/cache cleanup retries after that transaction commits.
create table if not exists gdrive_cleanup_obligations (
  team_id uuid not null references teams(id) on delete cascade,
  provider_id text not null,
  item_id uuid not null,
  reason text not null,
  actor_member_id uuid references members(id) on delete set null,
  actor_api_key_id uuid references api_keys(id) on delete set null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (team_id, provider_id)
);
create index if not exists gdrive_cleanup_obligations_retry_idx
  on gdrive_cleanup_obligations(updated_at, team_id);

alter table arc_cache add column if not exists authorization_epoch bigint not null default 1;
alter table work_timeline_cache add column if not exists authorization_epoch bigint not null default 1;

alter table project_context_memberships drop constraint if exists project_context_memberships_method_check;
alter table project_context_memberships add constraint project_context_memberships_method_check
  check (method in ('ingestion_project','explicit_ref','rule','embedding','llm','manual','exclude_shadow_repair','gdrive_claim'));

-- Capture EVERY team whose legacy Drive visibility is about to be suppressed, including teams whose
-- rows cannot be safely adopted. This set, not successful adoption, owns the epoch/cache barrier.
drop table if exists pg_temp.gdrive_suppressed_units;
create temp table gdrive_suppressed_units(unit_id uuid primary key, team_id uuid not null);
insert into gdrive_suppressed_units(unit_id,team_id)
select u.id,u.team_id
  from project_context_units u join items i on i.team_id=u.team_id and i.id=u.source_item_id
 where i.frontmatter->>'source'='gdrive'
   and not exists (
     select 1 from gdrive_item_claims c
      where c.team_id=i.team_id and c.item_id=i.id and c.active
   )
on conflict do nothing;

drop table if exists pg_temp.gdrive_suppressed_teams;
create temp table gdrive_suppressed_teams(team_id uuid primary key);
insert into gdrive_suppressed_teams(team_id)
select distinct team_id from gdrive_suppressed_units
on conflict do nothing;

-- Collision-safe legacy adoption: only mappings carrying an exact UUID connection id that resolves
-- to an existing same-team Drive integration are adopted. Ambiguous path-only history is untouched.
with adopted as (
  insert into gdrive_item_claims(team_id,integration_id,provider_id,item_id,generation)
  select m.team_id,i.id,m.provider_id,m.item_id,a.generation
    from source_item_mappings m
    join integrations i on i.team_id=m.team_id and i.type='gdrive'
      and i.id::text=m.connection_id
    join gdrive_connection_authority a on a.team_id=i.team_id and a.integration_id=i.id
    join items item on item.team_id=m.team_id and item.id=m.item_id
   where m.source='gdrive'
  on conflict do nothing returning team_id
)
select count(*) from adopted;

insert into gdrive_item_claim_projects(team_id,integration_id,provider_id,project_id)
select c.team_id,c.integration_id,c.provider_id,p.id
  from gdrive_item_claims c
  join integrations i on i.team_id=c.team_id and i.id=c.integration_id
  cross join lateral jsonb_array_elements_text(coalesce(i.config->'audienceProjectIds','[]'::jsonb)) grant_id
  join projects p on p.team_id=c.team_id and p.id::text=grant_id
on conflict do nothing;

-- Fail closed during adoption by discarding legacy generic context units (their memberships cascade).
-- The next authorized connector backfill/re-ingest recreates the item unit and claim memberships
-- through the application context owners. Unresolved/path-only history remains hidden, never General.
delete from project_context_units u
where u.id in (select unit_id from gdrive_suppressed_units);

-- External is the conservative inherited tier; approved project memberships remain the authority.
-- Replay-idempotent: this file runs on every deploy, so only a row whose tier actually differs is
-- written. An already-external claimed item keeps its `updated_at` and its row version — rewriting
-- it would re-date unchanged content and hand it to every `updated_at`-based incremental pull.
update items i set access='external', updated_at=now()
where i.access is distinct from 'external'
  and exists (select 1 from gdrive_item_claims c where c.team_id=i.team_id and c.item_id=i.id and c.active);

update team_authorization_epochs e set epoch=e.epoch+1,updated_at=now()
where e.team_id in (select team_id from gdrive_suppressed_teams);
delete from arc_cache where team_id in (select team_id from gdrive_suppressed_teams);
delete from work_timeline_cache where team_id in (select team_id from gdrive_suppressed_teams);
drop table gdrive_suppressed_teams;
drop table gdrive_suppressed_units;
