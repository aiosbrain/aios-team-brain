-- brain-api v1.11: optional context-health scan summary on AEM individual snapshots.
-- context_health_score mirrors ce_band's shape (nullable smallint, 0-4, no default — null
-- means "no scan yet / older client", distinct from 0). context_health is the full scalar
-- summary object (score, mode, drift_count, versions_behind, coverage_pct, broken_link_count,
-- checked_at) — scalars only, never content/paths. Provenance-only: the brain persists it
-- verbatim and never recomputes it (never feeds placement()). Also mirrored into
-- postgres/schema.sql for from-zero replay.
alter table agentic_maturity_snapshots
  add column if not exists context_health_score smallint
  check (context_health_score is null or context_health_score between 0 and 4);
alter table agentic_maturity_snapshots
  add column if not exists context_health jsonb;
