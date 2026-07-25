import "server-only";
import type { DbClient } from "@/lib/db/types";
import { adminClient } from "@/lib/db/admin";
import { GraphitiClient } from "./graphiti-client";
import { projectItemsToGraph } from "./project";
import { reconcileProjectedEpisodes } from "./reconcile";
import { purgeExternalTierCaches } from "@/lib/cache/tier-invalidation";

/**
 * Graph-projection runner — the on-ramp that actually drives `projectSlackToGraph` (which is
 * otherwise just a library function nobody calls). Mirrors `lib/ingest/run.ts`: resolve the
 * team(s), then project each. Two callers: the admin "Project to graph" action (on-demand) and
 * `lib/graph/scheduler.ts` (interval). Inert when Graphiti isn't configured (no GRAPHITI_URL) — it
 * returns a clean `configured:false` skip instead of throwing, so prod (where the graph is off)
 * is a cheap no-op.
 */

export interface GraphProjectionSummary {
  ok: boolean;
  /** Whether GRAPHITI_URL is set. When false nothing ran — the rest are zero. */
  configured: boolean;
  teams: number;
  scanned: number;
  projected: number;
  skipped: number;
  /** Episodes confirmed to have actually landed in Graphiti this run (audit H3 reconcile pass). */
  reconciled: number;
  /** Episodes recorded as projected but never found in Graphiti — cleared so the next run
   * re-pushes them (a worker crash between accept and extraction; audit H3). */
  requeued: number;
  /** Tier-reclassified items whose OLD-group cleanup was verified complete this run (B2). */
  cleaned: number;
  /** Tier cleanups STILL outstanding across all teams after this run (B2). This is the number that
   * matters: while it is non-zero, old-tier episodes are purgeable-but-unpurged — a tier-isolation
   * signal, not bookkeeping. A count that never returns to 0 means the cleanup is stuck (a saturated
   * group scan, or Graphiti persistently refusing the delete), which the code deliberately produces
   * instead of falsely clearing the flag — so it has to be visible. */
  pendingCleanups: number;
  /** Graphiti groups that have outgrown the reconcile scan window, so their landed-check was skipped
   * this run. Non-zero means self-healing has quietly stopped for those groups — surfaced rather than
   * swallowed, per the no-silent-caps rule (raise `GRAPH_LANDED_SCAN_DEPTH`). */
  saturatedGroups: number;
  errors: string[];
}

// Per-batch scan size (episodes are LLM-extracted on Graphiti's side, so each batch stays bounded).
// The runner pages through the whole backlog batch-by-batch via a synced_at cursor (audit H2), so a
// corpus larger than one batch is fully projected instead of stalling on the oldest `limit` rows.
const DEFAULT_LIMIT = Number(process.env.GRAPH_PROJECT_LIMIT ?? 500);
// Safety bound so a runaway (e.g. clock skew re-scanning a tied synced_at) can't loop forever.
const MAX_BATCHES = Number(process.env.GRAPH_PROJECT_MAX_BATCHES ?? 200);

async function resolveTeams(
  db: DbClient,
  teamId?: string
): Promise<{ id: string; slug: string }[]> {
  let q = db.from("teams").select("id, slug");
  if (teamId) q = q.eq("id", teamId);
  const { data, error } = await q;
  if (error) throw new Error(`graph projection: load teams failed: ${error.message}`);
  return (data ?? []) as { id: string; slug: string }[];
}

// Single-flight guard (audit MEDIUM): the interval scheduler and the admin "Project to graph" action
// both call this. Without it, two concurrent runs hit the check-then-act in project.ts (no episode
// row yet → both push) and duplicate episodes in Graphiti. In-process only — one brain instance.
let inFlight: Promise<GraphProjectionSummary> | null = null;

export async function runGraphProjection(opts?: {
  teamId?: string;
  client?: GraphitiClient;
  db?: DbClient;
  limit?: number;
}): Promise<GraphProjectionSummary> {
  if (inFlight) return inFlight;
  inFlight = runGraphProjectionInner(opts);
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

async function runGraphProjectionInner(opts?: {
  teamId?: string;
  client?: GraphitiClient;
  db?: DbClient;
  limit?: number;
}): Promise<GraphProjectionSummary> {
  const client = opts?.client ?? new GraphitiClient();
  const summary: GraphProjectionSummary = {
    ok: true,
    configured: client.configured,
    teams: 0,
    scanned: 0,
    projected: 0,
    skipped: 0,
    reconciled: 0,
    requeued: 0,
    cleaned: 0,
    pendingCleanups: 0,
    saturatedGroups: 0,
    errors: [],
  };
  if (!client.configured) return summary; // nowhere to project — skip cleanly

  const db = opts?.db ?? adminClient();
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const teams = await resolveTeams(db, opts?.teamId);
  summary.teams = teams.length;

  for (const t of teams) {
    try {
      // Page forward through this team's whole backlog: advance the `since` cursor by the last
      // synced_at scanned until a batch comes back short (fewer rows than the limit = tail reached).
      // MAX_BATCHES caps the loop as a runaway guard. (audit H2)
      let since: string | undefined;
      let tierMoved = 0;
      for (let batch = 0; batch < MAX_BATCHES; batch++) {
        const s = await projectItemsToGraph(db, {
          teamId: t.id,
          teamSlug: t.slug,
          client,
          limit,
          since,
        });
        summary.scanned += s.scanned;
        summary.projected += s.projected;
        summary.skipped += s.skipped;
        tierMoved += s.tierChanges;
        if (s.scanned < limit || !s.lastSyncedAt || s.lastSyncedAt === since) break;
        since = s.lastSyncedAt;
      }

      // Reconcile after paging (audit H3, Option B): confirm this team's recorded episodes actually
      // landed, and re-queue any that a crashed worker never got to. Off the hot push path.
      const r = await reconcileProjectedEpisodes(db, client, t.id);
      summary.reconciled += r.confirmed;
      summary.requeued += r.reQueued;
      summary.cleaned += r.cleaned;
      summary.pendingCleanups += r.pendingCleanups;
      summary.saturatedGroups += r.saturatedGroups;

      // A reclassification only finishes leaving the graph HERE. `lib/ingest` purged the external-tier
      // caches when it healed `items.access`, but arcs are synthesized from the external Graphiti group,
      // which is only cleaned by the projection/cleanup above — so any arc rebuild in between re-read the
      // old-tier facts and `commitArcs` stamped that result FRESH for a full TTL. Purge again now that
      // the group is actually clean; this is the call that closes the window (and mops up an SWR rebuild
      // that was already in flight when ingest purged).
      if (tierMoved || r.cleaned) {
        await purgeExternalTierCaches(db, t.id, t.slug);
      }
    } catch (e) {
      summary.ok = false;
      summary.errors.push(`${t.slug}: ${e instanceof Error ? e.message : "projection failed"}`);
    }
  }
  return summary;
}
