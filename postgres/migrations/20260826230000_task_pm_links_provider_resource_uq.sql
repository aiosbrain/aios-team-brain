-- ADOPTUNIQ-1 — the DB backstop for one-issue-one-row: at most ONE link per
-- (team, provider) may claim a given provider_resource_id.
--
-- Design + every claim below: docs/design/task-pm-links-unique-index.md
--
-- WHY IT WAS DEFERRED, AND WHY IT SHIPS NOW
-- `20260817164500_task_pm_links_declared_external_id.sql:12-16` records the deferral: prod held three
-- TT1 links all pointing at Linear issue AIO-444, so the index would have aborted the release (the
-- #251 replay class). Re-measured 2026-08-26 read-only against prod: ZERO violating groups across
-- 1,067 links, one TT1 link left. The blocker is gone; the guard below exists for every OTHER
-- self-hosted fleet, whose data nobody here can read.
--
-- ⚠️ THIS BLOCK IS THE ONLY LEGAL CREATOR OF THIS INDEX, AND IT IS DUPLICATED VERBATIM IN
-- `postgres/schema.sql`. Do NOT "tidy" either copy into a bare `create unique index`.
-- `scripts/pg-load-schema.mjs` loads schema.sql FIRST (:69) and then the migrations (:72-78), and —
-- unlike a column inside `create table if not exists`, which is a no-op on an existing DB — a
-- top-level `create unique index` DOES execute against an existing database. schema.sql is sent as a
-- single multi-statement query, i.e. ONE implicit transaction, so an unguarded failure there aborts
-- the ENTIRE schema load before any migration could protect it. Guarded by
-- `test/guards/task-pm-links-unique-index.test.ts`.
--
-- WHY EXCEPTION-CONTAINED RATHER THAN COUNT-THEN-CREATE
-- An earlier design counted violations first and created the index only if clean. That is itself a
-- check-then-act race: `pg:schema` is Railway's preDeployCommand and runs while the OLD app version is
-- still serving and still projecting (pg-load-schema.mjs:8), so a writer can insert a duplicate
-- between the count and the create. Correctness must not depend on a pre-count, and here it does not —
-- there is no count at all.
--
-- WHY THESE THREE `when` CLAUSES AND NO MORE — each traces to a staged failure, not a guess:
--   * unique_violation (23505)   — duplicate data. Verified: escapes an unguarded create and aborts.
--   * lock_not_available (55P03) — pg-load-schema sets lock_timeout (:66-67, default 15s). A
--     non-concurrent CREATE INDEX takes SHARE and must wait out in-flight writes from the old app.
--     VERIFIED on a CLEAN table: the timeout escapes a 23505-only handler, poisons the implicit
--     transaction, and the release aborts with zero dirty data.
--   * deadlock_detected (40P01)  — reachable EARLIER than the timeout: deadlock_timeout defaults to
--     1s, and this transaction has already taken ACCESS EXCLUSIVE locks from earlier
--     `alter table … if not exists` no-ops while the old app still serves. VERIFIED by staging a real
--     cycle: this transaction was chosen victim, 40P01 escaped a two-exception handler, and the
--     release aborted — again with zero dirty data.
--
-- ⛔ NEVER `when others`. If a later edit moves this block ABOVE the `create table if not exists
-- task_pm_links` region in schema.sql, `undefined_table` must be LOUD; a catch-all would convert that
-- ordering bug into a warning and a fleet-wide missing backstop. The narrow list is what keeps that
-- failure visible. `query_canceled` (57014) is deliberately excluded — nothing sets statement_timeout
-- on this path.
--
-- THE CLAIM, STATED NARROWLY: this does NOT "never refuse to deploy" — disk and catalog errors still
-- abort, as they should. What it guarantees is that neither duplicate data, nor expiry of the
-- configured lock_timeout, nor a deadlock can abort a release.
--
-- WHAT A SKIP COSTS, AND WHO NOTICES
-- The two contention skips genuinely self-heal on the next deploy. The DUPLICATE-DATA skip does NOT:
-- nothing in the product cleans an existing duplicate pair, so a violating fleet stays unprotected.
-- An earlier draft stamped `last_error` on the offending rows to surface that; it was withdrawn for
-- two independent reasons — `persistSuccess` nulls `last_error` on every successful projection
-- (lib/pm-sync/project.ts:200), erasing the signal within one push cycle; and the stamping UPDATE sits
-- OUTSIDE the protected CREATE INDEX, on precisely the hot rows the live old app is writing, so a row
-- lock wait would raise from a statement no handler covers and abort the very release it reports on.
-- The signal is READ-side instead: `backstopHealth` in lib/pm-sync/runs.ts validates the index from
-- the catalog at runtime, which cannot be erased, self-clears on repair, and adds no deploy-time write.
do $$
begin
  create unique index if not exists task_pm_links_provider_resource_uq
    on task_pm_links (team_id, provider, provider_resource_id)
    where provider_resource_id is not null;
exception
  when unique_violation then
    raise warning 'ADOPTUNIQ-1: duplicate provider_resource_id present - DB backstop NOT installed; repair the duplicates (this skip does NOT self-heal)';
  when lock_not_available then
    raise warning 'ADOPTUNIQ-1: could not acquire the lock - DB backstop NOT installed; the next deploy retries';
  when deadlock_detected then
    raise warning 'ADOPTUNIQ-1: deadlock while creating the index - DB backstop NOT installed; the next deploy retries';
end $$;
