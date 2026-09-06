-- PRET-6 / STAGINGMARK-2: retire permissive mode after readiness and materialization.
-- Replayed on every deploy, without an applied-ledger. schema.sql defines
-- materialize_builtin_membership_once before this file executes; never copy its body here.
-- Permissive teams still refuse BEFORE membership mutation. A markerless fleet now
-- creates absent builtins, reconciles membership and stamps, even without the old column.
-- Already-marked fleets skip reconciliation. The existence-gated drops replay safely;
-- the earlier column-creation migrations remain neutered.
-- This DO statement is atomic: a failed reconcile or drop rolls back rows and marker.
-- The loader's earlier schema/migrations are separately committed, not rolled back here.
-- Waiting is bounded PER STATEMENT by the loader's lock_timeout
-- (PG_MIGRATION_LOCK_TIMEOUT_MS, default 15s) -- deliberately NOT overridden here: an
-- operator who lowered it to fail fast, or raised it for a slow fleet, must keep that
-- choice for exactly the ACCESS EXCLUSIVE drop the knob was written for. The number of
-- waiting statements is data-dependent, so no total upper bound is claimed.
do $$ begin
  if exists (select 1 from information_schema.columns
             where table_schema = current_schema() and table_name = 'teams' and column_name = 'access_enforcement') then
    if exists (select 1 from teams where access_enforcement = 'permissive') then
      raise exception 'PRET-6 refused: permissive team(s) remain — flip them first (see docs/RELEASE-NOTES-pret6.md)';
    end if;
  end if;

  perform materialize_builtin_membership_once();

  if exists (select 1 from information_schema.columns
             where table_schema = current_schema() and table_name = 'teams' and column_name = 'access_enforcement') then
    alter table teams drop column access_enforcement;
    alter table teams drop column if exists autoflip_hold;
  end if;
end $$;
