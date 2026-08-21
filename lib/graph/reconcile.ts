import "server-only";
import type { DbClient } from "@/lib/db/types";
import { GraphitiClient } from "./graphiti-client";
import { itemIdFromEpisodeName } from "./episode-name";
import { landedState, boundPartialDetail } from "./landed-state";
import {
  GROUP_SCAN_DEPTH,
  IN_CLAUSE_BATCH,
  PROJECTION_INTERVAL_MS,
  chunk,
  resolvePositiveInt,
} from "./project";
import { isExternalGroupId } from "./group";
import { purgePartitionArcCache, sweepStaleScopedArcCache, sweepOrphanedPartitionArcCache } from "./arc-cache";
import { evictPartitionArcMemory } from "./arcs";
import { neo4jEpisodeLookup, type EpisodeLookup, type EpisodeRefLite } from "./episode-lookup";

/**
 * Reconcile pass for the brain→Graphiti seam (audit H3, Option B — chosen over blocking-confirm
 * because `/messages` is async/LLM-extraction-backed and polling every push would serialize a whole
 * projector batch behind unpredictable per-item latency). `graph_episodes` records a push
 * optimistically on the 202-accept; this pass periodically checks whether each recorded episode
 * ACTUALLY landed in Graphiti (via `GET /episodes/{group}`, matched by our stable `name`). Anything
 * that never landed (a worker crash before/while extracting it) is cleared so the next projector run
 * treats it as unprojected and re-pushes — self-healing, off the hot ingest/push path. Confirmed
 * rows get their `episode_uuid` backfilled as provenance only — the deletes resolve names→uuids through
 * `listEpisodes` themselves, so nothing reads the stored value.
 */

/**
 * Floor on "too recent to judge". Extraction is asynchronous, so a just-pushed episode legitimately
 * isn't in the group yet.
 */
export const GRACE_MS = 5 * 60_000;

/**
 * The grace actually applied: at least one full projection cycle (H7).
 *
 * Five minutes was the amplifier. Graphiti's queue drains at LLM speed, so any backlog deeper than the
 * grace made reconcile read every still-queued episode as "never landed" — it deleted the ledger row,
 * the projector re-pushed on its next tick, and that deepened the very backlog causing the
 * misjudgement. Positive feedback, and a large backfill trips it deterministically: unbounded duplicate
 * episodes and extraction spend.
 *
 * Waiting a full cycle costs almost no healing latency, which is what makes this a floor rather than a
 * compromise: a re-queued row can't be re-pushed until the projector's next run anyway, so judging it
 * sooner mostly buys nothing while risking judging it wrongly. Two honest exceptions, both accepted:
 *   • Phase offset. A row pushed mid-run is aged ~one interval by the NEXT reconcile; land fractionally
 *     under and it waits one more cycle, so a genuinely crashed episode can take ~2 cycles to heal.
 *   • The admin "Project to graph" action used to double as a fast manual heal (push, wait 5 min, click).
 *     It now judges nothing younger than a full cycle. Recovering sooner means lowering the cadence.
 *
 * `PROJECTION_INTERVAL_MS` is imported, not re-read from the env, so this can't drift from the cadence
 * the scheduler actually runs at — the whole argument above is false if the two numbers disagree.
 */
export const LANDED_GRACE_MS = Math.max(GRACE_MS, PROJECTION_INTERVAL_MS);

/**
 * Most ledger rows one pass may re-queue FOR ONE TEAM. Defence in depth behind `LANDED_GRACE_MS` — the
 * grace removes the misjudgement that drives the loop; this bounds the damage if something still does.
 *
 * A crashed worker loses ONE episode. A wedged queue, an outage, or a Graphiti restart makes EVERY row
 * look absent at once, so "many rows absent simultaneously" is evidence about the SERVICE rather than
 * about N independent rows. The cap does a bounded number and reports the remainder; the un-judged rows
 * keep their ledger entry and come round next pass, by which time the service has usually recovered and
 * they confirm instead.
 *
 * The cost is real and worth stating: a team that genuinely needs 1000 rows re-pushed heals at 20 per
 * projection cycle — at the default hourly cadence, ~50 hours. In the case this cap exists for that is
 * the RIGHT speed: when Graphiti accepted the pushes and never extracted them, re-pushing all 1000 at
 * once just re-creates the wedge, and drip-feeding is what you'd want a human to do by hand.
 *
 * But that is not the only way a thousand rows go absent at once. A Neo4j rollback or a rebuilt-image
 * recovery (both of which have happened here) loses landed episodes while the service is perfectly
 * HEALTHY — every row is legitimately gone, re-pushing all of them is correct, and 50 hours is simply
 * slow. That case is a deliberate operator action, so the intended response is to raise
 * `GRAPH_REQUEUE_MAX_PER_PASS` for the recovery; `requeueThrottled` is the signal that tells an operator
 * this is the situation they're in, rather than leaving it to be inferred from the graph looking thin.
 *
 * LIMITATION: the bound is per team, and Graphiti's extraction queue is shared across all of them, so a
 * many-team instance can still exceed it in aggregate on one pass. Making the budget global means
 * threading it through `runGraphProjection`'s team loop; not done, because the grace is the actual fix
 * and no instance today has the team count for this to bite.
 */
export const REQUEUE_MAX_PER_PASS = resolvePositiveInt(process.env.GRAPH_REQUEUE_MAX_PER_PASS, 20);
// Clearing a tier-cleanup flag is a tier-isolation decision (no RLS backstop), so it uses a LONGER,
// dedicated grace: a straggler chunk of the pre-reclassification push that's still sitting in Graphiti's
// extraction queue (which demonstrably backs up — the oversized-episode wedge) could land AFTER a short
// grace cleared the flag and leak the old tier permanently. Cleanup is rare + off the hot path, so we
// can afford to wait an hour before declaring an old group durably empty. (The purge of any episode we
// DO see still runs every pass; only the flag-CLEAR waits out this window.)
const CLEANUP_GRACE_MS = 60 * 60_000;

/**
 * How deep the LANDED-check lists each group. Deliberately smaller than `GROUP_SCAN_DEPTH` (which the
 * rare tier cleanup uses): this runs for EVERY group on EVERY pass, so the window is a payload cost
 * paid hourly, not a one-off. A group past this window is not judged at all (see `saturated` below)
 * rather than judged wrongly, so the depth trades latency-to-heal for transfer size — not correctness.
 */
export const LANDED_SCAN_DEPTH = resolvePositiveInt(process.env.GRAPH_LANDED_SCAN_DEPTH, 5000);

/**
 * RECONULL-1: the landed listing's own deadline — an OPERATOR ESCAPE HATCH, not a new default. Unset
 * → the client's default (30 s). Prod measured a 5,000-episode listing at ~8 s warm and past 30 s on
 * a cold Neo4j page cache (after a graphiti restart); a longer deadline holds #629's lease and the
 * process single-flight for that long per slow group, so the cheaper lever on an install WITH
 * `NEO4J_URL` is a smaller `GRAPH_LANDED_SCAN_DEPTH` (1,000 — the lookup judges the rest, the
 * REST-window oracle stays a valid subset) — IN THIS ORDER (Codex diff review H1): lower the depth
 * while `GRAPH_DEEP_REQUEUE` is OFF (the 1k–5k groups move onto the lookup path and their never-landed
 * rows are HELD), inspect every held candidate with `deepRequeueElided 0` (GRAPHSAT-1 D4), THEN enable.
 * Lowering the depth AFTER enabling would put groups onto the mutating path whose candidates were never
 * audited at that depth, with an oracle covering only the newest 1,000 episodes. With the flag off and
 * the depth lowered, those groups stop healing until the audit completes (Fable diff review M1) — a
 * deliberate pause, stated. The default stays 5,000 because an install WITHOUT Neo4j would lose
 * judging for every 1k–5k group.
 */
/**
 * GRAPHSAT-2 — THE LANDED WATERMARK. graphiti's worker is ONE serial `asyncio.Queue` consumer that
 * drops a failing job and never re-queues (graphiti/patch-resilient-worker.py; pinned at build time
 * by graphiti/verify-single-worker.py), so for two episodes accepted A then B: if B has landed, A is
 * landed or GONE — never still queued. The ledger records accept order as `projected_at` (written
 * right after the accepted POST). On a judged lookup pass, a never-landed row older than the newest
 * PRESENT row's `projected_at` by more than this margin was passed over by the queue: lost, safe to
 * re-push. The margin must exceed the one inversion the ordering allows — a row accepted before
 * another but stamped later by up to one POST latency (the client aborts at 30 s); 10 min is two
 * orders of magnitude above that. Env-tunable; `0`/blank/garbage → the default.
 */
export const LANDED_WATERMARK_MARGIN_MS = resolvePositiveInt(process.env.GRAPH_LANDED_WATERMARK_MARGIN_MS, 10 * 60_000);

export function landedListTimeoutMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = Number(env.GRAPH_LANDED_LIST_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

export interface ReconcileSummary {
  groupsChecked: number;
  confirmed: number;
  reQueued: number;
  /** Rows whose OLD-group cleanup (after a tier change) was verified complete this pass. */
  cleaned: number;
  /** Of those, the ones whose old group was the EXTERNAL one — i.e. a NARROWING has now fully left the
   * graph. Direction-aware because only that case justifies hard-purging the external caches. */
  cleanedExternal: number;
  /** Cleanups STILL outstanding after this pass — old-tier episodes that are purgeable but not yet
   * verified purged. A number that never returns to 0 is a stuck tier cleanup, not bookkeeping. */
  pendingCleanups: number;
  /** Rows this pass WANTED to re-queue but didn't, because the per-pass cap says a mass disappearance is
   * a service problem rather than N crashed workers. Non-zero means Graphiti is probably unhealthy; the
   * rows are untouched and retried next pass. */
  requeueThrottled: number;
  /** Items with SOME chunks present and SOME missing — the partial-loss population (RECONCILE-1).
   * MEASURED ONLY: these still count as `confirmed` and are not re-queued, exactly as before. The
   * number exists to answer whether the hole is real in prod before anything enforces on it; see
   * `lib/graph/landed-state.ts` for the three ways enforcing today would make the graph worse. */
  partialItems: number;
  /** A BOUNDED sample of those items and their missing episode names, so an operator can tell a real
   * hole from the index-shift false positive (an edited doc re-chunks, so an expected `#k` may never
   * have existed). `elided` is how many were dropped from the sample. */
  partialDetail: { sample: { itemId: string; missing: string[]; missingCount: number }[]; elided: number; namesElided: number };
  /** Groups whose episode list came back FULL AND could not be judged by the per-item lookup this pass
   * (Neo4j unconfigured or the lookup failed). Reported rather than swallowed: self-healing is
   * stopped for such a group. GRAPHSAT-1 narrowed this from "past the window" to "past the window
   * and unjudged" — a saturated group with a working lookup counts under `deepResolvedGroups`. */
  saturatedGroups: number;
  /** GRAPHSAT-1: groups past the REST window that WERE judged via the per-item Neo4j lookup. */
  deepResolvedGroups: number;
  /** GRAPHSAT-1 (Fable diff review M1): saturated groups whose lookup returned a result that MISSED an
   * item the REST window itself confirms — a structurally broken lookup (wrong graph, renamed
   * property). Counted under `saturatedGroups` too (unjudged) and separately here so the operator can
   * tell "Neo4j down" from "Neo4j is the wrong one". */
  lookupMismatchGroups: number;
  /** GRAPHSAT-1: never-landed rows on the lookup path that would have been re-queued but were HELD
   * because `deepRequeue` is off (measurement mode). Always a recording-gate signal. */
  deepRequeueHeld: number;
  deepRequeueHeldByGroup: Record<string, number>;
  /** Held rows as STRUCTURED identities, OLDEST first — an item id alone is not identifiable across
   * groups/teams (Codex design round 2 H2). EVERY held identity rides up to DEEP_REQUEUE_SAMPLE_LIMIT
   * (the "individually inspectable" bound D4's enable criterion needs — Codex diff review M2: a
   * fixed oldest-5 could never enumerate a sixth stable row); past it, `deepRequeueElided` counts the
   * rest and the population is declared NON-enumerable (flag-ineligible) rather than silently
   * truncated. */
  deepRequeueSample: DeepRequeueRef[];
  deepRequeueElided: number;
  /** The re-queue mode this pass EXECUTED on the lookup path — the recording gate reads it from here
   * rather than re-parsing the env (one resolution, in the runner). */
  deepRequeueEnabled: boolean;
  /** RECONULL-1: groups whose LANDED listing threw (unreachable, non-2xx, the deadline, a malformed
   * body) — skipped unjudged, as before, but now COUNTED: a pass in which the largest group was never
   * judged used to be indistinguishable from a healthy quiet pass. A recording-gate signal. */
  unreachableGroups: number;
  /** RECONULL-1: pending-delete OLD groups whose cleanup listing threw — flags kept, retry next pass,
   * now counted. A gate signal too: the `pendingCleanups` re-read this leg relied on can itself fail. */
  unreachableCleanupGroups: number;
  /** RECONULL-1: groups whose listing came back EMPTY while the ledger holds mature non-sentinel rows
   * (a current projection claim past the grace) — the mass-disappearance shape. The bounded re-queue
   * (REQUEUE_MAX_PER_PASS) proceeds exactly as before; this makes the event LOUD. A gate signal. */
  emptyListingGroups: number;
  /** GRAPHSAT-2: never-landed rows on the lookup path that the landed watermark proves LOST (older
   * than the newest present landing by more than the margin) — re-queued when `deepRequeue` is on,
   * held otherwise. Reported either way; with the flag OFF it is a recording-gate signal: work is
   * proven ready and waits on a human. */
  requeueEligible: number;
  /** RECONULL-1: errors this pass could not represent as a counter (the pending-cleanup count re-read
   * failing). The runner merges them into the run's errors; every other counter and this pass's
   * mutations are retained. */
  errors: string[];
}

export interface DeepRequeueRef {
  teamId: string;
  groupId: string;
  itemId: string;
  projectedAt: string;
}

export interface ReconcileOptions {
  /**
   * Re-queue budget for THIS pass, defaulting to the per-team constant. An option rather than a bare
   * module constant for two reasons: it lets a test exercise the throttle at a size it can actually
   * seed (depending on the env-derived value means the fixture grows with the knob), and it is the seam
   * a future global budget would use to spend one allowance across `runGraphProjection`'s team loop —
   * the LIMITATION named on `REQUEUE_MAX_PER_PASS`.
   */
  maxRequeuePerPass?: number;
  /** GRAPHSAT-1: the per-item episode lookup used when a group's REST listing saturates. Default:
   * the Neo4j one (`null` when unconfigured). Tests inject. */
  lookup?: EpisodeLookup;
  /** GRAPHSAT-1: whether never-landed rows judged on the LOOKUP path may be re-queued. Default
   * false — measurement mode; the runner resolves `GRAPH_DEEP_REQUEUE === "true"` once and passes it. */
  deepRequeue?: boolean;
  /** GRAPHSAT-2 test seam: the watermark margin (default LANDED_WATERMARK_MARGIN_MS). */
  watermarkMarginMs?: number;
}

/** GRAPHSAT-1: the ONE place the env flag is parsed. Exact `"true"` — a truthiness check would make
 *  `GRAPH_DEEP_REQUEUE=false` enable it. */
export function deepRequeueEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GRAPH_DEEP_REQUEUE === "true";
}

/**
 * Build the presence view reconcile judges against from a list of episode refs — the SAME helper for
 * the REST listing and the per-item lookup, so the two paths cannot drift (GRAPHSAT-1 D1).
 * `uuidByItemId` is FIRST-WINS (it decides the verdict, as it always has); `presentNames` is read
 * for the per-chunk count and nothing else.
 */
export function presenceFrom(refs: readonly EpisodeRefLite[]): {
  uuidByItemId: Map<string, string>;
  presentNames: Set<string>;
} {
  const uuidByItemId = new Map<string, string>();
  const presentNames = new Set<string>();
  for (const e of refs) {
    if (e.name) presentNames.add(e.name);
    const itemId = itemIdFromEpisodeName(e.name);
    if (itemId && !uuidByItemId.has(itemId)) uuidByItemId.set(itemId, e.uuid);
  }
  return { uuidByItemId, presentNames };
}

type EpisodeRow = {
  id: string;
  source_id: string;
  source_table: string;
  group_id: string;
  content_sha256: string;
  projected_at: string;
  episode_uuid: string | null;
  pending_delete_group_id: string | null;
  pending_delete_at: string | null;
  chunk_shas: string[] | null;
};

/**
 * The `source_id`s in `rows` whose row in `items` is GONE — the orphan set (see the call site).
 *
 * Returns an EMPTY set when the lookup fails, and only ever classifies `source_table='items'` rows:
 * "couldn't check" must stay inconclusive here, exactly as an unreachable Graphiti does below. A
 * swallowed DB error would otherwise read as "every pending row is an orphan" and delete healthy
 * tier-cleanup bookkeeping, which the projector would answer by re-pushing — duplicate episodes,
 * double-weighted facts.
 */
async function findOrphanSourceIds(
  db: DbClient,
  teamId: string,
  rows: readonly EpisodeRow[]
): Promise<Set<string>> {
  const ids = [...new Set(rows.filter((r) => r.source_table === "items").map((r) => r.source_id))];
  if (ids.length === 0) return new Set();
  const alive = new Set<string>();
  // Chunked: this passes EVERY projected item's id, and the pg adapter binds one per element — past
  // Postgres' 65535-bind ceiling the statement is refused outright, which would silently switch off
  // the whole orphan-repair safety net at exactly the corpus size where it matters.
  for (const batch of chunk(ids, IN_CLAUSE_BATCH)) {
    const { data, error } = await db.from("items").select("id").eq("team_id", teamId).in("id", batch);
    if (error) {
      // LOUD: returning an empty set is the right direction (nothing is judged an orphan), but a
      // silent one means the repair is off and no signal says so.
      console.error(`[graph] orphan check failed — orphan repair skipped this pass: ${error.message}`);
      return new Set();
    }
    for (const r of (data ?? []) as { id: string }[]) alive.add(r.id);
  }
  return new Set(ids.filter((id) => !alive.has(id)));
}

/**
 * Flag every orphan row that isn't already carrying a cleanup, and return the rows as they now stand
 * (new objects — the caller's snapshot must not silently disagree with the DB). The flag reuses the
 * tier-cleanup mechanism wholesale: the loop below purges the group and drops the row once it's
 * verified empty, retrying across passes if Graphiti is down.
 */
async function repairOrphans(
  db: DbClient,
  rows: readonly EpisodeRow[],
  orphans: ReadonlySet<string>
): Promise<EpisodeRow[]> {
  const at = new Date().toISOString();
  const out: EpisodeRow[] = [];
  for (const row of rows) {
    if (!orphans.has(row.source_id) || row.pending_delete_group_id) {
      out.push(row);
      continue;
    }
    const patch = {
      content_sha256: "", // no longer a live projection
      pending_delete_group_id: row.group_id,
      pending_delete_at: at,
    };
    const { error } = await db.from("graph_episodes").update(patch).eq("id", row.id);
    out.push(error ? row : { ...row, ...patch });
  }
  return out;
}

export async function reconcileProjectedEpisodes(
  db: DbClient,
  client: GraphitiClient,
  teamId: string,
  options: ReconcileOptions = {}
): Promise<ReconcileSummary> {
  const maxRequeuePerPass = options.maxRequeuePerPass ?? REQUEUE_MAX_PER_PASS;
  const lookup = options.lookup ?? neo4jEpisodeLookup;
  const deepRequeue = options.deepRequeue ?? false;
  const watermarkMarginMs = options.watermarkMarginMs ?? LANDED_WATERMARK_MARGIN_MS;
  if (!client.configured)
    return {
      groupsChecked: 0,
      confirmed: 0,
      reQueued: 0,
      partialItems: 0,
      partialDetail: { sample: [], elided: 0, namesElided: 0 },
      cleaned: 0,
      cleanedExternal: 0,
      pendingCleanups: 0,
      requeueThrottled: 0,
      saturatedGroups: 0,
      deepResolvedGroups: 0,
      lookupMismatchGroups: 0,
      deepRequeueHeld: 0,
      deepRequeueHeldByGroup: {},
      deepRequeueSample: [],
      deepRequeueElided: 0,
      deepRequeueEnabled: deepRequeue,
      unreachableGroups: 0,
      unreachableCleanupGroups: 0,
      emptyListingGroups: 0,
      requeueEligible: 0,
      errors: [],
    };

  const { data, error: ledgerErr } = await db
    .from("graph_episodes")
    .select(
      "id, source_id, source_table, group_id, content_sha256, projected_at, episode_uuid, pending_delete_group_id, pending_delete_at, chunk_shas"
    )
    .eq("team_id", teamId)
    // DEFERRED rows are exempt from every judgement here (PCCC-5, design §2.5): they carry the ''
    // sentinel because extraction is deliberately WITHHELD (a cold initiative), not because a push
    // never landed — the never-landed delete would remove them, the projector would re-create them
    // next pass, and the loop would churn forever while reading as healthy self-healing.
    .eq("deferred", false);
  const rawRows = (data ?? []) as EpisodeRow[];
  // RECONULL-1 (Fable diff review M2): a failed ledger read used to become an EMPTY ledger — groupsChecked 0,
  // every counter 0, ok:true, the gate quiet: the same silent-healthy shape as the pending-count read.
  // Nothing can be judged without the ledger; report the error and return the empty summary.
  if (ledgerErr) {
    return {
      groupsChecked: 0, confirmed: 0, reQueued: 0, partialItems: 0,
      partialDetail: { sample: [], elided: 0, namesElided: 0 },
      cleaned: 0, cleanedExternal: 0, pendingCleanups: 0, requeueThrottled: 0, saturatedGroups: 0,
      deepResolvedGroups: 0, lookupMismatchGroups: 0, deepRequeueHeld: 0, deepRequeueHeldByGroup: {},
      deepRequeueSample: [], deepRequeueElided: 0, deepRequeueEnabled: deepRequeue,
      unreachableGroups: 0, unreachableCleanupGroups: 0, emptyListingGroups: 0, requeueEligible: 0,
      errors: [`reconcile: ledger read failed: ${ledgerErr.message}`],
    };
  }

  // ── Orphan repair, BEFORE anything else judges these rows ────────────────────────────────────
  // A ledger row whose ITEM is gone is an orphan, and an orphan's episodes are content the brain no
  // longer holds still answering questions in Graphiti. `lib/ingest/purge` retires what it can see,
  // but it cannot see a projector batch already in flight: the projector loads an item, the purge
  // deletes it, and the projector then re-pushes the body it still holds in memory AND clears the
  // pending-delete flag (the `purgeBeforeRepush` branch). That row looks perfectly healthy
  // afterwards — fresh sha, no flag — so nothing would ever revisit it and the purged content would
  // stay searchable forever.
  //
  // So orphan-ness, not the flag, is the invariant: any row with no item is re-flagged here and the
  // ordinary cleanup loop below purges it and drops the row. This also covers orphans from any other
  // door (a hand-deleted item, a future diff-delete) for free.
  const orphans = await findOrphanSourceIds(db, teamId, rawRows);
  const rows = await repairOrphans(db, rawRows, orphans);

  const byGroup = new Map<string, EpisodeRow[]>();
  for (const row of rows) {
    const arr = byGroup.get(row.group_id) ?? [];
    arr.push(row);
    byGroup.set(row.group_id, arr);
  }

  const cutoff = Date.now() - LANDED_GRACE_MS;
  let confirmed = 0;
  let reQueued = 0;
  let partialItems = 0;
  const partialFound: { itemId: string; missing: string[] }[] = [];
  let saturatedGroups = 0;
  let deepResolvedGroups = 0;
  let lookupMismatchGroups = 0;
  let deepRequeueHeld = 0;
  const deepRequeueHeldByGroup: Record<string, number> = {};
  const heldRefs: DeepRequeueRef[] = [];
  let requeueThrottled = 0;
  let unreachableGroups = 0;
  let emptyListingGroups = 0;
  let requeueEligible = 0;
  const listTimeoutMs = landedListTimeoutMs();
  // GRAPHSAT-2: the landed watermark — the newest `projected_at` among rows PRESENT in this pass's
  // listings/lookups, team-wide, collected BEFORE the grace check (a fresh landing is exactly the
  // evidence). Re-queue decisions from BOTH paths are recorded on ONE ordered tape and replayed after
  // every group has been judged, so the watermark sees every landing and REST rows keep their
  // throttle priority in traversal order.
  let watermarkMs = Number.NEGATIVE_INFINITY;
  const tape: { row: EpisodeRow; groupId: string; deep: boolean }[] = [];

  // GRAPHSAT-2: DETERMINISTIC group traversal (sorted group_id). Throttle priority across groups was
  // Postgres heap order before — with a scarce budget, WHICH group's rows were re-queued first was
  // undefined (the same class TICKFIT-2 fixed for fan-out). The tape replays in this order.
  for (const groupId of [...byGroup.keys()].sort()) {
    const groupRows = byGroup.get(groupId)!;
    // Graphiti unreachable this pass — leave these rows alone and try again next tick, rather than
    // treating "couldn't check" as "never landed" and re-pushing everything. RECONULL-1: COUNTED and
    // logged (it was silent), and NOTHING else — no lookup, no write: without a REST window there is
    // no oracle, and a uuid backfilled from a wrong graph feeds the arming latch and the
    // restriction-move `landedCopy` (the declined fall-through).
    const episodes = await client.listEpisodes(groupId, LANDED_SCAN_DEPTH, { timeoutMs: listTimeoutMs }).catch((err: unknown) => {
      console.warn(`[graph] reconcile: listing ${groupId} failed (group stays unjudged this pass): ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    if (episodes === null) {
      unreachableGroups++;
      continue;
    }
    // RECONULL-1: an EMPTY listing over a ledger that holds mature, current projection claims is the
    // mass-disappearance shape (a wiped graph — or a transient empty body). The REST path below has
    // no hold, so it re-queues up to the cap, as it always did and must (a genuinely wiped graph
    // has to heal); this makes the event loud instead of a quiet trickle of re-queues.
    if (episodes.length === 0 && groupRows.some((r) => r.content_sha256 !== "" && new Date(r.projected_at).getTime() <= cutoff)) {
      emptyListingGroups++;
      console.warn(`[graph] reconcile: listing ${groupId} is EMPTY while the ledger holds mature projected rows — mass disappearance? (bounded re-queue proceeds)`);
    }
    // A FULL window is inconclusive the same way an unreachable Graphiti is: an item's chunks may sit
    // just beyond it, and reading that as "never landed" would re-push the ENTIRE group every pass —
    // growing the group, pushing more rows out of the window, re-pushing more next pass. That
    // self-amplifying loop is worse than not healing. GRAPHSAT-1: instead of skipping the group, judge
    // it through the per-ITEM lookup (`lib/graph/episode-lookup.ts`) — EXACT, so "absent" means not
    // in the group, not "beyond the window", and the hazard above does not apply. The lookup is the
    // only source of refs on this path; if it is unavailable (`null`) or FAILS, the group is skipped
    // and counted exactly as before — never judged on a partial view.
    let refs: readonly EpisodeRefLite[] = episodes;
    let deep = false;
    if (episodes.length >= LANDED_SCAN_DEPTH) {
      const itemIds = [...new Set(groupRows.map((r) => r.source_id))];
      const lookedUp = await lookup(groupId, itemIds).catch((err: unknown) => {
        console.warn(`[graph] reconcile: per-item lookup failed for ${groupId} (group stays unjudged): ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });
      if (lookedUp === null) {
        saturatedGroups++;
        continue;
      }
      // THE REST WINDOW IS A FREE TRUTH ORACLE (Fable diff review M1): the 5,000 newest episodes we
      // already hold are a guaranteed SUBSET of what the lookup must return for this group's items.
      // A lookup that misses any item the window confirms is structurally broken — a reachable
      // Neo4j that is not the one Graphiti writes, a renamed property, a future store cutover —
      // and would otherwise read as "everything never landed" (an EMPTY result is not an error).
      // Degrade it to unjudged, by construction, before any verdict is formed. An episode deleted
      // between the two reads trips this for one pass in the safe direction (skip, retry next tick).
      const ledgerIds = new Set(itemIds);
      const restConfirmed = new Set<string>();
      for (const e of episodes) {
        const id = itemIdFromEpisodeName(e.name);
        if (id && ledgerIds.has(id)) restConfirmed.add(id);
      }
      const lookupConfirmed = presenceFrom(lookedUp).uuidByItemId;
      const missed = [...restConfirmed].filter((id) => !lookupConfirmed.has(id));
      if (missed.length > 0) {
        console.warn(
          `[graph] reconcile: per-item lookup for ${groupId} missed ${missed.length} item(s) the REST window confirms — treating the lookup as broken, group stays unjudged`
        );
        saturatedGroups++;
        lookupMismatchGroups++;
        continue;
      }
      refs = lookedUp;
      deep = true;
      deepResolvedGroups++;
    }
    // An item is projected as one OR MANY chunk episodes (`items:<id>` / `items:<id>#k`) — it "landed"
    // if ANY of its chunks is present. Map each item id → one of its episode uuids (FIRST-WINS, decides
    // the verdict). RECONCILE-1 (measurement only): `presentNames` lets a row's chunks be checked
    // individually and is read for counting and nothing else. ONE helper for both paths (D1).
    const { uuidByItemId, presentNames } = presenceFrom(refs);
    // GRAPHSAT-2: every PRESENT row anchors the watermark — fresh or mature (the grace gate below
    // governs confirmation/backfill/partial counting only, never the watermark).
    for (const row of groupRows) {
      if (uuidByItemId.has(row.source_id)) watermarkMs = Math.max(watermarkMs, new Date(row.projected_at).getTime());
    }

    for (const row of groupRows) {
      if (new Date(row.projected_at).getTime() > cutoff) continue; // too recent, still may be processing
      const uuid = uuidByItemId.get(row.source_id);
      if (uuid) {
        confirmed++;
        // COUNT the partial case; do not act on it. `chunk_shas` is the expected-chunk ledger; an
        // empty one means never-pushed and reports "none", which is why this cannot mistake a
        // reservation row for a hole.
        const { state, missing } = landedState(row.source_id, row.chunk_shas?.length ?? 0, presentNames);
        // UNDER-COUNT, named rather than left silent (review): `state === "none"` is reachable INSIDE
        // the confirmed branch — a doc that shrinks 3 chunks → 1 has its single sha already pushed, so
        // `items:x` is never written while legacy `items:x#0..2` still confirm the item. That is a
        // hole-by-renaming this counter does not see. Left uncounted deliberately: it is a different
        // class with a different repair, and inventing a number for it here would blur the one metric
        // increment 2 is meant to be gated on.
        if (state === "partial") {
          partialItems++;
          partialFound.push({ itemId: row.source_id, missing });
        }
        if (!row.episode_uuid) {
          await db.from("graph_episodes").update({ episode_uuid: uuid }).eq("id", row.id);
        }
      } else if (row.pending_delete_group_id) {
        // This row still owes an OLD-group cleanup. DELETING it (the normal re-queue) would lose the
        // `pending_delete_group_id` flag → the old tier stays searchable forever with nothing to retry
        // it (the exact leak B2 closes, resurrected via a new-group worker crash). Instead, reset the
        // content hash so the projector re-pushes it (same re-queue effect), while the row — and its
        // pending flag — survive for the cleanup loop below to finish. The re-push's upsert omits the
        // pending column (its tier didn't change), so the flag is retained.
        //
        // Already on the sentinel → nothing to re-queue (a redacted item parks here for the whole
        // grace window). Writing and counting it every pass would inflate `requeued` in the logs and
        // the ingest_runs meta with work that isn't happening.
        if (row.content_sha256 !== "") {
          tape.push({ row, groupId, deep }); // decided in phase 2 (GRAPHSAT-2)
        }
      } else {
        // NEVER-PUSHED rows are the PROJECTOR's to converge, not this judge's to delete (review-2
        // Blocker 2): an ARMED-but-unpushed row ('' sha, EMPTY chunk ledger — reservation or an
        // arm awaiting its budgeted push) has claimed nothing in Graphiti, so "never landed" is
        // vacuous for it — and deleting it re-cold-starts the arm every cycle: on a reader-quiet
        // team the restriction-move copy deterministically never pushed and rule-2 exposure stayed
        // open forever. A row that EVER pushed keeps its chunk_shas (the re-queue resets only the
        // sha), so the empty ledger is the honest discriminator.
        if ((row.chunk_shas ?? []).length === 0 && row.content_sha256 === "") continue;
        // GRAPHSAT-2 D5: on the LOOKUP path a row already parked on the sentinel is awaiting the
        // projector's re-push — neither eligible, nor held, nor written, nor throttle-consuming. (The
        // REST path keeps its historical re-judge of parked rows — named, unchanged.)
        if (deep && row.content_sha256 === "") continue;
        tape.push({ row, groupId, deep }); // decided in phase 2 (GRAPHSAT-2)
        continue;
        // The historical write, kept below for the record of WHY it parks rather than deletes:
        // PARK ON THE SENTINEL RATHER THAN DELETE (STALLSCOPE-1, found by both code reviewers).
        //
        // This used to `delete()` the row, which has the same re-queue effect — the branch above says
        // so in its own comment ("the sentinel → the projector re-pushes it like a deleted row") — but
        // destroys the row's identity, and with it `first_seen_at`, the SET-ONCE clock the stall
        // probe's age gate reads. That matters in exactly the state the probe exists for: during a
        // dead-extractor outage nothing lands, so this path recycles rows every grace window and each
        // re-creation takes a fresh `default now()`. Detection survived only on an accident of the
        // defaults (`REQUEUE_MAX_PER_PASS` 20 < `MIN_ITEMS_FOR_EXTRACTION_SIGNAL` 25, so some row
        // always kept an old clock) — and raising that cap is the DOCUMENTED response to
        // `requeueThrottled`, which a dead extractor is what produces. It would have held the gate
        // open indefinitely.
        //
        // Keeping the row is also the more correct post-PCCC-3 behaviour on its own terms: the row IS
        // the `(item, group)` reservation, and re-pushing is what a reservation is for. The delta path
        // is skipped for a sentinel sha, so the next pass pushes the whole item exactly as before.
      }
    }
  }

  // ── PHASE 2 (GRAPHSAT-2): replay the tape in traversal order with the watermark known ──────────
  // REST-path rows: today's verdict (throttle → park). Lookup-path rows: the landed-watermark rule —
  // proven LOST (older than the newest present landing by more than the margin) → eligible; eligible
  // AND the flag on → park like REST; otherwise HELD (counted, sampled, no budget consumed).
  const hold = (row: EpisodeRow, groupId: string): void => {
    deepRequeueHeld++;
    deepRequeueHeldByGroup[groupId] = (deepRequeueHeldByGroup[groupId] ?? 0) + 1;
    heldRefs.push({ teamId, groupId, itemId: row.source_id, projectedAt: row.projected_at });
  };
  for (const { row, groupId, deep } of tape) {
    if (deep) {
      const lost = Number.isFinite(watermarkMs) && new Date(row.projected_at).getTime() + watermarkMarginMs < watermarkMs;
      if (lost) requeueEligible++;
      if (!lost || !deepRequeue) {
        hold(row, groupId);
        continue;
      }
    }
    // Throttled (H7) — see REQUEUE_MAX_PER_PASS. Past the cap the pass stops judging and reports the
    // remainder; the rows are untouched and come round again next pass. Held rows never reach here,
    // so they consume no budget.
    if (reQueued >= maxRequeuePerPass) {
      requeueThrottled++;
      continue;
    }
    // PARK on the '' sentinel (STALLSCOPE-1: never delete — `first_seen_at` is the stall probe's
    // set-once clock). The pending-delete variant keeps its flag by the same write (only the sha moves).
    await db.from("graph_episodes").update({ content_sha256: "" }).eq("id", row.id);
    reQueued++;
  }

  // Tier-reclassification cleanup (audit M6 durability, Pass-1 review B2). A row with
  // `pending_delete_group_id` had its tier changed; its OLD-group episodes must be purged, but the
  // projector's inline delete is best-effort (a swallowed Graphiti error, or the async worker creating
  // a straggler chunk after it ran). Retry the delete here until the old group is verified empty, THEN
  // clear the flag. Independent of the landed-check above (that confirms the NEW group).
  let cleaned = 0;
  let cleanedExternal = 0;
  let unreachableCleanupGroups = 0;
  const pendingByGroup = new Map<string, EpisodeRow[]>();
  const pendingByGroup2 = pendingByGroup; // (alias keeps the diff minimal below)
  for (const row of rows) {
    if (!row.pending_delete_group_id) continue;
    const arr = pendingByGroup2.get(row.pending_delete_group_id) ?? [];
    arr.push(row);
    pendingByGroup2.set(row.pending_delete_group_id, arr);
  }
  // PCCC-7 (post-merge Codex High 1, placement per Codex PCCC-7 High 2): the team's
  // partition-scoped arc rows are hard-purged LAZILY, at the first VERIFIED-CLEAN self clear this
  // pass — never eagerly. Clearing a self flag is what returns a partition to readers' scope keys,
  // and a `p:` row synthesized pre-restriction/pre-redaction carries prose the evidence filter
  // cannot see — but purging while Graphiti is still DIRTY is its own poison: the next reader's
  // cold miss re-synthesizes from the un-cleaned graph and persists that for a whole projection
  // interval. So the purge waits for the same proof the clear itself waits for (group verified
  // empty of the item, grace elapsed), memoized once per pass; a FAILED purge holds every self
  // clear this pass — fail closed, converging next tick. (This also subsumes the clear-imminent
  // narrowing: no clear, no purge, so a stuck cleanup never deletes readers' active rows.)
  // PPARC-4: the team-wide p: purge gate is RETIRED (no writer mints p: rows since the PPARC-3
  // cutover; the straggler SWEEP below still janitors pre-cutover residue).
  // PPARC-2: the PARTITION-NATIVE (`g:`) twin — per affected group, memoized, strictly narrower
  // (only the self-purging partition's row dies; a neighbor's rows survive its restriction).
  const partitionPurgeState = new Map<string, boolean>();
  const partitionArcPurgeGate = async (groupId: string): Promise<boolean> => {
    const memo = partitionPurgeState.get(groupId);
    if (memo !== undefined) return memo;
    const ok = (await purgePartitionArcCache(db, teamId, groupId)).ok;
    if (ok) evictPartitionArcMemory(groupId);
    partitionPurgeState.set(groupId, ok);
    return ok;
  };
  // Straggler sweep: nothing mints `p:` keys anymore (PPARC-4) — this collects PRE-CUTOVER residue
  // only, age-gated well past the TTL (7d). Retire it once self-hosts are past the cutover era.
  await sweepStaleScopedArcCache(db, teamId);
  // PPARC-4 orphan sweep: a DELETED initiative's g: row is unreachable post-cutover (reads are
  // pointer-resolved) but nothing else ever removes it — bounded by partition count.
  await sweepOrphanedPartitionArcCache(teamId);
  for (const [oldGroup, groupRows] of pendingByGroup) {
    // List the old group once (deep — a large group must not hide the item's episodes past the default
    // window). Graphiti unreachable → leave the flags set and retry next tick.
    // The per-call deadline applies here too (Fable diff review L2): a 100k-deep listing on a cold
    // graph is MORE likely to blow the default than the landed one.
    const episodes = await client.listEpisodes(oldGroup, GROUP_SCAN_DEPTH, { timeoutMs: listTimeoutMs }).catch((err: unknown) => {
      console.warn(`[graph] reconcile: cleanup listing ${oldGroup} failed (flags kept, retry next pass): ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    if (episodes === null) {
      unreachableCleanupGroups++;
      continue;
    }
    // If the scan hit the cap, the item's episodes MIGHT be beyond the window — treat "not found" as
    // inconclusive and never clear the flag on a saturated scan (else we'd false-clear while old-tier
    // episodes still exist — the very bug this fixes, just at a larger N). The flag then stays set +
    // observable rather than silently declaring a phantom cleanup.
    const saturated = episodes.length >= GROUP_SCAN_DEPTH;
    const uuidsByItem = new Map<string, string[]>();
    for (const e of episodes) {
      const itemId = itemIdFromEpisodeName(e.name);
      if (!itemId) continue;
      const arr = uuidsByItem.get(itemId) ?? [];
      arr.push(e.uuid);
      uuidsByItem.set(itemId, arr);
    }
    for (const row of groupRows) {
      const uuids = uuidsByItem.get(row.source_id) ?? [];
      let deleteFailed = false;
      for (const uuid of uuids) {
        try {
          await client.deleteEpisode(uuid);
        } catch {
          deleteFailed = true; // keep the flag; retry next pass
        }
      }
      // Clear the flag ONLY when the old group is confirmed empty of this item AND enough time has
      // passed (the LONGER cleanup grace) that a late-extracting worker won't still create a straggler
      // chunk. If we purged some this pass, leave it set so the next pass re-verifies empty.
      //
      // Anchored on `pending_delete_at` (when the cleanup was recorded), NOT `projected_at`: every
      // ordinary content re-push bumps `projected_at`, so an item edited more often than the grace
      // window would never become eligible and its flag would stick forever. `?? projected_at` covers
      // rows written before the column existed.
      const flaggedAt = new Date(row.pending_delete_at ?? row.projected_at).getTime();
      const pastCleanupGrace = flaggedAt <= Date.now() - CLEANUP_GRACE_MS;
      // A SELF-purge clear un-suppresses its partition — only legal once the scoped arc rows are
      // confirmed purged. The gate is the LAST conjunct deliberately: it must evaluate only after
      // the clean checks pass (an earlier draft computed it per-row and re-created the eager purge
      // on dirty groups). Cross-purge clears never touched suppression and stay free.
      if (
        uuids.length === 0 &&
        !deleteFailed &&
        pastCleanupGrace &&
        !saturated &&
        (oldGroup !== row.group_id || (await partitionArcPurgeGate(oldGroup)))
      ) {
        if (orphans.has(row.source_id) && oldGroup === row.group_id) {
          // Orphan, cleanup verified: the item is gone and the group it lives in is empty of it, so
          // the ledger row has nothing left to describe. Clearing the flag instead would leave the
          // row forever (the projector only ever visits rows whose item still exists).
          await db.from("graph_episodes").delete().eq("id", row.id);
        } else if (orphans.has(row.source_id)) {
          // Orphan whose flag pointed at a DIFFERENT group (a tier move whose cleanup was still
          // outstanding when the item was purged). That group is now verified empty — but the row's
          // OWN group has never been checked, and dropping the row here would delete the only pointer
          // to those episodes. Re-point the flag instead; the next pass verifies the second group and
          // then takes the branch above.
          await db
            .from("graph_episodes")
            .update({ pending_delete_group_id: row.group_id, pending_delete_at: new Date().toISOString() })
            .eq("id", row.id);
        } else {
          await db
            .from("graph_episodes")
            .update({ pending_delete_group_id: null, pending_delete_at: null })
            .eq("id", row.id);
        }
        cleaned++;
        if (isExternalGroupId(oldGroup)) cleanedExternal++;
      }
    }
  }

  // Outstanding cleanups AFTER this pass — the tier-isolation signal worth alerting on (old-tier
  // episodes that are purgeable but not yet verified purged). Re-read rather than derived from the
  // in-memory rows so a concurrent projector's new flags are counted. Uses the partial index.
  const { data: pendingRows, error: pendingErr } = await db
    .from("graph_episodes")
    .select("id")
    .eq("team_id", teamId)
    .not("pending_delete_group_id", "is", null);
  // RECONULL-1: this count is the durable tier-isolation signal (outstanding old-tier purges); a
  // swallowed error here read as ZERO — the one value that erases the signal. It is now a run error
  // (the pass's counters and mutations are all retained).
  const errors: string[] = [];
  if (pendingErr) errors.push(`reconcile: pending-cleanup count failed: ${pendingErr.message}`);
  // On a failed re-read the count is what THIS pass knows (the pending rows it loaded minus the
  // ones it verified clean) — never a false zero beside the error (Codex diff review M1).
  const knownPending = Math.max(0, [...pendingByGroup.values()].reduce((n, g) => n + g.length, 0) - cleaned);

  return {
    groupsChecked: byGroup.size,
    confirmed,
    reQueued,
    cleaned,
    cleanedExternal,
    pendingCleanups: pendingErr ? knownPending : (pendingRows ?? []).length,
    requeueThrottled,
    saturatedGroups,
    deepResolvedGroups,
    lookupMismatchGroups,
    deepRequeueHeld,
    deepRequeueHeldByGroup,
    deepRequeueSample: boundDeepRequeueSample(heldRefs),
    deepRequeueElided: Math.max(0, heldRefs.length - DEEP_REQUEUE_SAMPLE_LIMIT),
    deepRequeueEnabled: deepRequeue,
    unreachableGroups,
    unreachableCleanupGroups,
    emptyListingGroups,
    requeueEligible,
    errors,
    partialItems,
    partialDetail: boundPartialDetail(partialFound),
  };
}

/** The "individually inspectable" bound: up to this many held identities ride the durable row, so an
 *  operator can check EVERY candidate before enabling re-queue (spec D4(a)). Past it the population is
 *  non-enumerable from ingest_runs and the flag stays ineligible — stated, not truncated. */
export const DEEP_REQUEUE_SAMPLE_LIMIT = 50;

/** OLDEST `projectedAt` first (total order: projectedAt, itemId, groupId, teamId), bounded at
 *  DEEP_REQUEUE_SAMPLE_LIMIT — deterministic so two passes' samples are comparable. Used by reconcile
 *  per team and by the runner to re-bound across teams. */
export function boundDeepRequeueSample(refs: readonly DeepRequeueRef[]): DeepRequeueRef[] {
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...refs]
    .sort((a, b) => cmp(a.projectedAt, b.projectedAt) || cmp(a.itemId, b.itemId) || cmp(a.groupId, b.groupId) || cmp(a.teamId, b.teamId))
    .slice(0, DEEP_REQUEUE_SAMPLE_LIMIT);
}
