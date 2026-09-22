-- AIO-1167 Batch 2: a correction is executable only while every source its prose depends on is
-- currently authorized in its exact partition. Existing rows deliberately default to unproven;
-- history is retained, but legacy prose can never be interpreted as unrestricted.

alter table arc_corrections
  add column if not exists provenance_state text not null default 'unproven';
alter table arc_corrections
  add column if not exists source_dependency_count integer not null default 0;
alter table arc_corrections
  add column if not exists captured_authorization_epoch bigint;

alter table arc_corrections drop constraint if exists arc_corrections_provenance_state_check;
alter table arc_corrections add constraint arc_corrections_provenance_state_check
  check (provenance_state in ('unproven','incomplete','complete'));
alter table arc_corrections drop constraint if exists arc_corrections_source_dependency_count_check;
alter table arc_corrections add constraint arc_corrections_source_dependency_count_check
  check (source_dependency_count >= 0);

create table if not exists arc_correction_source_dependencies (
  correction_id uuid not null references arc_corrections(id) on delete cascade,
  team_id uuid not null references teams(id) on delete cascade,
  source_item_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (correction_id, source_item_id)
);
create index if not exists arc_correction_source_dependencies_team_item_idx
  on arc_correction_source_dependencies(team_id, source_item_id);
