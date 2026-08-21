import "server-only";
import type { DbClient } from "@/lib/db/types";
import { adminClient } from "@/lib/db/admin";
import { acquireProjectionLease, type ProjectionLease } from "./walk-lock";
import { GraphitiClient } from "./graphiti-client";
import { projectItemsToGraph, ProjectionAbortError, FANOUT_PUSH_MAX_PER_PASS } from "./project";
import { boundPartialDetail, PARTIAL_DETAIL_LIMIT } from "./landed-state";
import { reconcileProjectedEpisodes, deepRequeueEnabledFromEnv, boundDeepRequeueSample, type DeepRequeueRef, type ReconcileOptions } from "./reconcile";
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
  /** EPISODES pushed (an item chunks into 1..16) — the unit extraction actually costs per. */
  episodes: number;
  /** `episodes` split by target group (PCCC-3) — the per-partition cost substrate, recorded
   * append-only into `ingest_runs.meta`. Row counts in `graph_episodes` cannot serve: a row is one
   * ITEM, not one episode, and `projected_at` is mutable. */
  episodesByGroup: Record<string, number>;
  /** Armed fan-out pushes withheld by the per-pass budget (PCCC-5) — the no-silent-caps signal. */
  fanoutThrottled: number;
  /** Restriction moves in flight (home Everyone-visible, copy unlanded) — rule-2 exposure, PCCC-6. */
  restrictionMovesPending: number;
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
  /** RECONCILE-1 measurement — items with some chunks present and some missing. Counted, not acted on. */
  partialItems: number;
  /** The BOUNDED missing-name sample, carried through to `ingest_runs.meta`. Without it the count
   *  alone cannot tell a real tail hole from an index-shift false positive (an edited doc re-chunks,
   *  so an expected `#k` may never have existed) — which is the entire question the metric exists to
   *  answer. Review found this dropped between reconcile and the durable row. */
  partialDetail: { sample: { itemId: string; missing: string[]; missingCount: number }[]; elided: number; namesElided: number };
  /** Ledger rows a pass declined to re-queue because too many looked absent at once — the signal that
   * Graphiti is wedged rather than that N workers crashed. Non-zero for several runs in a row is an
   * incident, not noise. */
  requeueThrottled: number;
  /** TICKFIT-2: pages whose batched ledger read failed and fell back to per-item probes —
   *  durably visible (the recording gate keys on it) so a permanently failing batch read can
   *  never silently re-become the 10.5-minute stage. */
  probeFallbackPages: number;
  /** GRAPHSAT-1: groups past the REST window JUDGED via the per-item Neo4j lookup (meta; a gate
   *  signal only while `deepRequeueEnabled` is false — measurement mode is loud). */
  deepResolvedGroups: number;
  /** GRAPHSAT-1: never-landed rows on the lookup path HELD because re-queue is off. Always a gate
   *  signal. `deepRequeueSample` is re-bounded across teams, oldest first. */
  deepRequeueHeld: number;
  deepRequeueHeldByGroup: Record<string, number>;
  deepRequeueSample: DeepRequeueRef[];
  /** The re-queue mode this run EXECUTED (resolved ONCE here from `GRAPH_DEEP_REQUEUE === "true"`, or
   *  the injected option) — the recording gate reads it from the summary, never from the env. */
  deepRequeueEnabled: boolean;
  /** TICKFIT-2 (Codex diff review H1): teams SKIPPED this run because another brain instance holds
   *  their projection lease (`lib/graph/walk-lock.ts` — a deploy overlap). Expected once per deploy;
   *  persistent across runs means a wedged holder. Durably visible (meta + the recording gate). */
  lockedOut: number;
  /** TICKFIT-2: per-leg wall time (flat numbers — the runs panel Strings values). `walkMs` is
   *  the page loop; `reconcileMs` the reconcile call; summed across teams, accumulated in
   *  finally so failed legs keep their elapsed time. The revisit trigger reads walkMs. */
  walkMs: number;
  reconcileMs: number;
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
  /** Per-team fan-out budget for this RUN (default GRAPH_FANOUT_PUSH_MAX_PER_PASS); test override. */
  fanoutPushBudget?: number;
  /** Cross-instance lease acquirer (default: the Postgres advisory lease); test override. */
  lease?: (teamId: string) => Promise<ProjectionLease | null>;
  /** GRAPHSAT-1 test seams: the per-item lookup and the re-queue mode (default: env `GRAPH_DEEP_REQUEUE === "true"`). */
  lookup?: ReconcileOptions["lookup"];
  deepRequeue?: boolean;
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
  fanoutPushBudget?: number;
  lease?: (teamId: string) => Promise<ProjectionLease | null>;
  /** GRAPHSAT-1 test seams: the per-item lookup and the re-queue mode (default: env `GRAPH_DEEP_REQUEUE === "true"`). */
  lookup?: ReconcileOptions["lookup"];
  deepRequeue?: boolean;
}): Promise<GraphProjectionSummary> {
  const client = opts?.client ?? new GraphitiClient();
  const acquireLease = opts?.lease ?? acquireProjectionLease;
  const summary: GraphProjectionSummary = {
    ok: true,
    configured: client.configured,
    teams: 0,
    scanned: 0,
    projected: 0,
    episodes: 0,
    episodesByGroup: {},
    fanoutThrottled: 0,
    restrictionMovesPending: 0,
    skipped: 0,
    reconciled: 0,
    requeued: 0,
    cleaned: 0,
    pendingCleanups: 0,
    saturatedGroups: 0,
    partialItems: 0,
    partialDetail: { sample: [], elided: 0, namesElided: 0 },
    requeueThrottled: 0,
    probeFallbackPages: 0,
    deepResolvedGroups: 0,
    deepRequeueHeld: 0,
    deepRequeueHeldByGroup: {},
    deepRequeueSample: [],
    deepRequeueEnabled: opts?.deepRequeue ?? deepRequeueEnabledFromEnv(),
    lockedOut: 0,
    walkMs: 0,
    reconcileMs: 0,
    errors: [],
  };
  if (!client.configured) return summary; // nowhere to project — skip cleanly

  const db = opts?.db ?? adminClient();
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const teams = await resolveTeams(db, opts?.teamId);
  summary.teams = teams.length;

  for (const t of teams) {
    // TICKFIT-2 (Codex diff review H1): one instance per team per pass. The in-process `inFlight`
    // above cannot see a deploy-overlap twin, and two walkers over the same unconverged page both
    // push (the `''` reservation reads as "re-push" by design). A locked-out team is skipped THIS
    // tick and counted, never silently; the lease dies with the holder's backend.
    let lease: ProjectionLease | null = null;
    try {
      lease = await acquireLease(t.id);
    } catch (e) {
      summary.ok = false;
      summary.errors.push(`${t.slug}: projection lease failed: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (!lease) {
      summary.lockedOut += 1;
      continue;
    }
    try {
      // Page forward through this team's whole backlog: advance the `since` cursor by the last
      // synced_at scanned until a batch comes back short (fewer rows than the limit = tail reached).
      // MAX_BATCHES caps the loop as a runaway guard. (audit H2)
      let since: string | undefined;
      let externalVacated = 0;
      // ONE fan-out budget per team per RUN, threaded across the batch loop (PCCC-5 review High 1):
      // the per-call default alone resets every page — up to MAX_BATCHES× the claimed cap, executing
      // most of a mass arming at once, which is exactly what the budget exists to smooth. Same seam
      // GRAPH_REQUEUE_MAX_PER_PASS's comment names for reconcile.
      let fanoutBudgetLeft = opts?.fanoutPushBudget ?? FANOUT_PUSH_MAX_PER_PASS;
      // TICKFIT-2: the walk leg's clock — accumulated in finally so an aborted walk keeps its
      // elapsed time (the revisit trigger reads this number).
      const walkStart = Date.now();
      try {
      for (let batch = 0; batch < MAX_BATCHES; batch++) {
        const s = await projectItemsToGraph(db, {
          teamId: t.id,
          teamSlug: t.slug,
          client,
          limit,
          since,
          fanoutPushBudget: fanoutBudgetLeft,
        });
        fanoutBudgetLeft = Math.max(0, fanoutBudgetLeft - s.fanoutPushed);
        summary.probeFallbackPages += s.probeFallbackPages;
        summary.scanned += s.scanned;
        summary.projected += s.projected;
        summary.episodes += s.episodes;
        for (const [g, n] of Object.entries(s.episodesByGroup)) {
          summary.episodesByGroup[g] = (summary.episodesByGroup[g] ?? 0) + n;
        }
        summary.skipped += s.skipped;
        summary.fanoutThrottled += s.fanoutThrottled;
        summary.restrictionMovesPending += s.restrictionMovesPending;
        externalVacated += s.externalGroupVacated;
        if (s.scanned < limit || !s.lastSyncedAt || s.lastSyncedAt === since) break;
        since = s.lastSyncedAt;
      }
      } finally {
        summary.walkMs += Date.now() - walkStart;
      }

      // Reconcile after paging (audit H3, Option B): confirm this team's recorded episodes actually
      // landed, and re-queue any that a crashed worker never got to. Off the hot push path.
      const reconcileStart = Date.now();
      let r: Awaited<ReturnType<typeof reconcileProjectedEpisodes>>;
      try {
        r = await reconcileProjectedEpisodes(db, client, t.id, {
          lookup: opts?.lookup,
          deepRequeue: summary.deepRequeueEnabled,
        });
      } finally {
        summary.reconcileMs += Date.now() - reconcileStart;
      }
      summary.reconciled += r.confirmed;
      summary.requeued += r.reQueued;
      summary.cleaned += r.cleaned;
      summary.pendingCleanups += r.pendingCleanups;
      summary.saturatedGroups += r.saturatedGroups;
      summary.partialItems += r.partialItems;
      // Merge across teams and RE-BOUND: each team's sample is already capped, but N teams would
      // otherwise multiply the blob by N.
      summary.partialDetail = boundPartialDetail(
        [...summary.partialDetail.sample, ...r.partialDetail.sample],
        PARTIAL_DETAIL_LIMIT
      );
      summary.partialDetail.elided += r.partialDetail.elided;
      summary.partialDetail.namesElided += r.partialDetail.namesElided;
      summary.requeueThrottled += r.requeueThrottled;
      // GRAPHSAT-1: merge, then RE-BOUND the held sample across teams (oldest first) — the same rule
      // as partialDetail, so N teams cannot multiply the blob.
      summary.deepResolvedGroups += r.deepResolvedGroups;
      summary.deepRequeueHeld += r.deepRequeueHeld;
      for (const [g, n] of Object.entries(r.deepRequeueHeldByGroup)) {
        summary.deepRequeueHeldByGroup[g] = (summary.deepRequeueHeldByGroup[g] ?? 0) + n;
      }
      summary.deepRequeueSample = boundDeepRequeueSample([...summary.deepRequeueSample, ...r.deepRequeueSample]);

      // A NARROWING only finishes leaving the graph HERE. `lib/ingest` purged the external-tier caches
      // when it healed `items.access`, but arcs are synthesized from the external Graphiti group, which
      // is only cleaned by the projection/cleanup above — so any arc rebuild in between re-read the
      // old-tier facts and `commitArcs` stamped that result FRESH for a full TTL. Purge again now that
      // the group is actually clean; this is the call that closes the window (and mops up an SWR rebuild
      // that was already in flight when ingest purged).
      //
      // Both signals are direction-aware: a WIDENING also moves episodes between groups, but it leaks
      // nothing, and purging for it would force a cold LLM re-synthesis with no prior for the
      // empty-clobber guard to protect — the blank-panel failure the ingest side deliberately avoids.
      if (externalVacated || r.cleanedExternal) {
        await purgeExternalTierCaches(db, t.id, t.slug);
      }
    } catch (e) {
      summary.ok = false;
      summary.errors.push(`${t.slug}: ${e instanceof Error ? e.message : "projection failed"}`);
      // An aborted batch already pushed episodes before it threw — that extraction cost is real, and
      // dropping it undercounts the Phase C cost gate's denominator (code-review Codex Medium 3).
      // The abort error carries the batch's partial summary; merge the push counts.
      if (e instanceof ProjectionAbortError) {
        summary.scanned += e.partial.scanned;
        summary.projected += e.partial.projected;
        summary.episodes += e.partial.episodes;
        for (const [g, n] of Object.entries(e.partial.episodesByGroup)) {
          summary.episodesByGroup[g] = (summary.episodesByGroup[g] ?? 0) + n;
        }
        summary.skipped += e.partial.skipped;
        summary.fanoutThrottled += e.partial.fanoutThrottled;
        summary.restrictionMovesPending += e.partial.restrictionMovesPending;
        // TICKFIT-2: an aborted run must still report its fallbacks (the durable-visibility
        // contract — under-reporting here would hide a failing batch read behind any abort).
        summary.probeFallbackPages += e.partial.probeFallbackPages;
      }
    } finally {
      await lease.release();
    }
  }
  return summary;
}
