import type { IngestRunInput, IngestTrigger } from "@/lib/ingest/runs";
import type { GraphProjectionSummary } from "./run";

/**
 * Map a graph-projection summary → an `ingest_runs` record so the projector is as observable as every
 * other ingestion leg. This is the fix for the 2026-07 silent stall: the projector wrote NOTHING
 * durable, so a Graphiti `422` on writes wedged it for days with only ephemeral log lines. Recording
 * to `ingest_runs` surfaces it in Admin → Integrations → Recent ingestion runs (and makes an alert
 * possible). Pure so the mapping is unit-tested without a timer or a DB.
 *
 * `source: "graph_project"` is the stable ledger key for this leg. `ok` is false whenever a team
 * errored — that's what turns the row red in the panel.
 */
/** TICKFIT-2: a quiet walk slower than this records a durable run row anyway — the spec's
 *  revisit trigger reads `walkMs` from ingest_runs, and an ephemeral log cannot drive that
 *  decision. */
export const SLOW_WALK_RECORD_MS = 60_000;

/**
 * Which projection ticks earn a durable `ingest_runs` row — the ONE gate for BOTH callers (the
 * scheduler tick and the admin "Project to graph" button; the button used to carry its own inline
 * copy that had drifted five signals behind). Every clause is a SIGNAL (the no-silent-caps rule);
 * TICKFIT-2 added the last two — a failing batched ledger read and a slow quiet walk must reach
 * the dashboard, not just logs, or the 10.5-minute stage could silently return. Pure, so the gate
 * itself is unit-pinned (test/graph-recording-gate.test.ts pins each clause AND both call sites).
 * `walkMs` is summed across teams (run.ts), so a multi-team instance whose quick walks add up past
 * the threshold records an extra quiet row — a false positive that costs one row, accepted.
 */
export function shouldRecordProjectionRun(s: {
  projected: number; errors: string[]; requeued: number; cleaned: number;
  pendingCleanups: number; saturatedGroups: number; requeueThrottled: number;
  partialItems: number; fanoutThrottled: number; restrictionMovesPending: number;
  probeFallbackPages: number; lockedOut: number; walkMs: number;
  deepResolvedGroups: number; lookupMismatchGroups: number; deepRequeueHeld: number; deepRequeueEnabled: boolean;
  unreachableGroups: number; unreachableCleanupGroups: number; emptyListingGroups: number;
  requeueEligible: number;
}): boolean {
  return Boolean(
    s.projected || s.errors.length || s.requeued || s.cleaned || s.pendingCleanups ||
    s.saturatedGroups || s.requeueThrottled || s.partialItems ||
    // Codex diff review M1: both were already in the summary AND the meta as stall signals (a
    // budget that never clears; a restriction move that never lands) but neither inline gate had
    // them — a persistent stall of either kind disappeared at the gate.
    s.fanoutThrottled || s.restrictionMovesPending ||
    s.probeFallbackPages || s.lockedOut || s.walkMs > SLOW_WALK_RECORD_MS ||
    // GRAPHSAT-1 D3: held re-queues are ALWAYS a signal (work is being held); and while re-queue
    // is OFF, a deep-resolved pass records too — measurement mode is loud, so "lookup succeeded,
    // zero held" is a durable row the operator can read, not an absence they must infer. Once the
    // flag is on, a quiet deep-resolved pass is quiet. The mode is the EXECUTED one (from the
    // summary), never a second env parse.
    s.deepRequeueHeld || s.lookupMismatchGroups || (s.deepResolvedGroups && !s.deepRequeueEnabled) ||
    // RECONULL-1: a group that was never judged (listing threw), a cleanup that could not run, or a
    // listing that came back empty over real claims — each is the class the gate exists for.
    s.unreachableGroups || s.unreachableCleanupGroups || s.emptyListingGroups ||
    // GRAPHSAT-2: rows proven lost and waiting on the flag — level-triggered, every pass, until a
    // human acts (the "measurement mode is loud" rule). With the flag on they are re-queued, which
    // `requeued` already records.
    (s.requeueEligible && !s.deepRequeueEnabled)
  );
}

export function projectionRunInput(
  summary: GraphProjectionSummary,
  trigger: IngestTrigger,
  startedAt: number,
  finishedAt: number,
  /** The team a TEAM-SCOPED run belongs to (the admin button). Omitted for the scheduler's
   *  instance-wide aggregate, which stays `team_id = null`. Codex diff review H2: manual rows used
   *  to land null-team — visible to EVERY team's admin panel and excluded from the owning team's
   *  Costs denominator. */
  teamId?: string
): IngestRunInput {
  return {
    ...(teamId ? { teamId } : {}),
    source: "graph_project",
    trigger,
    ok: summary.errors.length === 0,
    created: summary.projected,
    unchanged: summary.skipped,
    errors: summary.errors,
    meta: {
      // EPISODES pushed, the denominator for calls-per-episode on the Costs page. `created` above is
      // ITEMS, which is a different unit: chunking splits one item into up to 16 episodes, so a ratio
      // over items moves with the corpus's chunk mix and can read a content shift as a model change.
      episodes: summary.episodes,
      // Per-group split of `episodes` (PCCC-3, design §3): the append-only substrate the Phase C
      // cost gate prices from. ingest_runs rows are never updated, so summing this key across runs
      // gives episodes-actually-pushed per partition — the denominator graph_episodes row counts
      // cannot provide (a row is one ITEM, and its projected_at mutates).
      episodesByGroup: summary.episodesByGroup,
      // Fan-out pushes withheld by the per-pass budget (PCCC-5) — a cap that saturates must never
      // be silent; persistent non-zero means arming outpaces GRAPH_FANOUT_PUSH_MAX_PER_PASS.
      fanoutThrottled: summary.fanoutThrottled,
      // Rule-2 exposure population (PCCC-6): items restricted out of General whose move has not
      // completed — non-zero for many runs means the copy leg is stuck, and the exposure is REAL.
      restrictionMovesPending: summary.restrictionMovesPending,
      scanned: summary.scanned,
      teams: summary.teams,
      reconciled: summary.reconciled,
      requeued: summary.requeued,
      cleaned: summary.cleaned,
      // Outstanding tier cleanups — old-tier episodes still purgeable-but-unpurged. Non-zero here is a
      // tier-isolation signal (B2), so it belongs in the durable record, not just an ephemeral log.
      pendingCleanups: summary.pendingCleanups,
      // Groups that outgrew the reconcile scan window — self-healing has stopped for them. A cap that
      // saturates must never be silent.
      saturatedGroups: summary.saturatedGroups,
      // Re-queues declined because a mass disappearance reads as a wedged Graphiti (H7). Recorded so a
      // throttle that persists across runs is visible rather than inferred from logs.
      requeueThrottled: summary.requeueThrottled,
      // TICKFIT-2: per-leg wall time (flat numbers — the runs panel Strings values; the revisit
      // trigger reads walkMs from these rows) + the durable batch-read fallback counter.
      walkMs: summary.walkMs,
      reconcileMs: summary.reconcileMs,
      ...(summary.probeFallbackPages ? { probeFallbackPages: summary.probeFallbackPages } : {}),
      ...(summary.lockedOut ? { lockedOut: summary.lockedOut } : {}),
      // GRAPHSAT-1: the saturated-group measurement, durable. `deepRequeueEnabled` rides so a row
      // is self-describing about the mode that produced it.
      // Like their siblings, the keys ride only when they say something (Fable diff review L3): a
      // quiet unsaturated team's row is not padded with zeros. A deep-resolved row is self-describing
      // about the mode that produced it.
      ...(summary.deepResolvedGroups ? { deepResolvedGroups: summary.deepResolvedGroups, deepRequeueEnabled: summary.deepRequeueEnabled } : {}),
      ...(summary.lookupMismatchGroups ? { lookupMismatchGroups: summary.lookupMismatchGroups } : {}),
      ...(summary.unreachableGroups ? { unreachableGroups: summary.unreachableGroups } : {}),
      ...(summary.unreachableCleanupGroups ? { unreachableCleanupGroups: summary.unreachableCleanupGroups } : {}),
      ...(summary.emptyListingGroups ? { emptyListingGroups: summary.emptyListingGroups } : {}),
      ...(summary.requeueEligible ? { requeueEligible: summary.requeueEligible } : {}),
      // Rides with any deep-resolved pass so "held N, eligible 0" is legible (anchors 0 vs an old anchor).
      ...(summary.deepResolvedGroups ? { watermarkAnchors: summary.watermarkAnchors } : {}),
      ...(summary.deepRequeueHeld ? { deepRequeueHeld: summary.deepRequeueHeld, deepRequeueHeldByGroup: summary.deepRequeueHeldByGroup, deepRequeueSample: summary.deepRequeueSample, deepRequeueElided: summary.deepRequeueElided } : {}),
      // RECONCILE-1 measurement: items with SOME chunks landed and some missing. Durable because the
      // whole question is whether this is real in prod — a log line would leave the rate unknowable,
      // which is exactly the position that made this hole invisible for so long. Counted only; no
      // verdict changed, nothing re-queued on it (see lib/graph/landed-state.ts).
      partialItems: summary.partialItems,
      // The bounded missing-name sample. The COUNT alone cannot separate a real tail hole from the
      // index-shift false positive (an edited doc re-chunks, so an expected `#k` may never have
      // existed) — and that discrimination is the whole reason to measure before enforcing. Review
      // caught this being dropped between reconcile and the durable row.
      partialDetail: summary.partialDetail,
    },
    startedAt,
    finishedAt,
  };
}
