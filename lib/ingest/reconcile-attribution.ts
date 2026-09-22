import "server-only";
import type { DbClient } from "@/lib/db/types";
import { reattributeItems } from "./reattribute";
import type { ReattributeSummary } from "./reattribute";
import { staleArcCache } from "@/lib/graph/arc-cache";
import { evictArcMemoryCache, evictTeamPartitionArcMemory } from "@/lib/graph/arcs";
import { bustTeamTimeline } from "@/lib/dashboard/timeline-cache";
import { completeIdentityRepair, markIdentityRepairRetry } from "@/lib/identity/authority";
import { runSql } from "@/lib/db/pg/pool";

/**
 * Make a re-association PERCOLATE: after an identity mapping changes (or an NL correction is applied),
 * re-point every affected item's `member_id` and refresh the arcs so the change sticks everywhere
 * immediately — not on the manual "Re-attribute content" button + the 4h arc TTL. Lives in
 * `lib/ingest` because `reattributeItems` writes `items` (single-writer guard). Best-effort: never
 * throws (callers run it in `after()`). See docs/design/attribution-propagation.md.
 */

/** Bust a team's DERIVED learning caches so every attribution-dependent surface reflects the change
 *  immediately (not on its own TTL): the narrative arcs AND the work-timeline ledger — both stand on
 *  `items.member_id`. Marks the persistent caches stale (SWR) + evicts this process's in-memory copies.
 *  Best-effort. */
export async function bustTeamLearningCaches(db: DbClient, teamId: string, teamSlug: string): Promise<void> {
  evictArcMemoryCache(teamSlug); // arcs, this process
  await evictTeamPartitionArcMemory(db, teamId); // PPARC-2: g: keys carry only the group id
  await Promise.all([
    staleArcCache(db, teamId), // arcs, persistent
    bustTeamTimeline(db, teamId), // timeline, persistent + in-memory
  ]);
}

/**
 * Privacy-critical counterpart used before source revocation purges. Persistent rows are deleted,
 * not merely marked stale: stale-while-revalidate is allowed to serve a stale row, which is unsafe
 * once its source access has been revoked. Errors propagate so the content remains intact/retryable.
 */
export async function purgeTeamLearningCachesStrict(
  db: DbClient,
  teamId: string,
  teamSlug: string,
): Promise<void> {
  evictArcMemoryCache(teamSlug);
  await bustTeamTimeline(db, teamId); // synchronously evicts this process's Timeline memory first
  const timeline = await db.from("work_timeline_cache").delete().eq("team_id", teamId);
  if (timeline.error) throw new Error(`timeline cache purge failed: ${timeline.error.message}`);
  const arcs = await db.from("arc_cache").delete().eq("team_id", teamId);
  if (arcs.error) throw new Error(`arc cache purge failed: ${arcs.error.message}`);
  await evictTeamPartitionArcMemory(db, teamId);
}

// Per-team trailing-edge coalescer: at most one reattribute scan per team at a time; a call arriving
// mid-run queues exactly ONE trailing pass. This serializes the `items` writes — killing a stale
// identity-map-snapshot race where a slow scan (old map) finishes after a newer one and overwrites its
// re-points — and collapses N rapid mapping edits into ≤2 scans. Per-process state (module-level).
const running = new Set<string>();
const dirty = new Set<string>();

async function runReconcile(db: DbClient, teamId: string, teamSlug: string): Promise<void> {
  try {
    await repairAttributionNow(db, teamId, teamSlug);
  } catch (err) {
    console.error("[attribution] reconcile failed:", err instanceof Error ? err.message : err);
  }
}

/** Strict/manual form. Unlike the background coalescer, failures propagate to the caller while the
 * durable authority row remains pending/retry. Cache invalidation is part of completion. */
export async function repairAttributionNow(
  db: DbClient,
  teamId: string,
  teamSlug: string,
  opts: { maxBatches?: number; batchSize?: number } = {},
): Promise<ReattributeSummary> {
  const maxBatches = Math.max(1, Math.min(100, opts.maxBatches ?? 20));
  let total: ReattributeSummary | null = null;
  for (let batch = 0; batch < maxBatches; batch++) {
    const current = await reattributeItems(db, teamId, { batchSize: opts.batchSize });
    total = total && total.revision === current.revision
      ? {
          ...current,
          scanned: total.scanned + current.scanned,
          updated: total.updated + current.updated,
          versionsUpdated: total.versionsUpdated + current.versionsUpdated,
          contributionsUpdated: total.contributionsUpdated + current.contributionsUpdated,
        }
      : current;
    if (current.partial) continue;
    try {
      await purgeTeamLearningCachesStrict(db, teamId, teamSlug);
      await completeIdentityRepair(teamId, current.revision);
      return total;
    } catch (error) {
      await markIdentityRepairRetry(teamId, current.revision, error).catch(() => {});
      throw error;
    }
  }
  throw new Error("identity repair remains pending after the bounded batch budget");
}

/** Restart backstop for team-wide repairs left pending by a crash or failed background callback. */
export async function drainPendingAttributionRepairs(
  db: DbClient,
  opts: { maxTeams?: number; maxBatchesPerTeam?: number; batchSize?: number } = {},
): Promise<{ attempted:number;complete:number;failed:number }> {
  const maxTeams=Math.max(1,Math.min(100,opts.maxTeams ?? 20));
  const { rows }=await runSql<{ team_id:string;slug:string }>(
    `select a.team_id,t.slug from team_identity_authority a
       join teams t on t.id=a.team_id
      where a.repair_status in ('pending','running','retry','awaiting_cache')
        and (a.next_attempt_at is null or a.next_attempt_at<=now())
      order by a.updated_at,a.team_id limit $1`,
    [maxTeams],
  );
  let complete=0;
  let failed=0;
  for (const row of rows) {
    try {
      await repairAttributionNow(db,row.team_id,row.slug,{
        maxBatches:opts.maxBatchesPerTeam ?? 4,batchSize:opts.batchSize,
      });
      complete++;
    } catch {
      failed++;
    }
  }
  return { attempted:rows.length,complete,failed };
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
