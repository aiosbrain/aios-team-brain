-- AIO-672 — Context Engineering Health scan summary on the AEM individual snapshot
-- (brain-api document revision 1.11; the workspace producer has shipped since then,
-- this is the brain catching up). Provenance-only: `aios analyze --push` computes it
-- client-side and the brain persists it VERBATIM — it is never recomputed here and
-- never feeds placement().
--
-- PRIVACY: scalars only. The pushed object is {score, mode, drift_count,
-- versions_behind, coverage_pct, broken_link_count, checked_at} — no file paths, no
-- filenames, no check `detail` strings ever cross the boundary.
--
-- context_health_score mirrors ce_band's shape (nullable smallint, 0-4, no default) so
-- team rollups can average it without unpacking jsonb; null means "no scan yet / older
-- client", which is distinct from a measured 0. context_health carries the full summary.
-- Additive + idempotent; mirrored into postgres/schema.sql for from-zero loads.
alter table agentic_maturity_snapshots
  add column if not exists context_health_score smallint
  check (context_health_score is null or context_health_score between 0 and 4);
alter table agentic_maturity_snapshots
  add column if not exists context_health jsonb;
