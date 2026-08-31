-- AIO-1011 / brain-api 1.24 — record WHICH SCANNER BUILD produced each metrics point.
--
-- brain-api 1.22 shipped the coverage denominator and it never arrived. All seven consuming
-- repos fetch the scanner pinned to an exact commit in their own
-- `.github/scripts/fetch-brain-scanner.sh` (a deliberate supply-chain control — that code runs
-- in their CI holding brain credentials), and all seven were pinned to a build from three weeks
-- earlier that had never heard of the new fields. Every scan returned 200. Nothing went red.
-- The dashboard rendered `(scope unknown)` for the entire fleet, permanently, and it was caught
-- by a human looking at a screenshot. Without these columns a scan from a stale scanner and a
-- scan from today's scanner that genuinely had nothing to report are indistinguishable.
--
-- BOTH COLUMNS ARE NULLABLE AND NULL MEANS UNKNOWN — specifically, "predates 1.24". Never
-- "current". `code_metrics` is a time series: every row already in this table has no scanner
-- identity and can never acquire one, so the unknown state is the COMMON state, not an edge
-- case. A DEFAULT of any kind here would assert a build on behalf of a scan that named none —
-- the same class of bug this table already avoids for `test_coverage_score` (null = no report,
-- NOT a measured 0%) and again for the 1.22 denominator.
--
-- Deliberately UNCONSTRAINED beyond a length bound: no CHECK on shape, no regex, no enum. The
-- value is stored verbatim, including a version string the server cannot parse, because
-- provenance matters most when something is wrong with it — and because the wire boundary must
-- never reject a scan over one of these fields. A 422 drops the repo's ENTIRE scan (metrics,
-- findings, contributions, issues) and returns before the ingest run is recorded, so the failure
-- is not even logged. The interpretation ("stale" / "unknown") is a READ-time reading in
-- lib/codebases/scanner-version.ts, not a write-time verdict.
--
-- Mirrored into postgres/schema.sql for a from-zero load, per postgres/migrations/README.md.
-- `schema.sql` expresses this table as `create table if not exists`, so editing its body alone
-- is a silent no-op against every already-deployed brain; the mirror is therefore ALSO written
-- there as `alter table ... add column if not exists`.

alter table if exists code_metrics
  -- The ingestion package version that built the payload (`aios_ingest.__version__`, e.g.
  -- "0.2.0"). ORDERED, and the only input to the staleness reading: it is compared against the
  -- contract's declared `minScannerVersion`.
  add column if not exists scanner_version text,
  -- The aios-team-brain commit the scanner ran from, when knowable. PROVENANCE ONLY — it is what
  -- you need in order to find and bump a stale pin. Never used to compute staleness: commit
  -- identity has no order, means nothing across branches or forks, and stops existing once the
  -- scanner ships from a package index.
  add column if not exists scanner_sha text;

-- Length only. These are wire-supplied strings that become stored text, and the wire contract
-- bounds them at 64; the bound belongs in the database too so a non-conforming client cannot
-- grow the row without limit. Nothing here constrains SHAPE — see the note above on why.
do $$
begin
  alter table code_metrics
    add constraint code_metrics_scanner_identity_len check (
      (scanner_version is null or length(scanner_version) <= 64)
      and (scanner_sha is null or length(scanner_sha) <= 64)
    );
exception
  -- Already applied.
  when duplicate_object then null;
  -- The ADD COLUMNs above use `alter table IF EXISTS`, so this file is written to survive a
  -- database without the table. Without this arm the DO block would abort the whole migration
  -- run on exactly the case the statement above anticipates.
  when undefined_table then null;
end
$$;
