-- W2.1 — external AI provider spend (Cursor dashboard, Claude session estimates).
-- Team-tier only; pushed by `aios analyze --push` from member workstations.
create table if not exists usage_costs (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  cost_date date not null,
  provider text not null,
  source text not null default 'unknown',
  project text not null default '',
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  cost_usd numeric(12, 5) not null default 0,
  events integer not null default 0,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, member_id, cost_date, provider, source, project)
);

create index if not exists usage_costs_team_date_idx
  on usage_costs (team_id, cost_date desc);

create index if not exists usage_costs_member_date_idx
  on usage_costs (member_id, cost_date desc);
