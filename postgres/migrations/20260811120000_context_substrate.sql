-- Context substrate, Phase A slice 4 (spec §"project_context_units"/"project_context_memberships").
-- The item-grain subset: enough for the §11 backfill to write and the oracle's canSee to read.
-- Task/decision/meeting-segment grains + events/suggestions/rules land in Phase D.
--
-- New tables → schema.sql `create table if not exists` covers from-zero; this migration exists so
-- an EXISTING prod DB gets them too (schema.sql editing a create-body is a no-op once the table
-- exists — but these are brand-new tables, so the create runs; kept here for the composite-FK
-- targets that need projects(team_id,id) / items(team_id,id) already present, which slices 1-3
-- created). Idempotent throughout.

-- items needs a composite (team_id, id) target for the unit's same-team FK (projects already has one).
create unique index if not exists items_team_id_id_idx on items (team_id, id);

create table if not exists project_context_units (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  unit_kind text not null default 'item' check (unit_kind in ('item','task','decision','meeting_segment')),
  -- item-grain only in this slice; the other source columns arrive with their grains (Phase D).
  source_item_id uuid,
  unit_key text not null,
  audience access_tier not null,          -- inherited from items.access; NEVER classifier-set
  content_sha256 text not null,
  state text not null default 'active' check (state in ('active','retracted')),
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (team_id, source_item_id) references items (team_id, id) on delete cascade
);
-- One item unit per item (the item-grain partial unique the contract names).
create unique index if not exists pcu_item_key_idx
  on project_context_units (team_id, source_item_id) where unit_kind = 'item';
create index if not exists pcu_team_audience_idx on project_context_units (team_id, audience) where state = 'active';

create table if not exists project_context_memberships (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  project_id uuid not null,
  context_unit_id uuid not null references project_context_units (id) on delete cascade,
  decision text not null default 'include' check (decision in ('include','exclude')),
  mode text not null default 'auto' check (mode in ('auto','force_include','force_exclude')),
  method text not null default 'ingestion_project'
    check (method in ('ingestion_project','explicit_ref','rule','embedding','llm','manual')),
  decided_by uuid,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (team_id, project_id) references projects (team_id, id) on delete cascade
);
-- At most one CURRENT row per (team, project, unit) — the contract's core uniqueness invariant.
create unique index if not exists pcm_current_idx
  on project_context_memberships (team_id, project_id, context_unit_id) where valid_to is null;
create index if not exists pcm_unit_idx on project_context_memberships (team_id, context_unit_id) where valid_to is null;
