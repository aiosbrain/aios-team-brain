import "server-only";
import type { DbClient } from "@/lib/db/types";
import { reattributeItems } from "./reattribute";
import { staleArcCache } from "@/lib/graph/arc-cache";
import { evictArcMemoryCache } from "@/lib/graph/arcs";
import { bustTeamTimeline } from "@/lib/dashboard/timeline-cache";

/**
 * Make a re-association PERCOLATE: after an identity mapping changes (or an NL correction is applied),
 * re-point every affected item's `member_id` and refresh the arcs so the change sticks everywhere
 * immediately — not on the manual "Re-attribute content" button + the 10-min arc TTL. Lives in
 * `lib/ingest` because `reattributeItems` writes `items` (single-writer guard). Best-effort: never
 * throws (callers run it in `after()`). See docs/design/attribution-propagation.md.
 */

/** Bust a team's DERIVED learning caches so every attribution-dependent surface reflects the change
 *  immediately (not on its own TTL): the narrative arcs AND the work-timeline ledger — both stand on
 *  `items.member_id`. Marks the persistent caches stale (SWR) + evicts this process's in-memory copies.
 *  Best-effort. */
export async function bustTeamLearningCaches(db: DbClient, teamId: string, teamSlug: string): Promise<void> {
  evictArcMemoryCache(teamSlug); // arcs, this process
  await Promise.all([
    staleArcCache(db, teamId), // arcs, persistent
    bustTeamTimeline(db, teamId), // timeline, persistent + in-memory
  ]);
}

// Per-team trailing-edge coalescer: at most one reattribute scan per team at a time; a call arriving
// mid-run queues exactly ONE trailing pass. This serializes the `items` writes — killing a stale
// identity-map-snapshot race where a slow scan (old map) finishes after a newer one and overwrites its
// re-points — and collapses N rapid mapping edits into ≤2 scans. Per-process state (module-level).
const running = new Set<string>();
const dirty = new Set<string>();

async function runReconcile(db: DbClient, teamId: string, teamSlug: string): Promise<void> {
  try {
    await reattributeItems(db, teamId); // re-point member_id from current mappings (skips locked rows)
    await bustTeamLearningCaches(db, teamId, teamSlug);
  } catch (err) {
    console.error("[attribution] reconcile failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Re-attribute all of a team's items from current identity mappings + refresh arcs. Coalesced per team.
 * Run in `after()` from the association-changing admin actions (identity link/unlink, email add/remove,
 * github link). NOT for the NL correction box — that already re-pointed `member_id` directly, so it only
 * needs `bustTeamLearningCaches` (re-running reattribute there would fight the correction).
 */
export async function reconcileAttribution(db: DbClient, teamId: string, teamSlug: string): Promise<void> {
  if (running.has(teamId)) {
    dirty.add(teamId); // a pass is in flight → fold into one trailing pass
    return;
  }
  running.add(teamId);
  try {
    await runReconcile(db, teamId, teamSlug);
    while (dirty.has(teamId)) {
      dirty.delete(teamId);
      await runReconcile(db, teamId, teamSlug);
    }
  } finally {
    running.delete(teamId);
  }
}
