-- brain-api v1.3: optional shadow Cognitive-Ergonomics band on AEM individual snapshots.
-- Nullable, NO default — null means "insufficient baseline / older client", distinct from 0.
-- Provenance-only: the brain persists it verbatim and never recomputes it (never feeds
-- placement()). Also mirrored into postgres/schema.sql for from-zero replay.
alter table agentic_maturity_snapshots
  add column if not exists ce_band smallint
  check (ce_band is null or ce_band between 0 and 4);
