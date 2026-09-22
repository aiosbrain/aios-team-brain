-- Immutable correction revisions and a correction-specific cache publication fence.
create table if not exists arc_correction_revisions (
  id uuid primary key default gen_random_uuid(),
  correction_id uuid not null references arc_corrections(id) on delete cascade,
  revision_number bigint not null,
  corrected_text text not null check (corrected_text <> ''),
  provenance_state text not null default 'unproven'
    check (provenance_state in ('unproven','incomplete','complete')),
  source_dependency_count integer not null default 0 check (source_dependency_count >= 0),
  parent_revision_count integer not null default 0 check (parent_revision_count >= 0),
  captured_authorization_epoch bigint,
  created_by uuid references members(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (correction_id, revision_number)
);
alter table arc_correction_revisions
  add column if not exists parent_revision_count integer not null default 0 check (parent_revision_count >= 0);

create table if not exists arc_correction_revision_dependencies (
  revision_id uuid not null references arc_correction_revisions(id) on delete cascade,
  team_id uuid not null references teams(id) on delete cascade,
  source_item_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (revision_id, source_item_id)
);
create index if not exists arc_correction_revision_dependencies_team_item_idx
  on arc_correction_revision_dependencies(team_id, source_item_id);
create table if not exists arc_correction_revision_parents (
  revision_id uuid not null references arc_correction_revisions(id) on delete cascade,
  parent_revision_id uuid not null references arc_correction_revisions(id),
  primary key (revision_id, parent_revision_id),
  check (revision_id <> parent_revision_id)
);

alter table arc_corrections add column if not exists current_revision_id uuid;
do $$ begin
  alter table arc_corrections add constraint arc_corrections_current_revision_fk
    foreign key (current_revision_id) references arc_correction_revisions(id);
exception when duplicate_object then null; end $$;

-- Existing rows become immutable revision 1. Their prior provenance ledger is copied verbatim;
-- legacy rows remain unproven and therefore synthesis-ineligible.
insert into arc_correction_revisions (
  correction_id, revision_number, corrected_text, provenance_state,
  source_dependency_count, parent_revision_count, captured_authorization_epoch, created_by, created_at
)
select id, 1, corrected_text, provenance_state, source_dependency_count, 0,
       captured_authorization_epoch, created_by, created_at
from arc_corrections
on conflict (correction_id, revision_number) do nothing;

insert into arc_correction_revision_dependencies (revision_id, team_id, source_item_id)
select r.id, d.team_id, d.source_item_id
from arc_correction_revisions r
join arc_correction_source_dependencies d on d.correction_id = r.correction_id
where r.revision_number = 1
on conflict do nothing;

update arc_corrections c
set current_revision_id = r.id
from arc_correction_revisions r
where r.correction_id = c.id and r.revision_number = 1 and c.current_revision_id is null;

create table if not exists team_arc_correction_versions (
  team_id uuid primary key references teams(id) on delete cascade,
  version bigint not null default 0 check (version >= 0),
  updated_at timestamptz not null default now()
);
insert into team_arc_correction_versions (team_id, version)
select distinct team_id, 1 from arc_corrections
on conflict (team_id) do nothing;

alter table arc_cache add column if not exists correction_version bigint not null default 0;
