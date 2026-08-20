-- Re-assert the lease immutability set that schema.sql has declared since AIO-401, and that the
-- rollout has been silently reverting on every deploy.
--
-- `postgres/schema.sql` defines gateway_resolution_lease_protect() with `policy_version` in its
-- immutable-field list. `20260714090000_gateway_persistence.sql` defines the SAME function WITHOUT
-- it, and pg-load-schema runs schema.sql first and then every migration in lexical order — so the
-- older, looser body has been `create or replace`-ing the stricter one on every rollout since. The
-- stated invariant ("gateway resolution lease identity fields are immutable") has therefore not
-- actually held for policy_version in any deployed database, from-zero or upgraded, and no test
-- could see it: the fresh-DB load ends at exactly the same (loose) definition.
--
-- Found by the migrate-from-existing lane (scripts/migrate-from-existing.mjs --mirror-check), which
-- compares the catalog fingerprint of schema.sql alone against schema.sql + every migration.
--
-- Why a NEW migration rather than editing 20260714090000: `20260714120000_gateway_v110.sql` runs a
-- one-time `update gateway_resolution_leases set policy_version=… where policy_version is null`
-- backfill, and it replays on every deploy. Tightening the earlier file would put the strict trigger
-- in front of that backfill and abort the release on any database still holding a null. Landing the
-- tightening AFTER the backfill keeps both correct, in both orders, forever.
--
-- Idempotent: `create or replace`. The body is kept byte-equivalent to schema.sql's so the
-- mirror-check stays green — change both together.
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
