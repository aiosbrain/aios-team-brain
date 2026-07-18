-- Audit #5: a double-submit race (check-then-act on variant.status with no DB backstop) could create
-- TWO active publications for one variant → two live posts. Enforce at most ONE active
-- (scheduled/publishing) publication per variant with a partial unique index — the second concurrent
-- createPublication insert then fails atomically, closing the race across processes (not just the
-- in-process poller). Cancelled/failed/published rows are unconstrained, so a variant can be
-- re-scheduled after a cancel. Idempotent; mirrored into schema.sql for from-zero.
create unique index if not exists social_publications_active_variant_idx
  on social_publications (variant_id)
  where status in ('scheduled', 'publishing');
