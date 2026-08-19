-- ENFB-1 §2.7 (docs/design/enfb1-body-surfaces-oracle-gate.md): decision creation provenance.
-- Written ONLY by the dashboard create action (app/actions/decisions.ts) — sync/ingest writers
-- never set it, which is what makes a non-null value PROOF of a hand-typed row (the same
-- sole-writer shape as tasks.created_by). Re-admits null-source dashboard decisions to the
-- enforced read surfaces without reviving the purged-restricted-basis leak class.
-- Additive + replay-safe (`if not exists`); measured before shipping: prod held ZERO
-- null-source decisions, so no backfill question exists.
alter table decisions add column if not exists created_by uuid references members(id) on delete set null;
