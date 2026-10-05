import "server-only";
import type { DbClient } from "@/lib/db/types";
import { takeRepairScanTurn } from "./reattribute";
import type { ReattributeOptions, ReattributeSummary } from "./reattribute";
import { staleArcCache } from "@/lib/graph/arc-cache";
import { evictArcMemoryCache, evictTeamPartitionArcMemory } from "@/lib/graph/arcs";
import { bustTeamTimeline } from "@/lib/dashboard/timeline-cache";
import {
  completeIdentityRepair,
  IdentitySnapshotChangedError,
  markIdentityRepairRetry,
  peekIdentityRepairStatus,
  readOwnedIdentityRepairState,
  tryLockAttributionRepairTurn,
} from "@/lib/identity/authority";
import { afterTransactionCommit, runSql, withTransaction } from "@/lib/db/pg/pool";

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

/**
 * ONE TURN of a team's repair, as every entry point takes it.
 *
 *   partial         an owned batch committed and more of the scan remains
 *   awaiting_cache  the scan is finished at this revision; the next turn finalizes
 *   finalized       this turn completed the revision
 *   complete        the revision was already complete — nothing was done
 *   busy            another owner holds the team's turn
 *   deferred        a recorded failure's retry deadline has not passed
 *
 * `partial`, `awaiting_cache`, `busy` and `deferred` all mean durable work remains. None of them is
 * a failure and none writes failure state; a failed turn throws.
 */
export type AttributionRepairTurnStatus =
  | "partial" | "awaiting_cache" | "finalized" | "complete" | "busy" | "deferred";

export interface AttributionRepairTurn {
  status: AttributionRepairTurnStatus;
  summary: ReattributeSummary;
}

export interface AttributionRepairTurnOptions extends ReattributeOptions {
  /** Test-only scheduling point: finalization owns the turn and has validated the revision. */
  beforeFinalize?: () => Promise<void>;
}

/**
 * FINALIZATION — a turn of its own, owned like a batch. Under the turn and the identity-authority
 * lock it validates that the revision is still the one whose scan finished, strictly purges every
 * persisted cache variant, and marks the revision complete while advancing the authorization epoch,
 * all in one transaction. So completion is never visible without the purge, and a builder that read
 * its inputs earlier cannot publish under the epoch that completion made current.
 *
 * A purge failure or a crash leaves the durable row unfinished (`awaiting_cache`, then `retry` once
 * the failure is recorded after the rollback); attribution-dependent reads stay fenced until a later
 * turn finalizes.
 */
async function finalizeAttributionRepair(
  db: DbClient,
  teamId: string,
  teamSlug: string,
  opts: AttributionRepairTurnOptions,
): Promise<AttributionRepairTurn> {
  const owned: { revision: number | null } = { revision: null };
  const nothing = (
    status: AttributionRepairTurnStatus,
    turn: ReattributeSummary["turn"],
    partial: boolean,
  ): AttributionRepairTurn => ({
    status,
    summary: {
      scanned: 0, updated: 0, versionsUpdated: 0, contributionsUpdated: 0,
      revision: owned.revision ?? 0, partial, turn,
    },
  });
  try {
    return await withTransaction(async () => {
      if (!await tryLockAttributionRepairTurn(teamId)) return nothing("busy", "busy", true);
      const state = await readOwnedIdentityRepairState(teamId);
      owned.revision = state.revision;
      if (state.repairStatus === "complete") return nothing("complete", "complete", false);
      // The routing read was unlocked. A newer revision, a recorded failure or another owner has
      // moved the team off finalization since: the scan is owed again, and that is the next turn.
      if (state.repairStatus !== "awaiting_cache") return nothing("partial", "scanned", true);
      await opts.beforeFinalize?.();
      await purgeTeamLearningCachesStrict(db, teamId, teamSlug);
      await completeIdentityRepair(teamId, state.revision);
      return nothing("finalized", "complete", false);
    });
  } catch (error) {
    // The finalization has rolled back; the failure is recorded outside it, against the revision
    // it was finalizing and no other. One that failed before it could read that revision records
    // nothing: there is no "whatever is current now" to blame.
    if (owned.revision !== null && !(error instanceof IdentitySnapshotChangedError)) {
      await opts.beforeFailureRecord?.();
      await markIdentityRepairRetry(teamId, owned.revision, error).catch(() => {});
    }
    throw error;
  }
}

/**
 * Take one turn for a team: the finalization if its scan is finished, otherwise one scan batch.
 * A turn CONTINUES durable work and nothing else — a complete revision is a no-op — unless the
 * caller passes `request`, which durably reopens a finished revision first and so is never routed
 * to a finalization.
 */
export async function runAttributionRepairTurn(
  db: DbClient,
  teamId: string,
  teamSlug: string,
  opts: AttributionRepairTurnOptions = {},
): Promise<AttributionRepairTurn> {
  if (!opts.request && await peekIdentityRepairStatus(teamId) === "awaiting_cache") {
    return finalizeAttributionRepair(db, teamId, teamSlug, opts);
  }
  const summary = await takeRepairScanTurn(db, teamId, opts);
  if (summary.turn === "scanned") return { status: summary.partial ? "partial" : "awaiting_cache", summary };
  return { status: summary.turn, summary };
}

/** Counters describe one revision's repair; a newer revision starts them again. */
function accumulate(total: ReattributeSummary | null, current: ReattributeSummary): ReattributeSummary {
  if (!total) return current;
  if (current.revision === 0) return { ...total, partial: current.partial, turn: current.turn };
  if (total.revision !== 0 && total.revision !== current.revision) return current;
  return {
    ...current,
    scanned: total.scanned + current.scanned,
    updated: total.updated + current.updated,
    versionsUpdated: total.versionsUpdated + current.versionsUpdated,
    contributionsUpdated: total.contributionsUpdated + current.contributionsUpdated,
  };
}

// A scheduler in this process, if one is running, registers here. A kick is acceleration only: the
// durable authority row is the queue, and the scheduler finds it without ever being told.
let wake: (() => void) | null = null;

export function onAttributionRepairKick(listener: (() => void) | null): void {
  wake = listener;
}

/** Ask this process's scheduler to look now rather than at its next poll. Post-commit by
 * construction: issued inside a transaction, it runs only once that transaction has committed. */
export function kickAttributionRepair(): void {
  void afterTransactionCommit(async () => { wake?.(); });
}

export interface AttributionRepairOutcome extends ReattributeSummary {
  /** `continuing`: the bounded budget ended, or another owner holds the team's turn. Durable work
   * remains and the scheduler carries it on. It is a report, never an error. */
  status: "complete" | "continuing";
  /** The call stopped because another owner holds the team's turn. */
  busy: boolean;
}

/**
 * Strict/manual form: take turns for one team until its revision is complete or the bounded budget
 * of scan batches is spent. Unlike the background coalescer, a FAILED turn propagates to the caller
 * while the durable authority row records the retry. A spent budget or a busy turn does not: it
 * returns `continuing` with what was done so far, and kicks the scheduler.
 *
 * By default it continues whatever repair is durable — after a roster or mapping change that is
 * the repair the change enqueued, and a revision that is already complete is a no-op. `request`
 * (the manual "Re-attribute content" button) first enqueues one: its first turn durably reopens a
 * finished revision, and every later turn, here or in the scheduler, simply continues it.
 */
export async function repairAttributionNow(
  db: DbClient,
  teamId: string,
  teamSlug: string,
  opts: { maxBatches?: number } & AttributionRepairTurnOptions = {},
): Promise<AttributionRepairOutcome> {
  const { maxBatches: requested, request, ...turnOpts } = opts;
  const maxBatches = Math.max(1, Math.min(100, requested ?? 20));
  let total: ReattributeSummary = {
    scanned: 0, updated: 0, versionsUpdated: 0, contributionsUpdated: 0, revision: 0, partial: true, turn: "scanned",
  };
  let scans = 0;
  let last: AttributionRepairTurn | null = null;
  const continuing = (busy: boolean): AttributionRepairOutcome => {
    kickAttributionRepair();
    return { ...total, partial: true, status: "continuing", busy };
  };
  // Every scan batch may be followed by a finalization, and a revision that changes mid-way starts
  // its scan again; the turn cap bounds that churn as the scan cap bounds the work.
  for (let turns = 0; turns < maxBatches + 2; turns++) {
    if (last?.status === "partial" && scans >= maxBatches) break;
    last = await runAttributionRepairTurn(db, teamId, teamSlug, {
      ...turnOpts, request: request === true && turns === 0,
    });
    total = accumulate(turns === 0 ? null : total, last.summary);
    if (last.status === "complete" || last.status === "finalized") {
      return { ...total, partial: false, status: "complete", busy: false };
    }
    if (last.status === "busy" || last.status === "deferred") return continuing(last.status === "busy");
    if (last.summary.turn === "scanned") scans++;
  }
  return continuing(false);
}

export interface PendingRepairTeam {
  teamId: string;
  teamSlug: string;
}

/**
 * The durable queue IS the authority table: every team whose current revision is not complete and
 * whose retry deadline, if it has one, has passed. Oldest-touched first — each turn touches its
 * team's row, so the order rotates and no team waits behind another's long repair.
 */
export async function discoverPendingAttributionRepairs(
  limit: number,
  opts: { exclude?: readonly string[] } = {},
): Promise<PendingRepairTeam[]> {
  // `exclude` names teams. There is deliberately no offset: the set this query ranges over changes
  // between any two calls (a deadline passes or is set, a turn sends its team to the back), so a
  // position means a different team every time it is used.
  const { rows } = await runSql<{ team_id: string; slug: string }>(
    `select a.team_id,t.slug from team_identity_authority a
       join teams t on t.id=a.team_id
      where a.repair_status in ('pending','running','retry','awaiting_cache')
        and (a.next_attempt_at is null or a.next_attempt_at<=now())
        and not (a.team_id = any($2::uuid[]))
      order by a.updated_at,a.team_id limit $1`,
    [Math.max(1, Math.min(100, limit)), [...(opts.exclude ?? [])]],
  );
  return rows.map((row) => ({ teamId: row.team_id, teamSlug: row.slug }));
}

/** What a scheduled turn left behind, as the scheduler needs it: is there more to do NOW? */
export type RepairTurnDisposition = "continuing" | "settled" | "busy" | "deferred";

/** One scheduled turn: a single bounded batch or a finalization, honoring a retry deadline. */
export async function runScheduledAttributionRepairTurn(
  db: DbClient,
  team: PendingRepairTeam,
  opts: { batchSize?: number } = {},
): Promise<RepairTurnDisposition> {
  try {
    const turn = await runAttributionRepairTurn(db, team.teamId, team.teamSlug, {
      batchSize: opts.batchSize, honorRetryDeadline: true,
    });
    if (turn.status === "partial" || turn.status === "awaiting_cache") return "continuing";
    if (turn.status === "busy" || turn.status === "deferred") return turn.status;
    return "settled";
  } catch (error) {
    // A newer revision replaced the one this turn nominated. It wins, its progress starts over,
    // and that is work to continue with — not a failure of anything.
    if (error instanceof IdentitySnapshotChangedError) return "continuing";
    throw error;
  }
}

/** Bounded backstop on the ingest chain, for a deployment whose dedicated repair scheduler is off
 * or was not running when a repair was left pending. Shares the turn with every other entry point. */
export async function drainPendingAttributionRepairs(
  db: DbClient,
  opts: { maxTeams?: number; maxBatchesPerTeam?: number; batchSize?: number } = {},
): Promise<{ attempted:number;complete:number;continuing:number;failed:number }> {
  const teams=await discoverPendingAttributionRepairs(opts.maxTeams ?? 20);
  let complete=0;
  let continuing=0;
  let failed=0;
  for (const team of teams) {
    try {
      const outcome=await repairAttributionNow(db,team.teamId,team.teamSlug,{
        maxBatches:opts.maxBatchesPerTeam ?? 10,batchSize:opts.batchSize,honorRetryDeadline:true,
      });
      if (outcome.status === "complete") complete++;
      else continuing++;
    } catch {
      failed++;
    }
  }
  return { attempted:teams.length,complete,continuing,failed };
}

// Per-team trailing-edge coalescer: at most one reattribute scan per team at a time; a call arriving
// mid-run queues exactly ONE trailing pass. It collapses N rapid mapping edits into ≤2 passes in this
// process. It is an economy, not the serialization: the repair turn is what makes owners exclusive,
// across processes as well. Per-process state (module-level).
const running = new Set<string>();
const dirty = new Set<string>();

async function runReconcile(db: DbClient, teamId: string, teamSlug: string): Promise<void> {
  try {
    await repairAttributionNow(db, teamId, teamSlug);
  } catch (err) {
    console.error("[attribution] reconcile failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Re-attribute all of a team's items from current identity mappings + refresh arcs. Coalesced per team.
 * Run in `after()` from the association-changing admin actions (identity link/unlink, email add/remove,
 * github link). NOT for the NL correction box — that already re-pointed `member_id` directly, so it only
 * needs `bustTeamLearningCaches` (re-running reattribute there would fight the correction).
 *
 * It only accelerates. The mutation already made the repair durable, so a pass that ends `continuing`,
 * finds the turn busy, or fails outright loses nothing: the scheduler continues from the authority row.
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
