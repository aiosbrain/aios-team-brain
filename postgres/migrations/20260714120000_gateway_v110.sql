-- AIO-401: contract-first internal gateway transport/auth/rate/outcome invariants.
do $$ begin
  if exists (select 1 from gateway_service_identities where credential_id !~ '^[A-Za-z0-9_-]{22}$' or credential_hash !~ '^[0-9a-f]{64}$') then
    raise exception 'legacy gateway service identity rows require explicit credential rotation';
  end if;
end $$;

alter table gateway_service_identities drop constraint if exists gateway_service_identities_credential_id_check;
alter table gateway_service_identities drop constraint if exists gateway_service_identities_credential_hash_check;
alter table gateway_service_identities add constraint gateway_service_identities_credential_id_check check (credential_id ~ '^[A-Za-z0-9_-]{22}$');
alter table gateway_service_identities add constraint gateway_service_identities_credential_hash_check check (credential_hash ~ '^[0-9a-f]{64}$');

alter table gateway_resolution_leases add column if not exists policy_version text;
update gateway_resolution_leases set policy_version='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945' where policy_version is null;
alter table gateway_resolution_leases alter column policy_version set not null;
alter table gateway_resolution_leases drop constraint if exists gateway_resolution_leases_policy_version_check;
alter table gateway_resolution_leases add constraint gateway_resolution_leases_policy_version_check check (policy_version ~ '^[0-9a-f]{64}$');

create unique index if not exists gateway_audit_log_outcome_execution_unq
  on gateway_audit_log (execution_id) where event='outcome_recorded';

create table if not exists gateway_rate_limits (
  bucket text not null,
  window_start timestamptz not null,
  count integer not null check (count > 0),
  primary key (bucket, window_start)
);
