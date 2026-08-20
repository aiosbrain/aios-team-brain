-- EXCLSHADOW-1: widen project_context_memberships' method CHECK to admit
-- 'exclude_shadow_repair' — the include reconcile writes when it closes an AUTOMATIC
-- exclude found in the item's target SYSTEM project (the exclude-shadow repair; the method
-- value is how a repair stays legible in the table's own history).
--
-- WIDENING, so the #251 replay-narrowing class does not apply: every value the live data can
-- hold is in the new list. Named drop-and-re-add (the repo's replay-repairable constraint
-- pattern): idempotent on replay — the drop tolerates absence, the add re-creates the same
-- constraint, and re-running the file converges to the identical end state.
alter table project_context_memberships
  drop constraint if exists project_context_memberships_method_check;
alter table project_context_memberships
  add constraint project_context_memberships_method_check
  check (method in ('ingestion_project','explicit_ref','rule','embedding','llm','manual','exclude_shadow_repair'));
