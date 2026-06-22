-- ───────────────────────────────────────────────────────────────────────────
-- Plain-Postgres schema for the Team Brain (DB_BACKEND=postgres).
--
-- Derived from supabase/migrations/* but WITHOUT Supabase couplings:
--   • no Row-Level Security / policies  → access control is enforced in app code
--     (the RLS client and service client are the same connection here)
--   • no `auth.users` / `auth.uid()`    → local `auth_users` + `auth_tokens`
--   • no `private.*` RLS helper fns      → not needed without RLS
--   • no pgvector `embedding` column     → unused by every query; dropped so this
--     runs on a stock Postgres (e.g. Railway) with no extra extensions
--
-- Idempotent: safe to re-run. Load with `npm run pg:schema`.
-- NOTE: every object below is `create … if not exists`, so editing a `create table` body does
-- NOT alter a table that already exists in a deployed DB. To ADD A COLUMN, also add an idempotent
-- `alter table … add column if not exists` to `postgres/migrations/` (pg:schema applies those
-- after this file). See `postgres/migrations/README.md`.
-- ───────────────────────────────────────────────────────────────────────────

create extension if not exists citext;

-- ── enums ────────────────────────────────────────────────────────────────────
do $$ begin
  create type member_role as enum ('admin', 'lead', 'member');
exception when duplicate_object then null; end $$;
do $$ begin
  create type member_status as enum ('invited', 'active', 'disabled');
exception when duplicate_object then null; end $$;
do $$ begin
  create type access_tier as enum ('team', 'external');
exception when duplicate_object then null; end $$;
do $$ begin
  create type item_kind as enum ('deliverable', 'transcript', 'decision', 'task', 'artifact', 'skill', 'blueprint');
exception when duplicate_object then null; end $$;
do $$ begin
  create type task_status as enum ('backlog', 'ready', 'in_progress', 'blocked', 'done');
exception when duplicate_object then null; end $$;
do $$ begin
  create type task_origin as enum ('sync', 'ui');
exception when duplicate_object then null; end $$;
do $$ begin
  create type policy_effect as enum ('allow', 'deny', 'require_approval');
exception when duplicate_object then null; end $$;
do $$ begin
  create type approval_status as enum ('pending', 'approved', 'denied', 'expired');
exception when duplicate_object then null; end $$;
do $$ begin
  create type action_status as enum
    ('requested', 'denied', 'pending_approval', 'running', 'succeeded', 'failed');
exception when duplicate_object then null; end $$;

-- ── auth (local) ─────────────────────────────────────────────────────────────
-- Stand-ins for Supabase Auth. A session is a signed cookie (see lib/auth);
-- magic-link tokens live in auth_tokens (sha256-at-rest, single-use, expiring).
create table if not exists auth_users (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique,
  created_at timestamptz not null default now()
);

create table if not exists auth_tokens (
  token_hash text primary key,             -- sha256(secret)
  email citext not null,
  next_path text not null default '/',
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists auth_tokens_email_idx on auth_tokens (email, created_at desc);

-- ── core tenancy ─────────────────────────────────────────────────────────────
create table if not exists teams (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  name text not null,
  -- The single PM tool the brain projects tasks into (brain-api v1.2). Null until an admin picks
  -- one; projection no-ops (or uses the sole enabled PM integration) when unset.
  primary_pm_provider text check (primary_pm_provider in ('plane', 'linear')),
  created_at timestamptz not null default now()
);
-- Additive column for existing deployments.
alter table teams add column if not exists primary_pm_provider text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'teams_primary_pm_provider_check') then
    alter table teams add constraint teams_primary_pm_provider_check check (primary_pm_provider in ('plane', 'linear'));
  end if;
end $$;

create table if not exists members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  auth_user_id uuid references auth_users(id) on delete set null,
  email citext not null,
  display_name text not null,
  actor_handle text not null,
  role member_role not null default 'member',
  tier access_tier not null default 'team',
  status member_status not null default 'invited',
  created_at timestamptz not null default now(),
  unique (team_id, email),
  unique (team_id, actor_handle)
);
create index if not exists members_auth_user_idx on members (auth_user_id);

-- GitHub profile link (set by the admin GitHub sync; powers avatars + alias derivation).
alter table members add column if not exists github_login text;
alter table members add column if not exists avatar_url text;

-- Git author identities ("aliases") that map to one member: a person's real email,
-- their GitHub noreply forms, etc. team-scoped uniqueness so an alias can never map to
-- two members (which would silently re-fragment attribution). Written by lib/admin +
-- the GitHub sync; read by lib/codebases/ingest to resolve code_contributions.member_id.
create table if not exists member_emails (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  email citext not null,
  created_at timestamptz not null default now(),
  unique (team_id, email)
);
create index if not exists member_emails_member_idx on member_emails (member_id);

create table if not exists api_keys (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  key_id text not null unique,
  key_hash text not null,
  name text not null default '',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create table if not exists audit_log (
  id bigint generated always as identity primary key,
  team_id uuid references teams(id) on delete cascade,
  actor_kind text not null check (actor_kind in ('member', 'api_key', 'system')),
  member_id uuid,
  api_key_id uuid,
  action text not null,
  target_type text,
  target_id text,
  meta jsonb not null default '{}',
  ip inet,
  created_at timestamptz not null default now()
);
create index if not exists audit_log_team_time_idx on audit_log (team_id, created_at desc);

-- Append-only audit log (same guarantee as the Supabase schema).
create or replace function audit_protect()
returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only';
end $$;
drop trigger if exists audit_log_protect on audit_log;
create trigger audit_log_protect
  before update or delete on audit_log
  for each row execute function audit_protect();

create table if not exists rate_limits (
  bucket text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (bucket, window_start)
);

-- Fixed-window rate limiting. Returns the running count for the window so the
-- caller can compare against its per-minute limit. (In Supabase mode this
-- function is absent and rateLimit() fails open; here it actually enforces.)
create or replace function rate_limit_hit(p_bucket text, p_window_start timestamptz)
returns integer language plpgsql as $$
declare c integer;
begin
  insert into rate_limits (bucket, window_start, count)
  values (p_bucket, p_window_start, 1)
  on conflict (bucket, window_start)
  do update set count = rate_limits.count + 1
  returning count into c;
  return c;
end $$;

-- ── content ──────────────────────────────────────────────────────────────────
create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  slug text not null,
  name text not null default '',
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  unique (team_id, slug)
);

create table if not exists items (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  path text not null,
  kind item_kind not null,
  access access_tier not null,
  frontmatter jsonb not null default '{}',
  body text not null default '',
  content_sha256 text not null,
  actor text not null default '',
  member_id uuid references members(id) on delete set null,
  synced_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search tsvector generated always as
    (to_tsvector('english', coalesce(path, '') || ' ' || coalesce(body, ''))) stored,
  unique (team_id, project_id, path)
);
create index if not exists items_team_updated_idx on items (team_id, updated_at desc);
create index if not exists items_search_idx on items using gin (search);
create index if not exists items_kind_idx on items (team_id, kind);

create table if not exists item_versions (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references items(id) on delete cascade,
  content_sha256 text not null,
  frontmatter jsonb not null default '{}',
  body text not null default '',
  member_id uuid references members(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists item_versions_item_idx on item_versions (item_id, created_at desc);

-- ── entities / graph ─────────────────────────────────────────────────────────
create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  source_item_id uuid references items(id) on delete set null,
  row_key text,
  title text not null,
  assignee text not null default '',
  status task_status not null default 'backlog',
  raw_status text,
  sprint text not null default '',
  due_date date,
  origin task_origin not null,
  -- Hierarchy/board fields (brain-api v1.2). The brain is the source of truth that projects a
  -- structured board into the primary PM tool. parent_row_key is the epic's row_key, resolved
  -- within (team_id, project_id); integrity (exists, acyclic) is enforced in app code (lib/ingest
  -- on the sync push), not a DB FK. body is dashboard/DB-only — it never round-trips through the
  -- markdown contract.
  parent_row_key text,
  labels text[] not null default '{}',
  priority text not null default 'none' check (priority in ('none', 'low', 'medium', 'high', 'urgent')),
  body text not null default '',
  created_by uuid references members(id) on delete set null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
-- Additive columns for existing deployments (idempotent rollout via `npm run pg:schema`).
-- Run BEFORE any index that references them so an existing DB (where the column arrives via
-- ALTER, because the table definition above is not re-run for an existing table) can build the index.
alter table tasks add column if not exists parent_row_key text;
alter table tasks add column if not exists labels text[] not null default '{}';
alter table tasks add column if not exists priority text not null default 'none';
alter table tasks add column if not exists body text not null default '';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_priority_check') then
    alter table tasks add constraint tasks_priority_check check (priority in ('none', 'low', 'medium', 'high', 'urgent'));
  end if;
end $$;
create unique index if not exists tasks_row_key_uq on tasks (team_id, project_id, row_key);
create index if not exists tasks_team_status_idx on tasks (team_id, status);
create index if not exists tasks_team_assignee_idx on tasks (team_id, assignee);
create index if not exists tasks_team_updated_idx on tasks (team_id, updated_at desc);
create index if not exists tasks_team_parent_idx on tasks (team_id, project_id, parent_row_key);

-- Links between AIOS task rows and the external PM tool selected by the team.
-- AIOS remains the source of truth for row identity/status; this table records how
-- a row maps onto Plane/Linear and what the last provider sync did.
create table if not exists task_pm_links (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  task_id uuid references tasks(id) on delete set null,
  row_key text not null,
  provider text not null check (provider in ('plane', 'linear')),
  provider_resource_id text,
  provider_external_source text not null default 'aios',
  provider_external_id text not null,
  provider_url text not null default '',
  last_synced_status text,
  last_synced_at timestamptz,
  last_error text,
  -- Projection bookkeeping (brain-api v1.2). last_projected_status + projection_fingerprint let
  -- the projection engine skip a provider write when nothing changed; provider_seen_status records
  -- the last state observed on the provider so Phase 5 (inbound/two-way) can detect divergence.
  last_projected_status text,
  projection_fingerprint text,
  provider_seen_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, project_id, row_key, provider)
);
create index if not exists task_pm_links_task_idx on task_pm_links (task_id);
create index if not exists task_pm_links_team_provider_idx on task_pm_links (team_id, provider);
-- Additive columns for existing deployments.
alter table task_pm_links add column if not exists last_projected_status text;
alter table task_pm_links add column if not exists projection_fingerprint text;
alter table task_pm_links add column if not exists provider_seen_status text;

-- Observable work events from code repos. The initial event is "merged": after a PR
-- lands on main, the matching task row moves to done and provider sync is attempted.
create table if not exists work_events (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  task_id uuid references tasks(id) on delete set null,
  row_key text not null,
  event_kind text not null check (event_kind in ('merged')),
  repo text not null,
  merged_sha text not null,
  pr_url text not null default '',
  pr_title text not null default '',
  pr_body text not null default '',
  actor text not null default '',
  status text not null default 'unresolved' check (status in ('applied', 'unresolved')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, repo, merged_sha, row_key, event_kind)
);
create index if not exists work_events_team_status_idx on work_events (team_id, status, created_at desc);
create index if not exists work_events_task_idx on work_events (task_id);

create table if not exists decisions (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  source_item_id uuid references items(id) on delete set null,
  row_key text not null,
  decided_at date,
  title text not null,
  rationale text not null default '',
  decided_by text not null default '',
  impact text not null default '',
  tier smallint,
  audience access_tier not null default 'team',
  still_valid boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (team_id, project_id, row_key)
);
create index if not exists decisions_team_date_idx on decisions (team_id, decided_at desc);

create table if not exists graph_entities (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  entity_id text not null,
  entity_type text not null check (entity_type in
    ('actor', 'workflow', 'decision', 'commitment', 'value_object')),
  name text not null default '',
  attrs jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  unique (team_id, entity_id)
);
create index if not exists graph_entities_type_idx on graph_entities (team_id, entity_type);
create index if not exists graph_commitment_status_idx on graph_entities ((attrs->>'status'))
  where entity_type = 'commitment';

create table if not exists graph_relationships (
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
create index if not exists graph_rel_from_idx on graph_relationships (team_id, from_id);
create index if not exists graph_rel_to_idx on graph_relationships (team_id, to_id);

create table if not exists query_log (
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
create index if not exists query_log_team_time_idx on query_log (team_id, created_at desc);

-- ── policy engine (Organ 6) ──────────────────────────────────────────────────
create table if not exists policies (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  priority integer not null default 0,
  description text not null default '',
  subject_role member_role,
  subject_tier access_tier,
  subject_actor text,
  action text not null,
  resource text not null default '*',
  effect policy_effect not null,
  enabled boolean not null default true,
  created_by uuid references members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists policies_team_idx on policies (team_id, enabled, priority desc);

create table if not exists approval_requests (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  requested_by_member uuid references members(id) on delete set null,
  requested_by_actor text not null default '',
  action text not null,
  resource text not null,
  context jsonb not null default '{}',
  matched_policy_id uuid references policies(id) on delete set null,
  status approval_status not null default 'pending',
  decided_by uuid references members(id) on delete set null,
  decided_at timestamptz,
  decision_note text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists approval_requests_team_status_idx
  on approval_requests (team_id, status, created_at desc);

-- ── action layer (Organ 4) ───────────────────────────────────────────────────
create table if not exists actions (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  member_id uuid references members(id) on delete set null,
  actor text not null default '',
  action_type text not null,
  resource text not null default '*',
  params jsonb not null default '{}',
  status action_status not null default 'requested',
  decision text,
  matched_policy_id uuid references policies(id) on delete set null,
  approval_request_id uuid references approval_requests(id) on delete set null,
  result jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists actions_team_status_idx on actions (team_id, status, created_at desc);
create index if not exists actions_team_actor_idx on actions (team_id, actor);

-- ── codebases (Organ 8 seam: code health + AI-transformation analytics) ───────
-- Team-tier only (no `access` column → external members see nothing; enforced in
-- app code via lib/metrics/codebases + lib/codebases/visibility — no RLS backstop).
-- Single writer: lib/codebases/ingest (guarded). Scanner posts RAW metrics; scores
-- are computed in the brain at ingest (lib/codebases/score).
create table if not exists codebases (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  slug text not null,
  full_name text not null default '',
  provider text not null default 'github',
  default_branch text not null default 'main',
  description text not null default '',
  homepage text not null default '',
  primary_language text not null default '',
  languages jsonb not null default '{}',
  stars integer not null default 0,
  forks integer not null default 0,
  open_issues integer not null default 0,
  is_archived boolean not null default false,
  last_scan_at timestamptz,
  created_at timestamptz not null default now(),
  unique (team_id, slug)
);
create index if not exists codebases_team_idx on codebases (team_id, slug);

-- One time-series point per scan. Idempotency key (codebase_id, head_sha): the same
-- commit re-scanned upserts (no dup point); a new commit adds a new point.
create table if not exists code_metrics (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  codebase_id uuid not null references codebases(id) on delete cascade,
  head_sha text not null,
  window_days integer not null default 90,
  scanned_at timestamptz not null default now(),
  -- raw measures (pushed by the scanner)
  loc integer not null default 0,
  files integer not null default 0,
  commits_window integer not null default 0,
  ai_commits_window integer not null default 0,
  additions_window integer not null default 0,
  deletions_window integer not null default 0,
  test_coverage_pct numeric(5,2),                 -- null = no coverage report found
  recent_commits jsonb not null default '[]',     -- [{sha,author,ai,additions,deletions,committed_at,message}]
  -- explicit scaffolding inputs (named, not vague JSON → testable scoring)
  has_claude_md boolean not null default false,
  has_agents_md boolean not null default false,
  agents_md_count integer not null default 0,
  skills_count integer not null default 0,
  commands_count integer not null default 0,
  -- brain-computed scores (lib/codebases/score)
  agentic_score numeric(5,2) not null default 0,
  health_score numeric(5,2) not null default 0,
  ai_commit_ratio numeric(5,2) not null default 0,
  test_coverage_score numeric(5,2) not null default 0,
  scaffolding_score numeric(5,2) not null default 0,
  skill_breadth_score numeric(5,2) not null default 0,
  cadence_score numeric(5,2) not null default 0,
  issue_health numeric(5,2) not null default 0,
  -- AEM agent-readiness (rubric-scored scanner-side; the brain only persists the result.
  -- canonical rubric: agentic-engineering-maturity/rubric/agent-readiness.json)
  readiness_level text,                            -- L0..L5, null = not scored
  readiness_pct numeric(5,2),                      -- % of all rubric checks passed
  readiness_pillars jsonb not null default '{}',   -- { pillarKey: {passed,total} }
  readiness_rubric_version text,                   -- which rubric version produced the score
  created_at timestamptz not null default now(),
  unique (codebase_id, head_sha)
);
create index if not exists code_metrics_codebase_time_idx on code_metrics (codebase_id, scanned_at desc);
create index if not exists code_metrics_team_time_idx on code_metrics (team_id, scanned_at desc);
-- AEM agent-readiness columns — added via alter so an already-deployed code_metrics
-- (where the table-creation above is a no-op) still gains them on `pg:schema`.
alter table code_metrics add column if not exists readiness_level text;
alter table code_metrics add column if not exists readiness_pct numeric(5,2);
alter table code_metrics add column if not exists readiness_pillars jsonb not null default '{}';
alter table code_metrics add column if not exists readiness_rubric_version text;

-- Keep `npm run pg:schema` safe for existing deployments that created
-- code_metrics before AEM readiness fields were added. The table declaration
-- alone does not backfill new columns.
alter table code_metrics add column if not exists readiness_level text;
alter table code_metrics add column if not exists readiness_pct numeric(5,2);
alter table code_metrics add column if not exists readiness_pillars jsonb not null default '{}';
alter table code_metrics add column if not exists readiness_rubric_version text;

-- Daily contribution aggregates, recomputed + upserted each scan over the window.
-- author_key is stable (normalized email, or name when email absent); git history
-- rarely carries a GitHub login. member_id maps to the roster when resolvable.
create table if not exists code_contributions (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  codebase_id uuid not null references codebases(id) on delete cascade,
  author_key text not null,
  author_name text not null default '',
  author_email text not null default '',
  member_id uuid references members(id) on delete set null,
  day date not null,
  commits integer not null default 0,
  ai_commits integer not null default 0,
  additions integer not null default 0,
  deletions integer not null default 0,
  created_at timestamptz not null default now(),
  unique (codebase_id, author_key, day)
);
create index if not exists code_contributions_codebase_idx on code_contributions (codebase_id, day desc);
create index if not exists code_contributions_member_idx on code_contributions (member_id);

create table if not exists github_issues (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  codebase_id uuid not null references codebases(id) on delete cascade,
  number integer not null,
  title text not null default '',
  state text not null default 'open',             -- open | closed
  is_pull_request boolean not null default false,
  author_login text not null default '',
  assignee_login text not null default '',
  labels jsonb not null default '[]',
  comments integer not null default 0,
  url text not null default '',
  opened_at timestamptz,
  closed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (codebase_id, number)
);
create index if not exists github_issues_codebase_state_idx
  on github_issues (codebase_id, state, updated_at desc);

-- Agentic-maturity snapshots (AEM individual scope). One row per member per day,
-- pushed by `aios analyze --push` from a member's LOCAL session logs (Claude/Codex/
-- Cursor). Raw session content never leaves the machine — only the ratios + counts
-- (the `signals`) and the scores below cross the boundary. The client sends its
-- `provisional` placement; the brain RECOMPUTES the `canonical` axis/Spine scores
-- from the signals (lib/metrics/individual-maturity) so team rollups have one authority.
-- Team-tier only; POSTGRES-ONLY — no RLS backstop, app code is the tier gate.
create table if not exists agentic_maturity_snapshots (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  snapshot_date date not null,
  metric text not null default 'aem-individual',
  window_days integer not null default 1,
  -- raw signals (the entire privacy surface: ratios + counts, never content)
  delegation_ratio numeric(6,4) not null default 0,
  correction_loop_avg numeric(8,2) not null default 0,
  error_rate numeric(6,4) not null default 0,
  cost_per_task numeric(10,4) not null default 0,
  tokens_per_task numeric(12,2) not null default 0,
  cache_hit_rate numeric(6,4) not null default 0,
  tool_diversity numeric(8,2) not null default 0,
  verify_tool_rate numeric(6,4) not null default 0,
  subagent_usage numeric(6,4) not null default 0,
  total_cost_usd numeric(12, 5) not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  sessions integer not null default 0,
  tasks integer not null default 0,
  -- client-side provisional placement (provenance; axes 0–4, spine L1–L5)
  provisional_spine text not null default 'L1',
  provisional_axes jsonb not null default '{}',
  -- brain-recomputed canonical placement (the authority for rollups)
  canonical_spine text not null default 'L1',
  canonical_verification numeric(4,2) not null default 0,
  canonical_context_hygiene numeric(4,2) not null default 0,
  canonical_autonomy numeric(4,2) not null default 0,
  canonical_learning numeric(4,2) not null default 0,
  canonical_cost_governance numeric(4,2) not null default 0,
  canonical_overall numeric(4,2) not null default 0,
  created_at timestamptz not null default now(),
  unique (team_id, member_id, snapshot_date, metric)
);
create index if not exists aem_snapshots_member_time_idx
  on agentic_maturity_snapshots (member_id, snapshot_date desc);
create index if not exists aem_snapshots_team_time_idx
  on agentic_maturity_snapshots (team_id, snapshot_date desc);

-- External AI provider spend (W2.1). Pushed by `aios analyze --push` from member workstations.
-- Cursor dashboard API (authoritative USD) + Claude session-log estimates. Team-tier only.
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

-- Integration selections. `config` holds NON-SECRET selection only (repos, channels, project
-- slugs); the per-type allowlist + secret-key rejection (lib/api/schemas) keep secrets OUT of
-- config. The connector secret (Slack/GitHub/… token) lives ENCRYPTED in `secret_ciphertext`
-- (AES-256-GCM via lib/secrets) so admins set it self-serve in the dashboard; plaintext is only
-- produced on the connector-key read path (GET /api/v1/integrations, audited). POSTGRES-ONLY:
-- no RLS — tier/role isolation is in app code. Single writer: lib/integrations/manage.ts (sets
-- updated_at explicitly; no trigger).
create table if not exists integrations (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  type text not null check (type in ('github','granola','slack','wise','linear','plane')),
  name text not null,
  config jsonb not null default '{}',
  secret_ciphertext text,                 -- AES-256-GCM blob (base64); null if no secret set
  status text not null default 'enabled' check (status in ('enabled','disabled')),
  created_by uuid references members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, type, name)
);
create index if not exists integrations_team_type_idx on integrations (team_id, type);
-- Additive column for existing deployments (idempotent rollout via `npm run pg:schema`).
alter table integrations add column if not exists secret_ciphertext text;
