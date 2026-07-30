-- AIO-609 — workspace-governance health snapshot on the metrics point (brain-api
-- document revision 1.15). Provenance-only: the scanner scores it against the
-- workspace rubric and the brain persists the closed scalar object VERBATIM
-- ({schema_version, rubric_version, head_sha, score_pct, status, dimensions,
--   failed_invariant_ids, measured_at}); null = the scan carried no health object.
-- Additive + idempotent; mirrored into postgres/schema.sql for from-zero loads.
alter table code_metrics add column if not exists codebase_health jsonb;
