-- AIO-995 / brain-api 1.22 — give `test_coverage_pct` a denominator, and make a degraded
-- test run announce itself.
--
-- `test_coverage_pct` is a bare percentage. A report measuring 436 lines and one measuring
-- 10,647 lines produce the same shape of number, yet coverage carries 40% of `health_score`
-- and 25% of `agentic_score` — so the two are indistinguishable in every composite. These
-- columns carry the scope the percentage was measured over, and whether the run that produced
-- it was complete.
--
-- EVERY COLUMN IS NULLABLE ON PURPOSE. `code_metrics` is a time series: every row written
-- before 1.22 has no denominator and no way to acquire one retroactively, and a scanner that
-- predates 1.22 keeps sending payloads without these fields. NULL therefore means UNKNOWN —
-- never zero, and never "fully covered". A DEFAULT 0 here would have been the same bug this
-- table already fixed once for `test_coverage_score` (null = no report, NOT a measured 0%).
--
-- Mirrored into postgres/schema.sql for a from-zero load, per postgres/migrations/README.md.
-- `schema.sql` expresses this table as `create table if not exists`, so editing its body alone
-- is a silent no-op against every already-deployed brain.

alter table if exists code_metrics
  -- Coverage denominator: instrumented lines the report actually measured, and how many were
  -- hit. Both formats the scanner reads carry them natively (Istanbul json-summary
  -- `total.lines.total`/`.covered`; lcov `LF:`/`LH:` sums), so no new tooling is implied.
  add column if not exists test_coverage_lines_total integer,
  add column if not exists test_coverage_lines_covered integer,
  -- Run integrity: a suite that skipped half its cases still emits a plausible coverage
  -- percentage. On aios-devtools a single missing env var skipped 91 of 229 tests and moved
  -- coverage 29 points with nothing going red.
  add column if not exists tests_total integer,
  add column if not exists tests_passed integer,
  add column if not exists tests_skipped integer,
  add column if not exists tests_failed integer,
  -- Brain-derived (lib/codebases/score.ts): 100 * min(1, test_coverage_lines_total / loc) —
  -- coverage's scope as a share of the repository's counted lines. Null whenever either input
  -- is unknown. Persisted like every other derived score in this table so the dashboard and
  -- the trend series can read it without re-deriving.
  add column if not exists coverage_breadth_pct numeric(5, 2);

-- Non-negativity, added separately so a re-run against a DB that already has them is a no-op.
-- `not valid` is deliberately NOT used: the columns are new, so every existing row is NULL and
-- passes trivially, and a validated constraint rejects a bad write from the first one.
do $$
begin
  alter table code_metrics
    add constraint code_metrics_coverage_denominator_nonneg check (
      (test_coverage_lines_total is null or test_coverage_lines_total >= 0)
      and (test_coverage_lines_covered is null or test_coverage_lines_covered >= 0)
      and (tests_total is null or tests_total >= 0)
      and (tests_passed is null or tests_passed >= 0)
      and (tests_skipped is null or tests_skipped >= 0)
      and (tests_failed is null or tests_failed >= 0)
    );
exception
  -- Already applied.
  when duplicate_object then null;
  -- The ADD COLUMNs above use `alter table IF EXISTS`, so this file is explicitly written to
  -- survive a database without the table. Without this arm the DO block would abort the whole
  -- migration run on exactly the case the statement above anticipates.
  when undefined_table then null;
end
$$;
