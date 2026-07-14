-- AIO-405: replay-safe managed GitHub gateway persistence.
-- Keep this block byte-for-byte aligned with the managed-gateway block in schema.sql.
-- New installs see it from schema.sql; deployed installs receive it here.

create unique index if not exists members_team_id_id_unq on members (team_id, id);

create table if not exists gateway_service_identities (
  id uuid primary key default gen_random_uuid(), team_id uuid not null references teams(id) on delete restrict,
  environment text not null check (environment <> ''), credential_id text not null unique check (credential_id <> ''),
  credential_hash text not null check (credential_hash <> ''), credential_version integer not null default 1 check (credential_version > 0),
  rotated_from_id uuid references gateway_service_identities(id) on delete restrict,
  activated_at timestamptz not null default now(), expires_at timestamptz, revoked_at timestamptz,
  last_authenticated_at timestamptz, created_at timestamptz not null default now(), unique (team_id, id),
  check (expires_at is null or expires_at > activated_at), check (revoked_at is null or revoked_at >= activated_at)
);
create index if not exists gateway_service_identities_team_env_idx on gateway_service_identities (team_id, environment);

create table if not exists executor_subject_bindings (
  id uuid primary key default gen_random_uuid(), team_id uuid not null, member_id uuid not null,
  service_identity_id uuid not null, executor_tenant_id text not null check (executor_tenant_id <> ''),
  executor_subject_id text not null check (executor_subject_id <> ''), bound_at timestamptz not null default now(),
  expires_at timestamptz, revoked_at timestamptz, created_at timestamptz not null default now(), unique (team_id, id),
  unique (team_id, member_id, id),
  unique (team_id, member_id, service_identity_id, id),
  unique (service_identity_id, executor_tenant_id, executor_subject_id),
  foreign key (team_id, member_id) references members(team_id, id) on delete restrict,
  foreign key (team_id, service_identity_id) references gateway_service_identities(team_id, id) on delete restrict,
  check (expires_at is null or expires_at > bound_at), check (revoked_at is null or revoked_at >= bound_at)
);
create unique index if not exists executor_subject_bindings_active_member_unq
  on executor_subject_bindings (team_id, member_id, service_identity_id) where revoked_at is null;

create table if not exists gateway_connections (
  id uuid primary key default gen_random_uuid(), connection_ref text not null unique check (connection_ref <> ''),
  team_id uuid not null, member_id uuid not null, service_identity_id uuid not null, subject_binding_id uuid not null,
  provider text not null default 'github' check (provider = 'github'),
  credential_ciphertext text not null check (credential_ciphertext <> ''), enabled boolean not null default true,
  credential_expires_at timestamptz, validated_at timestamptz, revoked_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (team_id, id),
  unique (team_id, member_id, id),
  unique (team_id, member_id, service_identity_id, id),
  foreign key (team_id, member_id) references members(team_id, id) on delete restrict,
  foreign key (team_id, service_identity_id) references gateway_service_identities(team_id, id) on delete restrict,
  foreign key (team_id, member_id, service_identity_id, subject_binding_id)
    references executor_subject_bindings(team_id, member_id, service_identity_id, id) on delete restrict,
  check ((enabled and revoked_at is null) or (not enabled))
);
create unique index if not exists gateway_connections_active_member_unq
  on gateway_connections (team_id, member_id) where enabled and revoked_at is null;

create table if not exists gateway_resolution_leases (
  id uuid primary key default gen_random_uuid(), lease_hash text not null unique check (lease_hash ~ '^[0-9a-f]{64}$'),
  nonce uuid not null default gen_random_uuid(), audience text not null check (audience <> ''),
  team_id uuid not null, member_id uuid not null, service_identity_id uuid not null,
  subject_binding_id uuid not null, connection_id uuid not null, created_at timestamptz not null default now(),
  expires_at timestamptz not null, consumed_at timestamptz, revoked_at timestamptz, unique (team_id, id),
  unique (team_id, member_id, service_identity_id, subject_binding_id, connection_id, id),
  foreign key (team_id, member_id) references members(team_id, id) on delete restrict,
  foreign key (team_id, service_identity_id) references gateway_service_identities(team_id, id) on delete restrict,
  foreign key (team_id, member_id, service_identity_id, subject_binding_id)
    references executor_subject_bindings(team_id, member_id, service_identity_id, id) on delete restrict,
  foreign key (team_id, member_id, service_identity_id, connection_id)
    references gateway_connections(team_id, member_id, service_identity_id, id) on delete restrict,
  check (expires_at > created_at and expires_at <= created_at + interval '30 seconds'),
  check (consumed_at is null or consumed_at >= created_at), check (revoked_at is null or revoked_at >= created_at)
);
create index if not exists gateway_resolution_leases_scope_idx
  on gateway_resolution_leases (team_id, member_id, subject_binding_id, connection_id);

create table if not exists gateway_executions (
  id uuid primary key default gen_random_uuid(), team_id uuid not null, member_id uuid not null,
  service_identity_id uuid not null, subject_binding_id uuid not null, connection_id uuid not null,
  lease_id uuid not null unique,
  correlation_id uuid not null, idempotency_key text not null check (idempotency_key <> ''),
  toolkit text not null check (toolkit <> ''), tool text not null check (tool <> ''),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  encrypted_request_envelope bytea not null check (octet_length(encrypted_request_envelope) between 1 and 65536),
  decision text not null check (decision in ('block', 'require_approval', 'allow')),
  state text not null check (state in ('blocked', 'approval_required', 'approved', 'claimed', 'succeeded', 'failed', 'cancelled', 'expired')),
  policy_version text, policy_rule_id text, claimed_at timestamptz, claimed_by_correlation_id uuid,
  outcome_classification text check (outcome_classification in ('success', 'blocked', 'approval_required', 'credential', 'network', 'upstream', 'response_too_large', 'internal')),
  upstream_status_class text check (upstream_status_class in ('2xx', '3xx', '4xx', '5xx')),
  response_bytes bigint check (response_bytes is null or response_bytes >= 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (service_identity_id, idempotency_key), unique (team_id, id), unique (team_id, member_id, id),
  foreign key (team_id, member_id) references members(team_id, id) on delete restrict,
  foreign key (team_id, service_identity_id) references gateway_service_identities(team_id, id) on delete restrict,
  foreign key (team_id, member_id, subject_binding_id) references executor_subject_bindings(team_id, member_id, id) on delete restrict,
  foreign key (team_id, member_id, connection_id) references gateway_connections(team_id, member_id, id) on delete restrict,
  foreign key (team_id, member_id, service_identity_id, subject_binding_id, connection_id, lease_id)
    references gateway_resolution_leases(team_id, member_id, service_identity_id, subject_binding_id, connection_id, id) on delete restrict
);
create index if not exists gateway_executions_scope_idx
  on gateway_executions (team_id, member_id, subject_binding_id, created_at desc);

create table if not exists gateway_approvals (
  id uuid primary key default gen_random_uuid(), team_id uuid not null, execution_id uuid not null unique,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'expired', 'cancelled')),
  expires_at timestamptz not null, approver_member_id uuid, decided_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (team_id, id),
  foreign key (team_id, execution_id) references gateway_executions(team_id, id) on delete restrict,
  foreign key (team_id, approver_member_id) references members(team_id, id) on delete restrict,
  check (expires_at > created_at and expires_at <= created_at + interval '15 minutes'),
  check ((status = 'pending' and decided_at is null and approver_member_id is null) or (status <> 'pending' and decided_at is not null))
);

create table if not exists gateway_audit_log (
  id bigint generated always as identity primary key, team_id uuid not null references teams(id) on delete restrict,
  member_id uuid, service_identity_id uuid, subject_binding_id uuid, connection_id uuid,
  execution_id uuid, approval_id uuid,
  event text not null check (event in ('lease_issued', 'decision_blocked', 'decision_approval_required', 'decision_allowed', 'approval_approved', 'approval_denied', 'approval_expired', 'execution_claimed', 'outcome_recorded', 'connection_revoked', 'service_identity_revoked')),
  toolkit text, tool text, request_hash text check (request_hash is null or request_hash ~ '^[0-9a-f]{64}$'),
  policy_version text, policy_rule_id text, decision text check (decision is null or decision in ('block', 'require_approval', 'allow')),
  correlation_id uuid not null, idempotency_key text,
  outcome_classification text check (outcome_classification is null or outcome_classification in ('success', 'blocked', 'approval_required', 'credential', 'network', 'upstream', 'response_too_large', 'internal')),
  upstream_status_class text check (upstream_status_class is null or upstream_status_class in ('2xx', '3xx', '4xx', '5xx')),
  response_bytes bigint check (response_bytes is null or response_bytes >= 0),
  duration_ms integer check (duration_ms is null or duration_ms >= 0), created_at timestamptz not null default now(),
  foreign key (team_id, member_id) references members(team_id, id) on delete restrict,
  foreign key (team_id, service_identity_id) references gateway_service_identities(team_id, id) on delete restrict,
  foreign key (team_id, subject_binding_id) references executor_subject_bindings(team_id, id) on delete restrict,
  foreign key (team_id, connection_id) references gateway_connections(team_id, id) on delete restrict,
  foreign key (team_id, execution_id) references gateway_executions(team_id, id) on delete restrict,
  foreign key (team_id, approval_id) references gateway_approvals(team_id, id) on delete restrict
);
create index if not exists gateway_audit_log_team_time_idx on gateway_audit_log (team_id, created_at desc);

create or replace function gateway_audit_protect() returns trigger language plpgsql as $$
begin raise exception 'gateway_audit_log is append-only'; end $$;
drop trigger if exists gateway_audit_log_protect on gateway_audit_log;
create trigger gateway_audit_log_protect before update or delete on gateway_audit_log
  for each row execute function gateway_audit_protect();

create or replace function gateway_execution_protect() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'gateway_executions are retained'; end if;
  if new.team_id is distinct from old.team_id or new.member_id is distinct from old.member_id
    or new.service_identity_id is distinct from old.service_identity_id or new.subject_binding_id is distinct from old.subject_binding_id
    or new.connection_id is distinct from old.connection_id or new.lease_id is distinct from old.lease_id
    or new.correlation_id is distinct from old.correlation_id or new.idempotency_key is distinct from old.idempotency_key
    or new.toolkit is distinct from old.toolkit or new.tool is distinct from old.tool
    or new.request_hash is distinct from old.request_hash or new.encrypted_request_envelope is distinct from old.encrypted_request_envelope
    or new.decision is distinct from old.decision or new.policy_version is distinct from old.policy_version
    or new.policy_rule_id is distinct from old.policy_rule_id or new.created_at is distinct from old.created_at then
    raise exception 'gateway execution identity/request fields are immutable';
  end if; return new;
end $$;
drop trigger if exists gateway_executions_protect on gateway_executions;
create trigger gateway_executions_protect before update or delete on gateway_executions
  for each row execute function gateway_execution_protect();

create or replace function gateway_approval_protect() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'gateway_approvals are retained'; end if;
  if new.team_id is distinct from old.team_id or new.execution_id is distinct from old.execution_id
    or new.expires_at is distinct from old.expires_at or new.created_at is distinct from old.created_at then
    raise exception 'gateway approval identity/expiry fields are immutable';
  end if; return new;
end $$;
drop trigger if exists gateway_approvals_protect on gateway_approvals;
create trigger gateway_approvals_protect before update or delete on gateway_approvals
  for each row execute function gateway_approval_protect();

create or replace function gateway_service_identity_protect() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'gateway service identities must be revoked, not deleted'; end if;
  if new.id is distinct from old.id or new.team_id is distinct from old.team_id or new.environment is distinct from old.environment
    or new.credential_id is distinct from old.credential_id or new.credential_hash is distinct from old.credential_hash
    or new.credential_version is distinct from old.credential_version or new.rotated_from_id is distinct from old.rotated_from_id
    or new.activated_at is distinct from old.activated_at or new.created_at is distinct from old.created_at then
    raise exception 'gateway service identity fields are immutable';
  end if; return new;
end $$;
drop trigger if exists gateway_service_identities_protect on gateway_service_identities;
create trigger gateway_service_identities_protect before update or delete on gateway_service_identities
  for each row execute function gateway_service_identity_protect();

create or replace function executor_subject_binding_protect() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'executor subject bindings must be revoked, not deleted'; end if;
  if new.id is distinct from old.id or new.team_id is distinct from old.team_id or new.member_id is distinct from old.member_id
    or new.service_identity_id is distinct from old.service_identity_id or new.executor_tenant_id is distinct from old.executor_tenant_id
    or new.executor_subject_id is distinct from old.executor_subject_id or new.bound_at is distinct from old.bound_at
    or new.created_at is distinct from old.created_at then raise exception 'executor subject binding identity fields are immutable';
  end if; return new;
end $$;
drop trigger if exists executor_subject_bindings_protect on executor_subject_bindings;
create trigger executor_subject_bindings_protect before update or delete on executor_subject_bindings
  for each row execute function executor_subject_binding_protect();

create or replace function gateway_connection_protect() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'gateway connections must be revoked, not deleted'; end if;
  if new.id is distinct from old.id or new.connection_ref is distinct from old.connection_ref
    or new.team_id is distinct from old.team_id or new.member_id is distinct from old.member_id
    or new.service_identity_id is distinct from old.service_identity_id
    or new.subject_binding_id is distinct from old.subject_binding_id or new.provider is distinct from old.provider
    or new.created_at is distinct from old.created_at then raise exception 'gateway connection identity fields are immutable';
  end if; return new;
end $$;
drop trigger if exists gateway_connections_protect on gateway_connections;
create trigger gateway_connections_protect before update or delete on gateway_connections
  for each row execute function gateway_connection_protect();

create or replace function gateway_resolution_lease_protect() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'gateway resolution leases must be revoked, not deleted'; end if;
  if new.id is distinct from old.id or new.lease_hash is distinct from old.lease_hash or new.nonce is distinct from old.nonce
    or new.audience is distinct from old.audience or new.team_id is distinct from old.team_id or new.member_id is distinct from old.member_id
    or new.service_identity_id is distinct from old.service_identity_id or new.subject_binding_id is distinct from old.subject_binding_id
    or new.connection_id is distinct from old.connection_id or new.created_at is distinct from old.created_at
    or new.expires_at is distinct from old.expires_at then raise exception 'gateway resolution lease identity fields are immutable';
  end if; return new;
end $$;
drop trigger if exists gateway_resolution_leases_protect on gateway_resolution_leases;
create trigger gateway_resolution_leases_protect before update or delete on gateway_resolution_leases
  for each row execute function gateway_resolution_lease_protect();
