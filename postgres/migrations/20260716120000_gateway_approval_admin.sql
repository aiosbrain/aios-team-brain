-- AIO-407: durable gateway approvals, resumable claims, and independently
-- rotatable service credentials. This migration is additive and replay-safe.

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

insert into gateway_service_credentials
  (team_id, service_identity_id, credential_id, version, secret_hash,
   activated_at, expires_at, revoked_at, last_authenticated_at, created_at)
select team_id, id, credential_id, credential_version, credential_hash,
       activated_at, expires_at, revoked_at, last_authenticated_at, created_at
  from gateway_service_identities
on conflict (credential_id) do nothing;

alter table gateway_executions add column if not exists actor_snapshot text;
alter table gateway_executions add column if not exists role_snapshot text;
alter table gateway_executions add column if not exists tier_snapshot text;
alter table gateway_executions add column if not exists policy_resource text;
alter table gateway_executions add column if not exists request_envelope_hash text;
alter table gateway_executions add column if not exists resume_fingerprint text;
alter table gateway_executions add column if not exists claim_idempotency_key text;
alter table gateway_executions add column if not exists claimed_credential_id uuid;

update gateway_executions e
   set actor_snapshot = coalesce(e.actor_snapshot, m.actor_handle),
       role_snapshot = coalesce(e.role_snapshot, m.role::text),
       tier_snapshot = coalesce(e.tier_snapshot, m.tier::text),
       policy_resource = coalesce(e.policy_resource, 'github.repository:*'),
       request_envelope_hash = coalesce(
         e.request_envelope_hash,
         encode(sha256(e.encrypted_request_envelope), 'hex')
       )
  from members m
 where m.id=e.member_id and m.team_id=e.team_id
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
  foreign key (team_id, claimed_credential_id)
  references gateway_service_credentials(team_id, id) on delete restrict;

alter table gateway_approvals add column if not exists decision_correlation_id uuid;

alter table gateway_audit_log add column if not exists credential_row_id uuid;
alter table gateway_audit_log drop constraint if exists gateway_audit_log_credential_row_fk;
alter table gateway_audit_log add constraint gateway_audit_log_credential_row_fk
  foreign key (team_id, credential_row_id)
  references gateway_service_credentials(team_id, id) on delete restrict;
alter table gateway_audit_log drop constraint if exists gateway_audit_log_event_check;
alter table gateway_audit_log add constraint gateway_audit_log_event_check check (event in
  ('lease_issued', 'decision_blocked', 'decision_approval_required', 'decision_allowed',
   'approval_approved', 'approval_denied', 'approval_expired', 'approval_cancelled',
   'execution_claimed', 'outcome_recorded', 'connection_revoked',
   'service_identity_revoked', 'credential_rotated', 'credential_revoked',
   'policy_created', 'policy_updated', 'policy_deleted'));

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
create trigger gateway_service_credentials_protect
  before update or delete on gateway_service_credentials
  for each row execute function gateway_service_credential_protect();

create or replace function gateway_approval_protect()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'gateway_approvals are retained'; end if;
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

create or replace function gateway_execution_protect()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'gateway_executions are retained'; end if;
  if new.team_id is distinct from old.team_id or new.member_id is distinct from old.member_id
    or new.service_identity_id is distinct from old.service_identity_id
    or new.subject_binding_id is distinct from old.subject_binding_id
    or new.connection_id is distinct from old.connection_id or new.lease_id is distinct from old.lease_id
    or new.correlation_id is distinct from old.correlation_id or new.idempotency_key is distinct from old.idempotency_key
    or new.toolkit is distinct from old.toolkit or new.tool is distinct from old.tool
    or new.request_hash is distinct from old.request_hash
    or new.encrypted_request_envelope is distinct from old.encrypted_request_envelope
    or new.decision is distinct from old.decision or new.policy_version is distinct from old.policy_version
    or new.policy_rule_id is distinct from old.policy_rule_id or new.created_at is distinct from old.created_at
    or new.actor_snapshot is distinct from old.actor_snapshot
    or new.role_snapshot is distinct from old.role_snapshot
    or new.tier_snapshot is distinct from old.tier_snapshot
    or new.policy_resource is distinct from old.policy_resource
    or new.request_envelope_hash is distinct from old.request_envelope_hash
    or (old.resume_fingerprint is not null and new.resume_fingerprint is distinct from old.resume_fingerprint)
    or (old.claim_idempotency_key is not null and new.claim_idempotency_key is distinct from old.claim_idempotency_key)
    or (old.claimed_credential_id is not null and new.claimed_credential_id is distinct from old.claimed_credential_id) then
    raise exception 'gateway execution identity/request fields are immutable';
  end if;
  return new;
end $$;
drop trigger if exists gateway_executions_protect on gateway_executions;
create trigger gateway_executions_protect
  before update or delete on gateway_executions
  for each row execute function gateway_execution_protect();
