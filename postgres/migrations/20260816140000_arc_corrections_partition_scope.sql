-- PPARC-2 (design docs/design/per-project-arcs.md §2.3): corrections re-scope from the per-oracle
-- `p:<teamId>:<sorted groups>` namespace to the partition-native `g:<group_id>` namespace.
-- A SINGLE-group `p:` scope re-keys losslessly (its derivation scope WAS that partition — the
-- group segment carries no ',' by construction). A MULTI-group scope cannot be attributed to one
-- partition: those rows are KEPT `p:`-keyed (human data is never deleted), feed nothing after the
-- PPARC-3 cutover retires the union read, and their count is REPORTED here rather than silently
-- stranded (design falsifier: expected 0 in this deployment — 0 enforcing teams pre-PPARC).
-- Idempotent: re-keyed rows no longer match the predicate; the DO block re-reports on replay.
update arc_corrections
   set group_key = 'g:' || substr(group_key, length('p:' || team_id || ':') + 1)
 where group_key like 'p:' || team_id || ':%'
   and position(',' in substr(group_key, length('p:' || team_id || ':') + 1)) = 0;
do $$
declare stranded int;
begin
  select count(*) into stranded from arc_corrections where group_key like 'p:%';
  raise notice 'PPARC-2 corrections re-scope: % multi-group p: row(s) kept (cannot attribute to one partition)', stranded;
end $$;
