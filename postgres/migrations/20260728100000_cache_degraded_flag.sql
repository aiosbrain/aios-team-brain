-- Persist "this cached payload is untrustworthy" as its own column, so `computed_at` can go back to
-- meaning ONLY "when was this computed" (Pass-1 review R2/M6, follow-up to PR #426).
--
-- Until now `arc_cache.computed_at` carried two meanings at once. `writeArcCache` BACKDATED it — by
-- `TTL - 5min` — for a synthesis it didn't trust, purely to make the row go stale sooner so the next view
-- retries. That worked, but it meant a degraded row reported a computation time ~4 hours before the
-- computation actually happened, and the freshness envelope (#426) had no choice but to publish that lie.
-- The trust dial gets its own column; the retry behaviour is preserved exactly by deriving a SHORTER TTL
-- from `degraded` instead of falsifying the timestamp (see `arcTtlMs` in lib/graph/arc-cache.ts).
--
-- Additive and idempotent. `default false` is the safe reading for pre-existing rows: it says "we have no
-- evidence this is degraded", not "this is verified good". Rows written before this migration keep their
-- backdated `computed_at`, so they simply read as stale and refresh on the next view — self-healing, no
-- backfill needed. Deliberately NO check constraint (see the migration-replay incident: a re-added CHECK
-- narrower than live data fails the deploy).
alter table arc_cache add column if not exists degraded boolean not null default false;
alter table work_timeline_cache add column if not exists degraded boolean not null default false;
