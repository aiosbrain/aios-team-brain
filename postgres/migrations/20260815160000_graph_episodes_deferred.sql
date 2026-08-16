-- PCCC-5 (docs/design/phase-c-per-project-graphs.md §2.2/§2.5): the DEFERRED projection state.
-- A fan-out row for a cold initiative is bookkeeping, not work: `deferred = true` means "this
-- (item, group) pair is known but extraction is deliberately withheld until a reader arms the
-- project" — distinct BY DESIGN from the '' sentinel, which already means three things
-- (re-queued / redacted / retired) and which reconcile's never-landed delete acts on. Deferred
-- rows are exempt from that judgement (they never pushed; deleting them would re-create them
-- next pass, a pure churn loop). Arming (PCCC-6) flips deferred -> false; the projector then
-- pushes under its fan-out budget.
alter table graph_episodes add column if not exists deferred boolean not null default false;
