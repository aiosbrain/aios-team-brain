-- 0003 entities: tasks, decisions, company-graph entities/relationships, query_log
-- tasks/decisions materialize from synced markdown table rows (lib/ingest);
-- graph tables follow Company Graph v2 (actors, workflows, decisions,
-- commitments, value objects + 12 relationship types).

create type task_status as enum ('backlog', 'ready', 'in_progress', 'blocked', 'done');
create type task_origin as enum ('sync', 'ui');

create table tasks (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  source_item_id uuid references items(id) on delete set null,
  row_key text,                         -- "T-01"; null until assigned for UI rows
  title text not null,
  assignee text not null default '',
  status task_status not null default 'backlog',
  raw_status text,                      -- preserved when normalization changed it
  sprint text not null default '',
  due_date date,
  origin task_origin not null,
  created_by uuid references members(id) on delete set null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
-- Full (non-partial) unique index: PostgREST upserts need it as a conflict
-- arbiter, and Postgres treats NULL row_keys as distinct so UI-created tasks
-- (row_key null) are unaffected.
create unique index tasks_row_key_uq on tasks (team_id, project_id, row_key);
create index tasks_team_status_idx on tasks (team_id, status);
create index tasks_team_assignee_idx on tasks (team_id, assignee);
create index tasks_team_updated_idx on tasks (team_id, updated_at desc);

create table decisions (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  source_item_id uuid references items(id) on delete set null,
  row_key text not null,                -- the "#" column
  decided_at date,
  title text not null,
  rationale text not null default '',
  decided_by text not null default '',
  impact text not null default '',
  tier smallint,                        -- the "Type" column (1/2/3 reversibility)
  audience access_tier not null default 'team',
  still_valid boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (team_id, project_id, row_key)
);
create index decisions_team_date_idx on decisions (team_id, decided_at desc);

create table graph_entities (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  entity_id text not null,              -- "actor-001", "wf-003", …
  entity_type text not null check (entity_type in
    ('actor', 'workflow', 'decision', 'commitment', 'value_object')),
  name text not null default '',
  attrs jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  unique (team_id, entity_id)
);
create index graph_entities_type_idx on graph_entities (team_id, entity_type);
-- commitments-at-risk widget reads attrs->>'status' on commitments
create index graph_commitment_status_idx on graph_entities ((attrs->>'status'))
  where entity_type = 'commitment';

create table graph_relationships (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  from_id text not null,
  to_id text not null,
  relationship_type text not null check (relationship_type in
    ('OWNS', 'DECIDED', 'AFFECTS', 'COMMITTED_TO', 'PRODUCES', 'TOUCHES',
     'REPORTS_TO', 'BLOCKS', 'DEPENDS_ON', 'SUPERSEDES', 'CREATED_BY',
     'PARTICIPATED_IN')),
  attrs jsonb not null default '{}',
  unique (team_id, from_id, to_id, relationship_type)
);
create index graph_rel_from_idx on graph_relationships (team_id, from_id);
create index graph_rel_to_idx on graph_relationships (team_id, to_id);

create table query_log (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  member_id uuid references members(id) on delete set null,
  question text not null,
  answer_preview text not null default '',
  cited_item_ids uuid[] not null default '{}',
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cost_usd numeric(10, 5) not null default 0,
  latency_ms integer not null default 0,
  created_at timestamptz not null default now()
);
create index query_log_team_time_idx on query_log (team_id, created_at desc);

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table tasks enable row level security;
alter table decisions enable row level security;
alter table graph_entities enable row level security;
alter table graph_relationships enable row level security;
alter table query_log enable row level security;

-- tasks: team members read; members create/move tasks in the UI; leads/admins
-- may delete UI-created rows (sync rows are managed by the ingest path).
create policy tasks_select on tasks for select
  to authenticated
  using (team_id in (select private.my_team_ids()));

create policy tasks_member_insert on tasks for insert
  to authenticated
  with check (
    team_id in (select private.my_team_ids())
    and origin = 'ui'
    and created_by = private.my_member_id(team_id)
  );

create policy tasks_member_update on tasks for update
  to authenticated
  using (team_id in (select private.my_team_ids()))
  with check (team_id in (select private.my_team_ids()));

create policy tasks_lead_delete on tasks for delete
  to authenticated
  using (
    team_id in (select private.my_team_ids())
    and origin = 'ui'
    and private.my_role(team_id) in ('lead', 'admin')
  );

-- decisions: team members read; leads/admins may toggle validity.
create policy decisions_select on decisions for select
  to authenticated
  using (
    team_id in (select private.my_team_ids())
    and (private.my_tier(team_id) = 'team' or audience = 'external')
  );

create policy decisions_lead_update on decisions for update
  to authenticated
  using (team_id in (select private.my_team_ids())
         and private.my_role(team_id) in ('lead', 'admin'))
  with check (team_id in (select private.my_team_ids())
              and private.my_role(team_id) in ('lead', 'admin'));

-- graph: team members read; writes via seed/ingest (service role) only.
create policy graph_entities_select on graph_entities for select
  to authenticated
  using (team_id in (select private.my_team_ids()));

create policy graph_relationships_select on graph_relationships for select
  to authenticated
  using (team_id in (select private.my_team_ids()));

-- query_log: members see their own queries; admins see the team's.
create policy query_log_select on query_log for select
  to authenticated
  using (
    team_id in (select private.my_team_ids())
    and (member_id = private.my_member_id(team_id)
         or private.my_role(team_id) = 'admin')
  );
