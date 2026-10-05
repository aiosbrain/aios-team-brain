import "server-only";
import { adminClient } from "@/lib/db/admin";
import { isCopiedStagingRuntime } from "@/lib/staging/runtime-policy";
import {
  discoverPendingAttributionRepairs,
  onAttributionRepairKick,
  runScheduledAttributionRepairTurn,
  type PendingRepairTeam,
  type RepairTurnDisposition,
} from "./reconcile-attribution";

/**
 * In-process attribution-repair poller — prompt, bounded continuation of the team-wide repair that
 * every roster or identity-mapping change leaves pending. Started once from
 * instrumentation.register() on server boot (Node runtime only), like the other pollers, but on
 * timers of its own: it is not a leg of the 30-minute ingest chain and does not wait behind one.
 * Attribution-dependent reads are fenced until a team's repair completes, so how soon it completes
 * is an availability property, not housekeeping.
 *
 * THE QUEUE IS THE AUTHORITY TABLE. There is no second durable queue and no in-memory one that
 * matters: a round asks `team_identity_authority` which teams have unfinished work whose retry
 * deadline has passed, oldest-touched first, and gives each ONE turn — a single bounded batch or a
 * finalization. A turn touches its team's row, so the order rotates by itself and a team with a
 * very large repair cannot hold up the others. Whatever a crash interrupts is found again by the
 * same question at the next boot.
 *
 *   - A round in which any team still has work to do NOW is followed by the next round at once —
 *     back to back, with no timer between them: healthy partial progress is continuation, never
 *     failure and never a wait. Each round asks the table again, so a team that became pending
 *     meanwhile is in the very next one, and a per-round cap only defers a team by a round.
 *   - A round with nothing to continue — no pending team, only turns owned elsewhere (`busy`), or
 *     only failures, which are in durable backoff and not rediscovered until due — waits the idle
 *     interval and asks again. That timer is the only one this poller arms.
 *   - A kick (an Admin hook, a caller whose budget ran out) only brings the next round forward.
 *     Nothing depends on one arriving.
 *
 * Opt out with ATTRIBUTION_REPAIR_POLL_ENABLED=false; the ingest chain keeps a bounded backstop.
 * Disabled on a copied-staging runtime, as every in-process scheduler is.
 */

/** While idle, look for durable pending work this often. */
export const REPAIR_IDLE_POLL_MS = 5_000;
/** Teams given a turn per round. More pending teams than this simply take more rounds. */
export const REPAIR_TEAMS_PER_ROUND = 20;

export interface RepairRoundSummary {
  attempted: number;
  continuing: number;
  settled: number;
  busy: number;
  deferred: number;
  failed: number;
  /** The round filled its page: more pending teams may be waiting behind the cap. */
  capped: boolean;
}

export interface AttributionRepairLoopDeps {
  /** Teams with durable unfinished repair whose retry deadline has passed, oldest-touched first:
   * at most `limit` of them, after the first `skip` in that order. */
  discover: (limit: number, skip: number) => Promise<PendingRepairTeam[]>;
  /** One bounded turn. Throws when the turn FAILED (its durable retry state is already written). */
  runTurn: (team: PendingRepairTeam) => Promise<RepairTurnDisposition>;
  idleMs?: number;
  teamsPerRound?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onFailure?: (team: PendingRepairTeam | null, error: unknown) => void;
}

export interface AttributionRepairLoop {
  /** Begin: the first round is discovery at boot. Idempotent. */
  start(): void;
  /** Bring the next round forward. A no-op before `start` and after `stop`. */
  kick(): void;
  stop(): void;
  /** One round, exactly as the loop runs it: discover, then one turn per discovered team. */
  runRound(): Promise<RepairRoundSummary>;
}

export function createAttributionRepairLoop(deps: AttributionRepairLoopDeps): AttributionRepairLoop {
  const idleMs = Math.max(1, deps.idleMs ?? REPAIR_IDLE_POLL_MS);
  const teamsPerRound = Math.max(1, deps.teamsPerRound ?? REPAIR_TEAMS_PER_ROUND);
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  });
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
  let timer: unknown = null;
  let active = false;
  // In-process single flight: one round at a time. Ownership across processes is the repair turn.
  let running = false;
  let kicked = false;
  // How far into the durable order the next page starts (see `runRound`). Position in a pass over
  // the queue, nothing more: lost on restart, and nothing is wrong when it is.
  let skip = 0;
  const takeKick = (): boolean => {
    const was = kicked;
    kicked = false;
    return was;
  };

  const arm = (ms: number) => {
    if (!active) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      void pump();
    }, ms);
  };

  async function runRound(): Promise<RepairRoundSummary> {
    const summary: RepairRoundSummary = {
      attempted: 0, continuing: 0, settled: 0, busy: 0, deferred: 0, failed: 0, capped: false,
    };
    for (const team of await deps.discover(teamsPerRound, skip)) {
      summary.attempted++;
      try {
        summary[await deps.runTurn(team)]++;
      } catch (error) {
        // The failed turn rolled back and recorded its own retry deadline; the team is not
        // rediscovered until that passes. One team's failure never ends the round for the rest.
        summary.failed++;
        deps.onFailure?.(team, error);
      }
    }
    // THE CAP DEFERS, IT NEVER HIDES. A turn that did something touched its team's row and sent it
    // to the back of the durable order. A turn that could not — owned elsewhere, deferred, failed —
    // touched nothing, so that team is still at the front; a page full of those would be handed
    // back by every discovery, in front of everyone behind it. So a capped round is followed at
    // once by the next page, past the teams that did not move, and the first page that comes back
    // short ends the pass and starts the next one from the front again.
    summary.capped = summary.attempted >= teamsPerRound;
    skip = summary.capped ? skip + summary.busy + summary.deferred + summary.failed : 0;
    return summary;
  }

  /**
   * Rounds, back to back, for as long as there is something to continue; then one idle timer.
   *
   * Continuation is NOT a timer. A zero-delay timer is not zero — Node runs it at least a
   * millisecond later, behind every other due timer — so "schedule the next round immediately" on a
   * timer would put the clock between every pair of batches of a repair that is otherwise ready to
   * go. The next round simply starts when the last one returns. Nothing is starved by that: every
   * round begins with a database round trip, so the event loop is yielded to on each one.
   */
  async function pump(): Promise<void> {
    if (running) {
      kicked = true;
      return;
    }
    running = true;
    try {
      let more = true;
      while (more && active) {
        try {
          const summary = await runRound();
          // Taken after the round: a kick that arrived during it may be about work this round's
          // discovery was too early to see, and earns exactly one more round however many came.
          const kickedMeanwhile = takeKick();
          more = summary.continuing > 0 || summary.capped || kickedMeanwhile;
        } catch (error) {
          // Discovery itself failed (the database is unreachable): ask again at the idle interval,
          // from the front, whatever was kicked meanwhile.
          deps.onFailure?.(null, error);
          takeKick();
          skip = 0;
          more = false;
        }
      }
    } finally {
      running = false;
    }
    arm(idleMs);
  }

  return {
    start() {
      if (active) return;
      active = true;
      arm(0);
    },
    kick() {
      if (!active) return;
      if (running) kicked = true;
      else arm(0);
    },
    stop() {
      active = false;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    runRound,
  };
}

let started = false;

export function startAttributionRepairScheduler(): void {
  if (started) return;
  if (process.env.ATTRIBUTION_REPAIR_POLL_ENABLED === "false") return;
  // instrumentation.register() already returns before any scheduler on a copied-staging runtime;
  // this start refuses for itself as well, so no other caller can arm it there.
  if (isCopiedStagingRuntime()) return;
  started = true;

  const loop = createAttributionRepairLoop({
    discover: (limit, skip) => discoverPendingAttributionRepairs(limit, { skip }),
    runTurn: (team) => runScheduledAttributionRepairTurn(adminClient(), team),
    onFailure: (team, error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        team
          ? `[attribution-repair] turn failed for team ${team.teamId} (retry is durable): ${message}`
          : `[attribution-repair] discovery failed: ${message}`,
      );
    },
  });
  onAttributionRepairKick(() => loop.kick());
  // Arms a timer and returns: register() must complete before the server takes requests, and the
  // boot discovery runs on the first turn of the event loop after it.
  loop.start();
  console.info(
    `[attribution-repair] scheduler started — one bounded batch per team turn, idle poll every ${REPAIR_IDLE_POLL_MS / 1000}s`,
  );
}
