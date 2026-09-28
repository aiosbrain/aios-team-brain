-- AIO-1186. Durable identities are never recycled; retention deletion is intentionally absent.
create table if not exists governed_action_identities (
 id uuid primary key default gen_random_uuid(),
 team_id uuid not null references teams(id) on delete restrict,
 member_id uuid not null references members(id) on delete restrict,
 project_id uuid not null references projects(id) on delete restrict,
 operation_key text not null,
 canonical_request text not null,
 request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 unique (team_id, member_id, project_id, operation_key)
);
create table if not exists governed_actions (
 id uuid primary key default gen_random_uuid(),
 identity_id uuid not null references governed_action_identities(id) on delete restrict,
 attempt integer not null check (attempt > 0),
 credential_id uuid not null references api_keys(id) on delete restrict,
 credential_fingerprint text not null,
 request text not null,
 status text not null check (status in ('requested','running','pending_approval','succeeded','denied','conflict','failed')),
 result jsonb not null,
 audit_ref bigint not null references audit_log(id) on delete restrict,
 approval_request_id uuid unique references approval_requests(id) on delete restrict,
 authorization_fingerprint text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(identity_id,attempt)
);
create index if not exists governed_actions_credential_idx on governed_actions(credential_id);
create index if not exists governed_actions_audit_idx on governed_actions(audit_ref);
create index if not exists governed_identity_member_idx on governed_action_identities(member_id);
create index if not exists governed_identity_project_idx on governed_action_identities(project_id);
