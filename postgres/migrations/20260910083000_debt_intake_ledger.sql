-- AIO-1101: immutable finding evidence. Rollback disables writers; it never deletes this ledger.
create table if not exists codebase_debt_candidates (
  team_id uuid not null references teams(id) on delete restrict,
  candidate_id text not null check (candidate_id ~ '^[0-9a-f]{64}$'),
  identity jsonb not null check (jsonb_typeof(identity) = 'object'),
  program_id text not null check (program_id ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (team_id, candidate_id)
);

create table if not exists codebase_debt_candidate_codebases (
  team_id uuid not null,
  candidate_id text not null,
  codebase_slug text not null,
  primary key (team_id, candidate_id, codebase_slug),
  foreign key (team_id, candidate_id) references codebase_debt_candidates(team_id, candidate_id) on delete restrict,
  foreign key (team_id, codebase_slug) references codebases(team_id, slug) on delete restrict
);

create table if not exists codebase_debt_candidate_events (
  team_id uuid not null references teams(id) on delete restrict,
  event_id text not null check (event_id ~ '^[0-9a-f]{64}$'),
  record jsonb not null check (jsonb_typeof(record) = 'object'),
  canonical_record text not null,
  received_at timestamptz not null default now(),
  record_type text generated always as (record->>'record_type') stored not null,
  candidate_id text generated always as (record->>'candidate_id') stored,
  sequence bigint generated always as ((record->>'sequence')::bigint) stored,
  producer_name text generated always as (record->'producer'->>'name') stored not null,
  producer_run_id text generated always as (record->'producer'->>'run_id') stored not null,
  duplicate_target text generated always as (record->>'duplicate_target') stored,
  primary key (team_id, event_id),
  foreign key (team_id, candidate_id) references codebase_debt_candidates(team_id, candidate_id) on delete restrict,
  check (record = canonical_record::jsonb),
  check (record->>'event_id' is not null and event_id = record->>'event_id'),
  check (record_type in ('candidate', 'run_summary')),
  check ((record_type = 'candidate' and candidate_id is not null and candidate_id ~ '^[0-9a-f]{64}$' and sequence is not null and sequence >= 0)
    or (record_type = 'run_summary' and candidate_id is null and sequence is null and duplicate_target is null))
);

create unique index if not exists debt_candidate_sequence_unique
  on codebase_debt_candidate_events(team_id, candidate_id, sequence) where record_type = 'candidate';
create unique index if not exists debt_run_summary_unique
  on codebase_debt_candidate_events(team_id, producer_name, producer_run_id) where record_type = 'run_summary';
create index if not exists debt_run_candidate_latest
  on codebase_debt_candidate_events(team_id, producer_name, producer_run_id, candidate_id, sequence desc);
create index if not exists debt_historical_duplicate_edges
  on codebase_debt_candidate_events(team_id, candidate_id, duplicate_target) where duplicate_target is not null;

create or replace function protect_debt_intake_evidence() returns trigger language plpgsql as $$
begin
  raise exception 'debt intake evidence is append-only';
end;
$$;
-- Row protection intentionally does not claim privileged TRUNCATE/DDL resistance.
drop trigger if exists debt_candidates_protect on codebase_debt_candidates;
create trigger debt_candidates_protect before update or delete on codebase_debt_candidates
  for each row execute function protect_debt_intake_evidence();
drop trigger if exists debt_memberships_protect on codebase_debt_candidate_codebases;
create trigger debt_memberships_protect before update or delete on codebase_debt_candidate_codebases
  for each row execute function protect_debt_intake_evidence();
drop trigger if exists debt_events_protect on codebase_debt_candidate_events;
create trigger debt_events_protect before update or delete on codebase_debt_candidate_events
  for each row execute function protect_debt_intake_evidence();
