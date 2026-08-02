-- test_coverage_score: "no coverage report" is null, not 0.
--
-- The column was `not null default 0`, so a repo that never filed a coverage report was stored
-- as a measured 0% — indistinguishable from a repo whose suite genuinely covers nothing. Since
-- coverage carries 40% of health_score and 25% of agentic_score, "we don't know" cost up to 40
-- points of health.
--
-- That hit every scaffolded workspace: they are content repos with no test suite, and
-- `coverage/` is gitignored so no clone can supply an artifact. `test_coverage_pct` alongside it
-- has always been nullable with exactly this meaning; the derived score simply failed to follow.
--
-- lib/codebases/score.ts now returns null and renormalizes the composites over the components
-- that actually reported.
--
-- Existing rows are deliberately NOT backfilled to null: a stored 0 is ambiguous (it could be a
-- real 0%), and the next scan rewrites the row anyway — the upsert replaces on
-- (codebase_id, head_sha). Guessing history would be worse than letting it age out.

alter table code_metrics
  alter column test_coverage_score drop not null,
  alter column test_coverage_score drop default;
