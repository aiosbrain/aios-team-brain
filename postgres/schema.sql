-- ───────────────────────────────────────────────────────────────────────────
-- Plain-Postgres schema for the Team Brain.
--
-- Canonical schema — self-contained, with no Supabase couplings:
--   • no Row-Level Security / policies  → access control is enforced in app code
--     (there is a single connection; no separate RLS client)
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
do $$ begin
  create type social_job_status as enum ('queued', 'running', 'done', 'dead');
exception when duplicate_object then null; end $$;
do $$ begin
  create type opportunity_status as enum ('discovered', 'evaluated', 'planned', 'rejected', 'expired');
exception when duplicate_object then null; end $$;
do $$ begin
  create type content_status as enum (
    'planned', 'generating', 'generated', 'validating', 'awaiting_approval', 'approved',
    'scheduled', 'publishing', 'published', 'analyzing', 'completed',
    'rejected', 'failed', 'cancelled', 'expired'
  );
exception when duplicate_object then null; end $$;

-- ── auth (local) ─────────────────────────────────────────────────────────────
-- Local auth tables (a session is a signed cookie; see lib/auth). Magic-link
-- tokens live in auth_tokens (sha256-at-rest, single-use, expiring).
create table if not exists auth_users (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique,
  -- Email+password auth (audit M1/M2b): admin sets the initial password, the member logs in with
  -- it and can change it anytime. NULL = no password set yet (login rejected, not allowed through).
  password_hash text,
  created_at timestamptz not null default now()
);
alter table auth_users add column if not exists password_hash text;

create table if not exists auth_tokens (
  token_hash text primary key,             -- sha256(secret)
  email citext not null,
  next_path text not null default '/',
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists auth_tokens_email_idx on auth_tokens (email, created_at desc);

-- Single-use OAuth state nonces (one-click Slack connect): minted at /api/auth/slack/start,
-- atomically consumed at /api/auth/slack/callback. Short-lived (10-min TTL); the signed state
-- JWT carries the same nonce so a leaked/forged state can't be replayed. Same single-use family
-- as auth_tokens — no FK by design (mirrors auth_tokens; rows are ephemeral, cleared per-test via
-- DATA_TABLES and opportunistically at /start).
create table if not exists oauth_states (
  nonce uuid primary key default gen_random_uuid(),
  team_id uuid not null,
  member_id uuid not null,
  provider text not null default 'slack',
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists oauth_states_expires_idx on oauth_states (expires_at);

-- ── core tenancy ─────────────────────────────────────────────────────────────
create table if not exists teams (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  name text not null,
  -- The single PM tool the brain projects tasks into (brain-api v1.2). Null until an admin picks
  -- one; projection no-ops (or uses the sole enabled PM integration) when unset.
  primary_pm_provider text check (primary_pm_provider in ('plane', 'linear')),
  -- Explicit answering-backend override for the Query box. Null = auto precedence
  -- (OpenRouter → LLM_BASE_URL → Anthropic); otherwise force that backend (lib/query/llm-backend).
  answering_provider text check (answering_provider in ('anthropic', 'openai', 'openrouter', 'local')),
  created_at timestamptz not null default now()
);
-- Additive columns for existing deployments.
alter table teams add column if not exists primary_pm_provider text;
alter table teams add column if not exists answering_provider text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'teams_primary_pm_provider_check') then
    alter table teams add constraint teams_primary_pm_provider_check check (primary_pm_provider in ('plane', 'linear'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'teams_answering_provider_check') then
    alter table teams add constraint teams_answering_provider_check check (answering_provider in ('anthropic', 'openai', 'openrouter', 'local'));
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
  -- true for the auto-provisioned per-source ingest actor (lib/ingest/run.ts's
  -- resolveConnectorAuth), never for a real human — excluded from Admin -> Members and
  -- /api/v1/members so a connector never renders indistinguishable from a person.
  is_connector boolean not null default false,
  -- Org-chart source: who this member reports to (nullable self-FK). Synced into the company
  -- graph (lib/graph/company-actors.ts) as a REPORTS_TO edge + attrs.reports_to.
  manager_member_id uuid references members(id) on delete set null,
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

-- Cross-provider identities that map to one member, keyed by the PROVIDER'S stable user id
-- (Slack `Uxxx`, Linear/Plane user id, GitHub login, …) — the general form of member_emails
-- (which stays the email-keyed git-alias store). This is how a person's Slack/Linear/… author
-- is reconciled to the roster so "who is doing what" joins across tools. team-scoped unique
-- (provider, external_id) so one provider identity maps to at most one member. `email` is an
-- optional secondary match the resolver folds into its byEmail map. Read by lib/identity/resolve.
create table if not exists member_identities (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  provider text not null,
  external_id text not null,
  handle text not null default '',
  email citext not null default '',
  created_at timestamptz not null default now(),
  unique (team_id, provider, external_id)
);
create index if not exists member_identities_member_idx on member_identities (member_id);

-- Per-member encrypted secrets (e.g. a member's own Slack USER token for "act as me").
-- DISTINCT from team `integrations.secret_ciphertext` (team-scoped, bot/read): this is
-- per-member + write-capable, written only by lib/member-secrets/manage.ts (audited
-- single writer) and read only by the owner via GET /api/v1/me/<provider>-token.
-- `secret_ciphertext` is the AES-256-GCM blob (lib/secrets/crypto.ts); `meta` holds
-- NON-secret context (slack_user_id, workspace, scopes, acquired_via). The secret value
-- is never stored or logged in plaintext.
create table if not exists member_secrets (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  provider text not null,                  -- 'slack'
  secret_ciphertext text not null,         -- AES-256-GCM blob (base64), encryptSecret()
  meta jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, member_id, provider)
);
create index if not exists member_secrets_member_idx on member_secrets (member_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Identity CONTEXT layer — per-member curated context on top of the lean roster.
-- These are MANUAL fields (a self-service profile + admin edit), distinct from the
-- machine-reconciled identity tables above (member_emails / member_identities which
-- map authors→member). Written ONLY by `lib/identity/profile.ts` (the audited single
-- writer, guarded by test/guards/single-writer-profile.test.ts); read by getMemberContext.
-- ─────────────────────────────────────────────────────────────────────────────

-- One row per member (member_id is the PK → 1:1, upsert-on-member_id): scheduling +
-- contact preferences + free-form bio. `working_hours` is a per-weekday map
-- { mon: ["09:00","17:00"], ... }; `preferred_channels` is an ORDERED contact preference list.
create table if not exists member_profiles (
  member_id uuid primary key references members(id) on delete cascade,
  team_id uuid not null references teams(id) on delete cascade,
  timezone text not null default '',
  working_hours jsonb not null default '{}'::jsonb,
  preferred_channels text[] not null default '{}',
  location text not null default '',
  bio text not null default '',
  -- Self-uploaded profile picture, stored as a data: URL (no object storage in this codebase —
  -- self-host-portable, no extra infra). Resized/compressed client-side before upload; NULL = no
  -- manual upload, fall back to members.avatar_url (GitHub) then initials. Written only by
  -- lib/identity/profile.ts (same single-writer guard as the rest of this table).
  avatar_data_url text,
  updated_at timestamptz not null default now(),
  updated_by uuid references members(id) on delete set null
);
create index if not exists member_profiles_team_idx on member_profiles (team_id);
-- Additive column for existing deployments (idempotent rollout via `npm run pg:schema`).
alter table member_profiles add column if not exists avatar_data_url text;

-- Time-off date ranges (PTO / holiday / sick / other). Many rows per member.
create table if not exists member_time_off (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  starts_on date not null,
  ends_on date not null,
  kind text not null default 'pto',
  note text not null default '',
  created_at timestamptz not null default now(),
  check (ends_on >= starts_on)
);
create index if not exists member_time_off_member_idx on member_time_off (member_id);

-- OKRs / goals. `source` is tagged so a future JIRA/Plane-initiative importer backfills the
-- SAME table with no schema change; the partial unique index dedups only imported rows
-- (source <> 'manual' with a non-empty external_id) so manual goals are never blocked by it.
create table if not exists member_goals (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  kind text not null default 'goal',
  title text not null,
  detail text not null default '',
  status text not null default 'on_track',
  target_date date,
  source text not null default 'manual',
  external_id text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists member_goals_member_idx on member_goals (member_id);
create unique index if not exists member_goals_source_ext_unq
  on member_goals (team_id, source, external_id)
  where source <> 'manual' and external_id <> '';

-- Member provisioning: the tool-invite cascade. One row per (member, tool) recording whether a
-- member was invited into Linear / Slack / GitHub during onboarding. SINGLE WRITER:
-- lib/provisioning/run.ts (runProvisioning) — no other module writes this table. `status` is the
-- outcome: sent (the provider emailed an invite), link_provided (a standing join link was surfaced,
-- acceptance not verified), skipped (not configured / already a member), failed (the provider call
-- errored). `detail` is a human-readable note; `meta` holds NON-secret context only (e.g. a slack
-- inviteLink). Team-tier (admin area) — no per-row tier column, no RLS backstop.
create table if not exists member_provisioning (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  tool text not null check (tool in ('linear','slack','github')),
  status text not null check (status in ('sent','link_provided','skipped','failed')),
  detail text not null default '',
  meta jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, member_id, tool)
);
create index if not exists member_provisioning_member_idx on member_provisioning (member_id);

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

-- Append-only audit log.
create or replace function audit_protect()
returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only';
end $$;
drop trigger if exists audit_log_protect on audit_log;
create trigger audit_log_protect
  before update or delete on audit_log
  for each row execute function audit_protect();

-- ── managed execution gateway (brain-api v1.10; disabled until later slices) ─
-- These tables are server-only. There is no RLS backstop: every application lookup
-- must bind team + member + Executor subject through lib/gateway/persistence.ts.
-- Gateway audit and execution history are compliance records. Their team/member FKs
-- intentionally RESTRICT deletion; operators revoke operational rows instead.
create unique index if not exists members_team_id_id_unq on members (team_id, id);

create table if not exists gateway_service_identities (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete restrict,
  environment text not null check (environment <> ''),
  credential_id text not null unique check (credential_id ~ '^[A-Za-z0-9_-]{22}$'),
  credential_hash text not null check (credential_hash ~ '^[0-9a-f]{64}$'),
  credential_version integer not null default 1 check (credential_version > 0),
  rotated_from_id uuid references gateway_service_identities(id) on delete restrict,
  activated_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_authenticated_at timestamptz,
  created_at timestamptz not null default now(),
  unique (team_id, id),
  check (expires_at is null or expires_at > activated_at),
  check (revoked_at is null or revoked_at >= activated_at)
);
create index if not exists gateway_service_identities_team_env_idx
  on gateway_service_identities (team_id, environment);

do $$
declare legacy record;
begin
  for legacy in
    select credential_id,credential_hash,credential_version
      from gateway_service_identities
  loop
    begin
      if legacy.credential_id !~ '^[A-Za-z0-9_-]{22}$'
        or legacy.credential_hash !~ '^[0-9a-f]{64}$'
        or legacy.credential_version <= 0
        or octet_length(decode(translate(legacy.credential_id,'-_','+/') || '==','base64')) <> 16
        or translate(rtrim(encode(
             decode(translate(legacy.credential_id,'-_','+/') || '==','base64'),
             'base64'
           ),'='),'+/','-_') <> legacy.credential_id then
        raise exception 'gateway_service_identity_legacy_preflight';
      end if;
    exception when others then
      raise exception 'gateway_service_identity_legacy_preflight';
    end;
  end loop;
end $$;

create table if not exists gateway_service_credentials (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null,
  service_identity_id uuid not null,
  credential_id text not null unique check (credential_id ~ '^[A-Za-z0-9_-]{22}$'),
  version integer not null check (version > 0),
  secret_hash text not null check (secret_hash ~ '^[0-9a-f]{64}$'),
  replaces_credential_id text,
  activated_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_authenticated_at timestamptz,
  created_by_member_id uuid,
  created_at timestamptz not null default now(),
  unique (team_id, id),
  unique (service_identity_id, version),
  foreign key (team_id, service_identity_id)
    references gateway_service_identities(team_id, id) on delete restrict,
  foreign key (team_id, created_by_member_id)
    references members(team_id, id) on delete restrict,
  check (expires_at is null or expires_at > activated_at),
  check (revoked_at is null or revoked_at >= activated_at)
);
create index if not exists gateway_service_credentials_identity_idx
  on gateway_service_credentials (team_id, service_identity_id, created_at desc);

create table if not exists executor_subject_bindings (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null,
  member_id uuid not null,
  service_identity_id uuid not null,
  executor_tenant_id text not null check (executor_tenant_id <> ''),
  executor_subject_id text not null check (executor_subject_id <> ''),
  bound_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (team_id, id),
  unique (team_id, member_id, id),
  unique (team_id, member_id, service_identity_id, id),
  unique (service_identity_id, executor_tenant_id, executor_subject_id),
  foreign key (team_id, member_id) references members(team_id, id) on delete restrict,
  foreign key (team_id, service_identity_id)
    references gateway_service_identities(team_id, id) on delete restrict,
  check (expires_at is null or expires_at > bound_at),
  check (revoked_at is null or revoked_at >= bound_at)
);
create unique index if not exists executor_subject_bindings_active_member_unq
  on executor_subject_bindings (team_id, member_id, service_identity_id)
  where revoked_at is null;

create table if not exists gateway_connections (
  id uuid primary key default gen_random_uuid(),
  connection_ref text not null unique check (connection_ref <> ''),
  team_id uuid not null,
  member_id uuid not null,
  service_identity_id uuid not null,
  subject_binding_id uuid not null,
  provider text not null default 'github' check (provider = 'github'),
  credential_ciphertext text not null check (credential_ciphertext <> ''),
  enabled boolean not null default true,
  credential_expires_at timestamptz,
  validated_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, id),
  unique (team_id, member_id, id),
  unique (team_id, member_id, service_identity_id, id),
  foreign key (team_id, member_id) references members(team_id, id) on delete restrict,
  foreign key (team_id, service_identity_id)
    references gateway_service_identities(team_id, id) on delete restrict,
  foreign key (team_id, member_id, service_identity_id, subject_binding_id)
    references executor_subject_bindings(team_id, member_id, service_identity_id, id) on delete restrict,
  check ((enabled and revoked_at is null) or (not enabled))
);
create unique index if not exists gateway_connections_active_member_unq
  on gateway_connections (team_id, member_id)
  where enabled and revoked_at is null;

create table if not exists gateway_resolution_leases (
  id uuid primary key default gen_random_uuid(),
  lease_hash text not null unique check (lease_hash ~ '^[0-9a-f]{64}$'),
  nonce uuid not null default gen_random_uuid(),
  audience text not null check (audience <> ''),
  team_id uuid not null,
  member_id uuid not null,
  service_identity_id uuid not null,
  subject_binding_id uuid not null,
  connection_id uuid not null,
  policy_version text not null check (policy_version ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  unique (team_id, id),
  unique (team_id, member_id, service_identity_id, subject_binding_id, connection_id, id),
  foreign key (team_id, member_id) references members(team_id, id) on delete restrict,
  foreign key (team_id, service_identity_id)
    references gateway_service_identities(team_id, id) on delete restrict,
  foreign key (team_id, member_id, service_identity_id, subject_binding_id)
    references executor_subject_bindings(team_id, member_id, service_identity_id, id) on delete restrict,
  foreign key (team_id, member_id, service_identity_id, connection_id)
    references gateway_connections(team_id, member_id, service_identity_id, id) on delete restrict,
  check (expires_at > created_at and expires_at <= created_at + interval '30 seconds'),
  check (consumed_at is null or consumed_at >= created_at),
  check (revoked_at is null or revoked_at >= created_at)
);
create index if not exists gateway_resolution_leases_scope_idx
  on gateway_resolution_leases (team_id, member_id, subject_binding_id, connection_id);

create table if not exists gateway_executions (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null,
  member_id uuid not null,
  service_identity_id uuid not null,
  subject_binding_id uuid not null,
  connection_id uuid not null,
  lease_id uuid not null unique,
  correlation_id uuid not null,
  idempotency_key text not null check (idempotency_key <> ''),
  toolkit text not null check (toolkit <> ''),
  tool text not null check (tool <> ''),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  encrypted_request_envelope bytea not null
    check (octet_length(encrypted_request_envelope) between 1 and 65536),
  actor_snapshot text not null,
  role_snapshot text not null check (role_snapshot in ('admin', 'lead', 'member')),
  tier_snapshot text not null check (tier_snapshot in ('team', 'external')),
  policy_resource text not null,
  request_envelope_hash text not null check (request_envelope_hash ~ '^[0-9a-f]{64}$'),
  resume_fingerprint text check (resume_fingerprint is null or resume_fingerprint ~ '^[0-9a-f]{64}$'),
  claim_idempotency_key text,
  claimed_credential_id uuid,
  decision text not null check (decision in ('block', 'require_approval', 'allow')),
  state text not null check (state in
    ('blocked', 'approval_required', 'approved', 'claimed', 'succeeded', 'failed', 'cancelled', 'expired')),
  policy_version text,
  policy_rule_id text,
  claimed_at timestamptz,
  claimed_by_correlation_id uuid,
  outcome_classification text check (outcome_classification in
    ('success', 'blocked', 'approval_required', 'credential', 'network', 'upstream',
     'response_too_large', 'internal')),
  upstream_status_class text check (upstream_status_class in ('2xx', '3xx', '4xx', '5xx')),
  response_bytes bigint check (response_bytes is null or response_bytes >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (service_identity_id, idempotency_key),
  unique (team_id, id),
  unique (team_id, member_id, id),
  foreign key (team_id, member_id) references members(team_id, id) on delete restrict,
  foreign key (team_id, service_identity_id)
    references gateway_service_identities(team_id, id) on delete restrict,
  foreign key (team_id, member_id, subject_binding_id)
    references executor_subject_bindings(team_id, member_id, id) on delete restrict,
  foreign key (team_id, member_id, connection_id)
    references gateway_connections(team_id, member_id, id) on delete restrict,
  foreign key (team_id, member_id, service_identity_id, subject_binding_id, connection_id, lease_id)
    references gateway_resolution_leases(team_id, member_id, service_identity_id, subject_binding_id, connection_id, id)
    on delete restrict
);
create index if not exists gateway_executions_scope_idx
  on gateway_executions (team_id, member_id, subject_binding_id, created_at desc);

-- Additive replay path for deployments whose gateway_executions table predates AIO-407.
alter table gateway_executions add column if not exists actor_snapshot text;
alter table gateway_executions add column if not exists role_snapshot text;
alter table gateway_executions add column if not exists tier_snapshot text;
alter table gateway_executions add column if not exists policy_resource text;
alter table gateway_executions add column if not exists request_envelope_hash text;
alter table gateway_executions add column if not exists resume_fingerprint text;
alter table gateway_executions add column if not exists claim_idempotency_key text;
alter table gateway_executions add column if not exists claimed_credential_id uuid;
update gateway_executions e
   set actor_snapshot=coalesce(e.actor_snapshot,m.actor_handle),
       role_snapshot=coalesce(e.role_snapshot,m.role::text),
       tier_snapshot=coalesce(e.tier_snapshot,m.tier::text),
       policy_resource=coalesce(e.policy_resource,'github.repository:*'),
       request_envelope_hash=coalesce(e.request_envelope_hash,
         encode(sha256(e.encrypted_request_envelope),'hex'))
  from members m where m.id=e.member_id and m.team_id=e.team_id
    and (e.actor_snapshot is null or e.role_snapshot is null or e.tier_snapshot is null
      or e.policy_resource is null or e.request_envelope_hash is null);
alter table gateway_executions alter column actor_snapshot set not null;
alter table gateway_executions alter column role_snapshot set not null;
alter table gateway_executions alter column tier_snapshot set not null;
alter table gateway_executions alter column policy_resource set not null;
alter table gateway_executions alter column request_envelope_hash set not null;
alter table gateway_executions drop constraint if exists gateway_executions_role_snapshot_check;
alter table gateway_executions add constraint gateway_executions_role_snapshot_check
  check (role_snapshot in ('admin','lead','member'));
alter table gateway_executions drop constraint if exists gateway_executions_tier_snapshot_check;
alter table gateway_executions add constraint gateway_executions_tier_snapshot_check
  check (tier_snapshot in ('team','external'));
alter table gateway_executions drop constraint if exists gateway_executions_request_envelope_hash_check;
alter table gateway_executions add constraint gateway_executions_request_envelope_hash_check
  check (request_envelope_hash ~ '^[0-9a-f]{64}$');
alter table gateway_executions drop constraint if exists gateway_executions_resume_fingerprint_check;
alter table gateway_executions add constraint gateway_executions_resume_fingerprint_check
  check (resume_fingerprint is null or resume_fingerprint ~ '^[0-9a-f]{64}$');
alter table gateway_executions drop constraint if exists gateway_executions_claimed_credential_fk;
alter table gateway_executions add constraint gateway_executions_claimed_credential_fk
  foreign key (team_id,claimed_credential_id)
  references gateway_service_credentials(team_id,id) on delete restrict;

create table if not exists gateway_approvals (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null,
  execution_id uuid not null unique,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'denied', 'expired', 'cancelled')),
  expires_at timestamptz not null,
  approver_member_id uuid,
  decided_at timestamptz,
  decision_correlation_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, id),
  foreign key (team_id, execution_id) references gateway_executions(team_id, id) on delete restrict,
  foreign key (team_id, approver_member_id) references members(team_id, id) on delete restrict,
  check (expires_at > created_at and expires_at <= created_at + interval '15 minutes'),
  check ((status = 'pending' and decided_at is null and approver_member_id is null)
      or (status <> 'pending' and decided_at is not null))
);
alter table gateway_approvals add column if not exists decision_correlation_id uuid;

create table if not exists gateway_audit_log (
  id bigint generated always as identity primary key,
  team_id uuid not null references teams(id) on delete restrict,
  member_id uuid,
  service_identity_id uuid,
  subject_binding_id uuid,
  connection_id uuid,
  execution_id uuid,
  approval_id uuid,
  credential_row_id uuid,
  event text not null check (event in
    ('lease_issued', 'decision_blocked', 'decision_approval_required', 'decision_allowed',
     'approval_approved', 'approval_denied', 'approval_expired', 'approval_cancelled',
     'execution_claimed', 'outcome_recorded', 'connection_revoked',
     'service_identity_revoked', 'credential_rotated', 'credential_revoked',
     'policy_created', 'policy_updated', 'policy_deleted')),
  toolkit text,
  tool text,
  request_hash text check (request_hash is null or request_hash ~ '^[0-9a-f]{64}$'),
  policy_version text,
  policy_rule_id text,
  decision text check (decision is null or decision in ('block', 'require_approval', 'allow')),
  correlation_id uuid not null,
  idempotency_key text,
  outcome_classification text check (outcome_classification is null or outcome_classification in
    ('success', 'blocked', 'approval_required', 'credential', 'network', 'upstream',
     'response_too_large', 'internal')),
  upstream_status_class text check (upstream_status_class is null or upstream_status_class in
    ('2xx', '3xx', '4xx', '5xx')),
  response_bytes bigint check (response_bytes is null or response_bytes >= 0),
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  created_at timestamptz not null default now(),
  foreign key (team_id, member_id) references members(team_id, id) on delete restrict,
  foreign key (team_id, service_identity_id)
    references gateway_service_identities(team_id, id) on delete restrict,
  foreign key (team_id, subject_binding_id)
    references executor_subject_bindings(team_id, id) on delete restrict,
  foreign key (team_id, connection_id)
    references gateway_connections(team_id, id) on delete restrict,
  foreign key (team_id, execution_id)
    references gateway_executions(team_id, id) on delete restrict,
  foreign key (team_id, approval_id)
    references gateway_approvals(team_id, id) on delete restrict
);
alter table gateway_audit_log add column if not exists credential_row_id uuid;
alter table gateway_audit_log drop constraint if exists gateway_audit_log_credential_row_fk;
alter table gateway_audit_log add constraint gateway_audit_log_credential_row_fk
  foreign key (team_id,credential_row_id)
  references gateway_service_credentials(team_id,id) on delete restrict;
alter table gateway_audit_log drop constraint if exists gateway_audit_log_event_check;
alter table gateway_audit_log add constraint gateway_audit_log_event_check check (event in
  ('lease_issued','decision_blocked','decision_approval_required','decision_allowed',
   'approval_approved','approval_denied','approval_expired','approval_cancelled',
   'execution_claimed','outcome_recorded','connection_revoked',
   'service_identity_revoked','credential_rotated','credential_revoked',
   'policy_created','policy_updated','policy_deleted'));
create index if not exists gateway_audit_log_team_time_idx
  on gateway_audit_log (team_id, created_at desc);
create unique index if not exists gateway_audit_log_outcome_execution_unq
  on gateway_audit_log (execution_id) where event='outcome_recorded';
create unique index if not exists gateway_audit_log_decision_approval_unq
  on gateway_audit_log (approval_id) where event in ('approval_approved','approval_denied');
create unique index if not exists gateway_audit_log_claim_execution_unq
  on gateway_audit_log (execution_id) where event='execution_claimed';
create unique index if not exists gateway_audit_log_expiry_approval_unq
  on gateway_audit_log (approval_id) where event='approval_expired';
create unique index if not exists gateway_audit_log_cancel_approval_unq
  on gateway_audit_log (approval_id) where event='approval_cancelled';
create unique index if not exists gateway_audit_log_rotation_credential_unq
  on gateway_audit_log (credential_row_id) where event='credential_rotated';
create unique index if not exists gateway_audit_log_revocation_credential_unq
  on gateway_audit_log (credential_row_id) where event='credential_revoked';

create table if not exists gateway_rate_limits (
  bucket text not null,
  window_start timestamptz not null,
  count integer not null check (count > 0),
  primary key (bucket, window_start)
);

create or replace function gateway_audit_protect()
returns trigger language plpgsql as $$
begin
  raise exception 'gateway_audit_log is append-only';
end $$;
drop trigger if exists gateway_audit_log_protect on gateway_audit_log;
create trigger gateway_audit_log_protect
  before update or delete on gateway_audit_log
  for each row execute function gateway_audit_protect();

create or replace function gateway_execution_protect()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'gateway_executions are retained';
  end if;
  if new.team_id is distinct from old.team_id
    or new.member_id is distinct from old.member_id
    or new.service_identity_id is distinct from old.service_identity_id
    or new.subject_binding_id is distinct from old.subject_binding_id
    or new.connection_id is distinct from old.connection_id
    or new.lease_id is distinct from old.lease_id
    or new.correlation_id is distinct from old.correlation_id
    or new.idempotency_key is distinct from old.idempotency_key
    or new.toolkit is distinct from old.toolkit
    or new.tool is distinct from old.tool
    or new.request_hash is distinct from old.request_hash
    or new.encrypted_request_envelope is distinct from old.encrypted_request_envelope
    or new.actor_snapshot is distinct from old.actor_snapshot
    or new.role_snapshot is distinct from old.role_snapshot
    or new.tier_snapshot is distinct from old.tier_snapshot
    or new.policy_resource is distinct from old.policy_resource
    or new.request_envelope_hash is distinct from old.request_envelope_hash
    or (old.resume_fingerprint is not null and new.resume_fingerprint is distinct from old.resume_fingerprint)
    or (old.claim_idempotency_key is not null and new.claim_idempotency_key is distinct from old.claim_idempotency_key)
    or (old.claimed_credential_id is not null and new.claimed_credential_id is distinct from old.claimed_credential_id)
    or new.decision is distinct from old.decision
    or new.policy_version is distinct from old.policy_version
    or new.policy_rule_id is distinct from old.policy_rule_id
    or new.created_at is distinct from old.created_at then
    raise exception 'gateway execution identity/request fields are immutable';
  end if;
  return new;
end $$;
drop trigger if exists gateway_executions_protect on gateway_executions;
create trigger gateway_executions_protect
  before update or delete on gateway_executions
  for each row execute function gateway_execution_protect();

create or replace function gateway_approval_protect()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'gateway_approvals are retained';
  end if;
  if new.team_id is distinct from old.team_id
    or new.execution_id is distinct from old.execution_id
    or new.expires_at is distinct from old.expires_at
    or (old.approver_member_id is not null
        and new.approver_member_id is distinct from old.approver_member_id)
    or (old.decided_at is not null and new.decided_at is distinct from old.decided_at)
    or (old.decision_correlation_id is not null
        and new.decision_correlation_id is distinct from old.decision_correlation_id)
    or new.created_at is distinct from old.created_at then
    raise exception 'gateway approval identity/expiry fields are immutable';
  end if;
  if new.status is distinct from old.status
    and not (
      (old.status='pending' and new.status in ('approved','denied','expired','cancelled'))
      or (old.status='approved' and new.status in ('expired','cancelled'))
    ) then
    raise exception 'gateway approval transition is invalid';
  end if;
  return new;
end $$;
drop trigger if exists gateway_approvals_protect on gateway_approvals;
create trigger gateway_approvals_protect
  before update or delete on gateway_approvals
  for each row execute function gateway_approval_protect();

create or replace function gateway_service_identity_protect()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'gateway service identities must be revoked, not deleted'; end if;
  if new.id is distinct from old.id or new.team_id is distinct from old.team_id
    or new.environment is distinct from old.environment or new.credential_id is distinct from old.credential_id
    or new.credential_hash is distinct from old.credential_hash or new.credential_version is distinct from old.credential_version
    or new.rotated_from_id is distinct from old.rotated_from_id or new.activated_at is distinct from old.activated_at
    or new.created_at is distinct from old.created_at then
    raise exception 'gateway service identity fields are immutable';
  end if; return new;
end $$;
drop trigger if exists gateway_service_identities_protect on gateway_service_identities;
create trigger gateway_service_identities_protect before update or delete on gateway_service_identities
  for each row execute function gateway_service_identity_protect();

create or replace function gateway_service_credential_protect()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'gateway service credentials must be revoked, not deleted';
  end if;
  if new.id is distinct from old.id
    or new.team_id is distinct from old.team_id
    or new.service_identity_id is distinct from old.service_identity_id
    or new.credential_id is distinct from old.credential_id
    or new.version is distinct from old.version
    or new.secret_hash is distinct from old.secret_hash
    or new.replaces_credential_id is distinct from old.replaces_credential_id
    or new.activated_at is distinct from old.activated_at
    or new.expires_at is distinct from old.expires_at
    or new.created_by_member_id is distinct from old.created_by_member_id
    or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at)
    or new.created_at is distinct from old.created_at then
    raise exception 'gateway service credential identity fields are immutable';
  end if;
  return new;
end $$;
drop trigger if exists gateway_service_credentials_protect on gateway_service_credentials;
create trigger gateway_service_credentials_protect before update or delete on gateway_service_credentials
  for each row execute function gateway_service_credential_protect();

create or replace function executor_subject_binding_protect()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'executor subject bindings must be revoked, not deleted'; end if;
  if new.id is distinct from old.id or new.team_id is distinct from old.team_id
    or new.member_id is distinct from old.member_id or new.service_identity_id is distinct from old.service_identity_id
    or new.executor_tenant_id is distinct from old.executor_tenant_id
    or new.executor_subject_id is distinct from old.executor_subject_id
    or new.bound_at is distinct from old.bound_at or new.created_at is distinct from old.created_at then
    raise exception 'executor subject binding identity fields are immutable';
  end if; return new;
end $$;
drop trigger if exists executor_subject_bindings_protect on executor_subject_bindings;
create trigger executor_subject_bindings_protect before update or delete on executor_subject_bindings
  for each row execute function executor_subject_binding_protect();

create or replace function gateway_connection_protect()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'gateway connections must be revoked, not deleted'; end if;
  if new.id is distinct from old.id or new.connection_ref is distinct from old.connection_ref
    or new.team_id is distinct from old.team_id or new.member_id is distinct from old.member_id
    or new.service_identity_id is distinct from old.service_identity_id
    or new.subject_binding_id is distinct from old.subject_binding_id or new.provider is distinct from old.provider
    or new.created_at is distinct from old.created_at then
    raise exception 'gateway connection identity fields are immutable';
  end if; return new;
end $$;
drop trigger if exists gateway_connections_protect on gateway_connections;
create trigger gateway_connections_protect before update or delete on gateway_connections
  for each row execute function gateway_connection_protect();

create or replace function gateway_resolution_lease_protect()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'gateway resolution leases must be revoked, not deleted'; end if;
  if new.id is distinct from old.id or new.lease_hash is distinct from old.lease_hash
    or new.nonce is distinct from old.nonce or new.audience is distinct from old.audience
    or new.team_id is distinct from old.team_id or new.member_id is distinct from old.member_id
    or new.service_identity_id is distinct from old.service_identity_id
    or new.subject_binding_id is distinct from old.subject_binding_id
    or new.connection_id is distinct from old.connection_id or new.policy_version is distinct from old.policy_version
    or new.created_at is distinct from old.created_at
    or new.expires_at is distinct from old.expires_at then
    raise exception 'gateway resolution lease identity fields are immutable';
  end if; return new;
end $$;
drop trigger if exists gateway_resolution_leases_protect on gateway_resolution_leases;
create trigger gateway_resolution_leases_protect before update or delete on gateway_resolution_leases
  for each row execute function gateway_resolution_lease_protect();

create table if not exists rate_limits (
  bucket text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (bucket, window_start)
);

-- Fixed-window rate limiting. Returns the running count for the window so the
-- caller can compare against its per-minute limit.
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
create index if not exists items_team_synced_idx on items (team_id, synced_at desc);
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
  -- Tier visibility (audit H1). A task inherits the `access` tier of the item that materialized it
  -- (lib/ingest materializeTasks); external-tier reads filter `audience='external'`. There is NO RLS
  -- backstop (CLAUDE.md §5) — this column is the SOLE thing stopping an external principal reading
  -- internal task boards. Mirrors `decisions.audience`.
  audience access_tier not null default 'team',
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
alter table tasks add column if not exists audience access_tier not null default 'team';
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
create index if not exists tasks_team_audience_idx on tasks (team_id, audience);

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
  -- Inbound conflict baseline (brain-api v1.4): the EXACT brain `tasks.status` at the last
  -- successful outbound projection / adoption / inbound apply. The provider-group fingerprint
  -- alone cannot decide "brain unchanged" — in_progress and blocked both hash to group 'started',
  -- so a same-group brain edit would be silently overwritten without this exact baseline.
  last_projected_brain_status text,
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
alter table task_pm_links add column if not exists last_projected_brain_status text;

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

-- Meeting notes: the rich metadata layer over a transcript. The full text lives as a normal
-- `items` row (kind='transcript', written through the existing lib/ingest single writer) so it's
-- searchable/queryable through the existing FTS/retrieve pipeline for free; this table holds what
-- `items` has no columns for (who submitted it, who attended, an LLM-written summary). Sole writer:
-- lib/meetings/notes.ts.
create table if not exists meeting_notes (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  source_item_id uuid not null references items(id) on delete cascade,
  submitted_by uuid references members(id) on delete set null,
  title text not null,
  summary text not null default '',
  occurred_at date,
  -- Set when this note was merged into another (same meeting, deduped); readers hide these.
  merged_into uuid references meeting_notes(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (source_item_id)
);
create index if not exists meeting_notes_team_idx on meeting_notes (team_id, created_at desc);
alter table meeting_notes add column if not exists merged_into uuid references meeting_notes(id) on delete set null;
create index if not exists meeting_notes_merged_into_idx on meeting_notes (merged_into);

-- LLM-matched roster attendees (many-to-many; an unmatched name in the transcript is simply
-- dropped, never blocks the note from saving).
create table if not exists meeting_note_attendees (
  meeting_note_id uuid not null references meeting_notes(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  primary key (meeting_note_id, member_id)
);
create index if not exists meeting_note_attendees_member_idx on meeting_note_attendees (member_id);

-- Multiple submitters per note (Meetings merge): when two people upload the same meeting, both are
-- credited. `meeting_notes.submitted_by` stays the primary; this holds the full set. Writer: notes.ts.
create table if not exists meeting_note_submitters (
  meeting_note_id uuid not null references meeting_notes(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  primary key (meeting_note_id, member_id)
);
create index if not exists meeting_note_submitters_member_idx on meeting_note_submitters (member_id);

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
  test_coverage_pct numeric(5,2),                 -- null = no coverage report found (lines %)
  test_coverage_functions_pct numeric(5,2),       -- null = not reported
  test_coverage_branches_pct numeric(5,2),        -- null = not reported
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

-- Functions/branches coverage — added via alter so an already-deployed code_metrics
-- gains them on `pg:schema` (the create-table above is a no-op once the table exists).
alter table code_metrics add column if not exists test_coverage_functions_pct numeric(5,2);
alter table code_metrics add column if not exists test_coverage_branches_pct numeric(5,2);

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
create index if not exists code_contributions_team_idx on code_contributions (team_id);

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
  -- shadow Cognitive-Ergonomics band (v1.3, optional, 0-4, nullable, no default).
  -- Client-derived, provenance-only: never recomputed here, never feeds placement().
  -- Shadow / uncalibrated — never a canonical scorer input.
  ce_band smallint check (ce_band is null or ce_band between 0 and 4),
  -- context-health scan summary (v1.11, optional, nullable, no default). Scalars only
  -- (score, mode, drift_count, versions_behind, coverage_pct, broken_link_count, checked_at) —
  -- never content/paths. context_health_score mirrors ce_band's shape for team-rollup queries;
  -- context_health carries the full summary object. Provenance-only — never recomputed here.
  context_health_score smallint check (context_health_score is null or context_health_score between 0 and 4),
  context_health jsonb,
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

-- Flat AI-tool subscriptions (Claude Max/Pro, Cursor, …). One current plan per
-- member+provider — the real recurring spend, distinct from per-token usage_costs.
-- Written only by lib/subscriptions/ingest via POST /api/v1/subscriptions (v1.8).
create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  provider text not null,
  plan text not null default '',
  monthly_usd numeric(10, 2) not null default 0,
  source text not null default 'unknown',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, member_id, provider)
);
create index if not exists subscriptions_team_idx on subscriptions (team_id);

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
  type text not null check (type in ('github','granola','slack','wise','linear','plane','openai','anthropic','google','openrouter','typefully')),
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

-- Graphiti projection state (idempotency for the brain → Graphiti projector, lib/graph/project).
-- Graphiti does not dedupe by source id, so we track which brain rows we've already projected
-- and the content hash we sent. Re-projection skips unchanged rows; changed content re-pushes
-- (Graphiti's temporal model invalidates the old fact). Sole writer: lib/graph/project.
create table if not exists graph_episodes (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  source_table text not null,                  -- e.g. 'items'
  source_id uuid not null,                     -- the projected row's id
  group_id text not null,                      -- '<teamSlug>:<tier>' (tier-scoped, see lib/graph/group)
  content_sha256 text not null,                -- hash of the episode content we sent
  episode_uuid text,                           -- Graphiti's episode id, if returned
  projected_at timestamptz not null default now(),
  unique (team_id, source_table, source_id)
);
create index if not exists graph_episodes_team_idx on graph_episodes (team_id, projected_at desc);

-- Narrative-arc synthesis cache (Layer 3, lib/graph/arcs). Arcs are an LLM synthesis over the last
-- 7d of the graph — expensive to compute and identical for everyone sharing a tier-visible group set.
-- This persists the result across restarts/deploys and shares it across instances (the in-memory
-- cache did neither). `group_key` is the sorted visible-group set (already the in-memory cache key);
-- `arcs` is the fully-attributed NarrativeArc[] JSON. Read serves-stale-while-revalidate (a stale row
-- is returned immediately while a background recompute refreshes it) — see getArcs. Regenerable cache,
-- not a source of truth. Sole writer: lib/graph/arc-cache (via lib/graph/arcs).
create table if not exists arc_cache (
  team_id uuid not null references teams(id) on delete cascade,
  group_key text not null,                       -- sorted visible-group set, e.g. 'acme_external,acme_team'
  arcs jsonb not null default '[]'::jsonb,        -- NarrativeArc[] (already human-attributed)
  computed_at timestamptz not null default now(),
  primary key (team_id, group_key)
);

-- ── chat conversations (persistent, owner-scoped chat history) ────────────────
-- ChatGPT-style threads persisted server-side so history survives across sessions AND interfaces
-- (web, mobile, CLI, Telegram/Hermes). Owner-scoped: a member reads only their own conversations
-- (app-code gate via lib/chat/store; no RLS backstop on the postgres target). Distinct from
-- query_log (the spend meter, truncated answer) — this is the full thread of record.
create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  title text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create index if not exists conversations_owner_idx on conversations (team_id, member_id, updated_at desc);

create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  team_id uuid not null references teams(id) on delete cascade,
  member_id uuid references members(id) on delete set null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  cited_item_ids uuid[] not null default '{}',
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd numeric(10, 5) not null default 0,
  created_at timestamptz not null default now(),
  -- FTS over message bodies so the sidebar search can match conversation CONTENT (mirrors items.search).
  search tsvector generated always as (to_tsvector('english', coalesce(content, ''))) stored
);
create index if not exists chat_messages_conversation_idx on chat_messages (conversation_id, created_at);
-- NOTE: the `chat_messages_search_idx` GIN index lives in migration 20260707130000, NOT here — on a
-- DB that already has chat_messages the create-table above is a no-op (so the `search` column isn't
-- added here), and an index on a not-yet-existing column would fail. The migration adds the column
-- then the index, covering both from-zero and existing prod.

-- ── ingestion run log (observability for imports/scans) ───────────────────────
-- One row per ingestion run: every scheduler tick, manual /sync, and codebase scan records its
-- outcome here (counts + the actual error messages) so failures are DIAGNOSABLE after the fact
-- instead of vanishing into container logs. This is the fix for silent import breakage (e.g. a
-- scan-on-merge that skipped for weeks, or a client-timeout that reported failure while the server
-- succeeded). Written ONLY by lib/ingest/runs.recordIngestRun (single writer); read by the
-- Admin → Integrations "recent runs" panel. team_id is null for instance-wide scheduler aggregates
-- (the runners loop teams internally), set for per-team manual syncs and scans.
create table if not exists ingest_runs (
  id bigint generated always as identity primary key,
  team_id uuid references teams(id) on delete cascade,
  source text not null,        -- 'slack' | 'linear' | 'plane' | 'github' | 'scan' | …
  trigger text not null,       -- 'scheduler' | 'manual' | 'merge' | 'cli' | 'api'
  ok boolean not null default true,
  created integer not null default 0,
  updated integer not null default 0,
  unchanged integer not null default 0,
  error_count integer not null default 0,
  errors jsonb not null default '[]',   -- the actual messages, not just a count
  meta jsonb not null default '{}',     -- source-specific extras (channels, head_sha, …)
  started_at timestamptz not null default now(),
  finished_at timestamptz not null default now(),
  duration_ms integer
);
create index if not exists ingest_runs_team_source_idx on ingest_runs (team_id, source, finished_at desc);
create index if not exists ingest_runs_finished_idx on ingest_runs (finished_at desc);

-- ── Social Brain durable job/outbox (M0) ─────────────────────────────────────
-- The one durable async primitive: work that survives a redeploy and retries on failure
-- (media renders, provider polling, scheduled publishing, publish/analytics retries). The
-- in-process poller (lib/jobs/scheduler) claims due rows, runs the handler registered for the
-- `kind`, and on failure requeues with exponential backoff until `max_attempts` → 'dead'.
-- `run_after` doubles as the scheduled-publish time. Single writer: lib/jobs/store.ts. No RLS
-- — team scoping is app-code. Claim is a conditional UPDATE under the poller's single-flight
-- guard (one instance today); the documented multi-instance upgrade is FOR UPDATE SKIP LOCKED.
create table if not exists social_jobs (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  kind text not null,                         -- 'generate_image' | 'poll_render' | 'publish' | 'collect_analytics' | …
  payload jsonb not null default '{}',        -- kind-specific input (no secrets — those stay in integrations)
  status social_job_status not null default 'queued',
  attempts integer not null default 0,        -- times a worker has started this job
  max_attempts integer not null default 5,    -- after this many failed attempts → 'dead'
  run_after timestamptz not null default now(), -- earliest eligible run time (scheduling + backoff)
  locked_at timestamptz,                       -- when the current worker claimed it (null unless running)
  last_error text,                             -- most recent failure message (surfaced, never thrown)
  dedup_key text,                              -- optional idempotency key; unique per team when set
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists social_jobs_due_idx on social_jobs (status, run_after);
create index if not exists social_jobs_team_idx on social_jobs (team_id, created_at desc);
create unique index if not exists social_jobs_dedup_idx
  on social_jobs (team_id, dedup_key) where dedup_key is not null;

-- ── Brand Brain (Social Brain M1) ────────────────────────────────────────────
-- One persistent per-team brand config the Social Brain enforces: voice (vocabulary/tone/
-- formatting/preferred+prohibited phrases), company knowledge (products/positioning/audiences/
-- claims/roadmap visibility), and governance (confidential topics, legal/pricing/disclosure
-- rules, approval thresholds). Non-secret config only — credentials stay in `integrations`.
-- One row per team (team_id PK). Single writer: lib/brand/manage.ts. No RLS — the /admin area
-- is admin-gated in app code.
create table if not exists brand_profiles (
  team_id uuid primary key references teams(id) on delete cascade,
  voice jsonb not null default '{}',
  knowledge jsonb not null default '{}',
  governance jsonb not null default '{}',
  created_by uuid references members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Brand assets: per-team reference library (website/URLs, logo/image links, reference examples)
-- the Brand Brain layers into generation. Non-secret. Single writer: lib/brand/assets.ts.
create table if not exists brand_assets (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  kind text not null check (kind in ('url', 'asset', 'reference')),
  label text not null,
  url text,
  notes text not null default '',
  created_by uuid references members(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists brand_assets_team_idx on brand_assets (team_id, created_at desc);

-- ── Social Brain content domain (M2 foundation) ──────────────────────────────
-- The durable data model + lifecycle for opportunity → plan → variant. Each row carries an
-- `access` tier inherited from its source evidence, so tier isolation (CLAUDE.md §5) propagates
-- down the chain. Schema only in M2 — discovery-scoring + brand-aware planning are a later
-- product-steered milestone. Single writer: lib/social/store.ts. No RLS — app-code enforced.
create table if not exists social_opportunities (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  access access_tier not null,
  source_type text not null,                -- 'manual' | 'item' | 'commit' | 'decision' | …
  title text not null,
  summary text not null default '',
  evidence jsonb not null default '[]',     -- [{item_id, path, note}] — provenance to brain knowledge
  topics jsonb not null default '[]',
  audiences jsonb not null default '[]',
  novelty_score numeric(4, 3) not null default 0,
  relevance_score numeric(4, 3) not null default 0,
  urgency_score numeric(4, 3) not null default 0,
  confidence_score numeric(4, 3) not null default 0,
  status opportunity_status not null default 'discovered',
  dedup_key text,
  created_by uuid references members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists social_opportunities_team_status_idx on social_opportunities (team_id, status, created_at desc);
create index if not exists social_opportunities_team_access_idx on social_opportunities (team_id, access);
create unique index if not exists social_opportunities_dedup_idx
  on social_opportunities (team_id, dedup_key) where dedup_key is not null;

create table if not exists content_plans (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  opportunity_id uuid not null references social_opportunities(id) on delete cascade,
  access access_tier not null,
  objective text not null default '',
  audience text not null default '',
  status text not null default 'planned' check (status in ('planned', 'active', 'archived')),
  created_by uuid references members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists content_plans_team_opp_idx on content_plans (team_id, opportunity_id);
create index if not exists content_plans_team_access_idx on content_plans (team_id, access);

create table if not exists content_variants (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  plan_id uuid not null references content_plans(id) on delete cascade,
  access access_tier not null,
  platform text not null,                   -- 'x' | 'linkedin' | 'threads' | …
  format text not null,                     -- 'text' | 'image' | 'carousel' | …
  tone text not null default '',
  body text not null default '',
  status content_status not null default 'planned',
  validation jsonb not null default '{}',   -- governance gate result (violations/warnings), lib/social/validate
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table content_variants add column if not exists validation jsonb not null default '{}';
create index if not exists content_variants_team_plan_idx on content_variants (team_id, plan_id);
create index if not exists content_variants_team_status_idx on content_variants (team_id, status);

-- Generated media (images) for a variant. Opt-in + rate-capped (lib/media/generate-image); bytes
-- inline as base64 for V1. Single writer: lib/media/store.ts. Tier inherited from the variant.
create table if not exists media_assets (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  variant_id uuid not null references content_variants(id) on delete cascade,
  access access_tier not null,
  kind text not null default 'image' check (kind in ('image')),
  provider text not null,
  model text not null,
  prompt text not null default '',
  data_base64 text not null,
  cost_usd numeric(10, 5) not null default 0,
  created_by uuid references members(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists media_assets_variant_idx on media_assets (variant_id, created_at desc);
create index if not exists media_assets_team_day_idx on media_assets (team_id, created_at);

-- Social Brain approval workflow (M4). Per-team autonomy gate + the content-approval queue.
-- Single writers: lib/social/settings.ts (autonomy), lib/social/approvals.ts (queue).
create table if not exists social_settings (
  team_id uuid primary key references teams(id) on delete cascade,
  autonomy text not null default 'draft_only'
    check (autonomy in ('draft_only', 'approval_required', 'auto_publish_low_risk', 'fully_autonomous')),
  publish_dry_run boolean not null default true,   -- no live posts until an admin flips this off
  updated_at timestamptz not null default now()
);
alter table social_settings add column if not exists publish_dry_run boolean not null default true;

-- Publication ledger (M5): one row per publish attempt of a variant. Single writer:
-- lib/social/publications.ts. Tier inherited from the variant. Publishing rides the M0 job runner.
create table if not exists social_publications (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  variant_id uuid not null references content_variants(id) on delete cascade,
  access access_tier not null,
  provider text not null default 'typefully',
  status text not null default 'scheduled'
    check (status in ('scheduled', 'publishing', 'published', 'failed', 'cancelled')),
  dry_run boolean not null default true,
  scheduled_at timestamptz,
  published_at timestamptz,
  external_id text,
  external_url text,
  last_error text,
  created_by uuid references members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists social_publications_team_idx on social_publications (team_id, created_at desc);
create index if not exists social_publications_variant_idx on social_publications (variant_id);

-- Normalized per-publication analytics (M6). One row per publication (latest snapshot). Typefully
-- exposes X-only metrics. Single writer: lib/social/analytics.ts. Tier inherited from publication.
create table if not exists publication_analytics (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  publication_id uuid not null unique references social_publications(id) on delete cascade,
  access access_tier not null,
  provider text not null default 'typefully',
  impressions integer,
  likes integer,
  comments integer,
  shares integer,
  saves integer,
  clicks integer,
  raw jsonb not null default '{}',
  collected_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists publication_analytics_team_idx on publication_analytics (team_id, collected_at desc);

create table if not exists content_approvals (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  variant_id uuid not null references content_variants(id) on delete cascade,
  access access_tier not null,
  status approval_status not null default 'pending',
  decided_by uuid references members(id) on delete set null,
  decided_at timestamptz,
  decision_note text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists content_approvals_team_status_idx on content_approvals (team_id, status, created_at desc);
create index if not exists content_approvals_variant_idx on content_approvals (variant_id);
