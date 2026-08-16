-- PPARC-3 (design docs/design/per-project-arcs.md §2.3; moved here from PPARC-2 per its Fable
-- review — re-keying while the p: union still served AND still wrote p: corrections opened an
-- H13 revert window; this slice cuts reads over in the same deploy):
--   1. SINGLE-group `p:` correction rows re-key losslessly to the partition namespace (their
--      derivation scope WAS that partition; group ids carry no ',' by construction).
--   2. MULTI-group rows cannot be attributed to one partition: KEPT `p:`-keyed (human data is
--      never deleted), unread after the cutover, and their count is REPORTED below (visible in
--      the deploy log via the pg-load-schema notice listener that ships with this migration —
--      node-pg discards notices unheard).
--   3. PRE-CUTOVER `g:` cache rows are WIPED (Codex PPARC-2 High 2): rows warmed before this
--      migration were synthesized against g:-scoped corrections that did not exist yet — a
--      re-keyed correction would sit unheard behind a fresh row for a TTL. The wipe is
--      bounded by a DEPLOYMENT-RELATIVE MARKER so replay converges on EVERY instance (Fable
--      PPARC-3 High 3: an unbounded predicate re-wiped the cache per deploy; Codex PPARC-3
--      High 2: a source-code date is wrong for a self-host that warmed g: rows between taking
--      PPARC-2 and PPARC-3 — their pre-cutover rows would postdate any literal). The marker is
--      stamped at this migration's FIRST run on the instance; rows computed before it are
--      pre-cutover BY DEFINITION, rows after it survive replay.
-- Idempotent: re-keyed rows stop matching; the marker never restamps; the wipe converges.
update arc_corrections
   set group_key = 'g:' || substr(group_key, length('p:' || team_id || ':') + 1)
 where group_key like 'p:' || team_id || ':%'
   and position(',' in substr(group_key, length('p:' || team_id || ':') + 1)) = 0;
create table if not exists migration_markers (
  name text primary key,
  at timestamptz not null default now()
);
insert into migration_markers (name) values ('pparc3_g_wipe') on conflict (name) do nothing;
delete from arc_cache
 where group_key like 'g:%'
   and computed_at < (select at from migration_markers where name = 'pparc3_g_wipe');
do $$
declare stranded int;
begin
  select count(*) into stranded from arc_corrections where group_key like 'p:%';
  raise notice 'PPARC-3 corrections re-scope: % multi-group p: row(s) kept (cannot attribute to one partition)', stranded;
end $$;
