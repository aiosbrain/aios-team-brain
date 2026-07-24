-- Durable tier-reclassification cleanup for the graph seam (Pass-1 review B2). When an item's access
-- tier changes, its episodes must be deleted from the OLD Graphiti group before the new-group push, or
-- an external principal keeps reading the now-internal facts (no RLS backstop). The projector's inline
-- delete is best-effort and can silently fail (a swallowed Graphiti error) or miss a chunk the async
-- worker created AFTER the delete — and once the ledger row flips `group_id` to the new group, nothing
-- ever retries, leaving the old tier searchable FOREVER.
--
-- This column decouples "which group is authoritative now" (`group_id`) from "an old group still needs
-- purging" (`pending_delete_group_id`): the projector records the old group here on every tier change,
-- and `lib/graph/reconcile` retries the delete each pass until the old group is verified empty, then
-- clears it. See lib/graph/project.ts + lib/graph/reconcile.ts.
--
-- REPLAY-SAFE: nullable, no default, no backfill — every rollout (and from-zero) is a plain add-column
-- no-op after the first. Mirrored into postgres/schema.sql for the from-zero path.
alter table graph_episodes add column if not exists pending_delete_group_id text;

-- Reconcile scans for rows needing cleanup; a partial index keeps that scan cheap (the column is null
-- for all but the handful of rows in mid-reclassification).
create index if not exists graph_episodes_pending_delete_idx
  on graph_episodes (team_id)
  where pending_delete_group_id is not null;
