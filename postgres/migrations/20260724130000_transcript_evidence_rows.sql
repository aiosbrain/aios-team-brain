-- Brain API 1.12: approved, row-level transcript evidence projections.
-- Idempotent for both fresh and populated databases.

alter type item_kind add value if not exists 'fact';
alter type item_kind add value if not exists 'stakeholder_mention';

create table if not exists extracted_facts (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  source_item_id uuid not null references items(id) on delete cascade,
  row_key text not null,
  title text not null,
  occurred_at timestamptz,
  fact_type text not null check (fact_type in ('fact', 'event')),
  source_path text not null,
  source_quote text not null,
  audience access_tier not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, project_id, row_key)
);
create index if not exists extracted_facts_team_project_idx
  on extracted_facts (team_id, project_id);
create index if not exists extracted_facts_source_item_idx
  on extracted_facts (source_item_id);
create index if not exists extracted_facts_audience_idx
  on extracted_facts (team_id, audience);
create index if not exists extracted_facts_occurred_at_idx
  on extracted_facts (team_id, occurred_at desc);

create table if not exists stakeholder_mentions (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  source_item_id uuid not null references items(id) on delete cascade,
  row_key text not null,
  name text not null,
  role text,
  context text,
  source_path text not null,
  source_quote text not null,
  audience access_tier not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, project_id, row_key)
);
create index if not exists stakeholder_mentions_team_project_idx
  on stakeholder_mentions (team_id, project_id);
create index if not exists stakeholder_mentions_source_item_idx
  on stakeholder_mentions (source_item_id);
create index if not exists stakeholder_mentions_audience_idx
  on stakeholder_mentions (team_id, audience);
create index if not exists stakeholder_mentions_name_idx
  on stakeholder_mentions (team_id, lower(name));
