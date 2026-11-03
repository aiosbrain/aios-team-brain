import "server-only";
import { isCopiedStagingRuntime } from "@/lib/staging/runtime-policy";
import type { AttributionRepairOutcome } from "./reconcile-attribution";

/**
 * What to TELL someone about an attribution repair that did not finish — the Admin button's answer
 * and the post-mutation hooks' log line.
 *
 * A bounded repair that ends `continuing` has saved its progress on the authority row. Whether
 * anything then carries it on is a property of the DEPLOYMENT, not of the repair:
 *
 *   background  an in-process poller continues it — the dedicated repair scheduler, or the ingest
 *               chain's bounded backstop when only that one is running;
 *   manual      nothing does. On a copied-staging runtime every in-process scheduler is suppressed
 *               on purpose (`instrumentation.register`), and the same is true of a deployment that
 *               switched both pollers off. The repair still converges — the trusted manual action
 *               resumes it from the saved cursor through to the strict finalization — but only
 *               when an authorized admin runs it again, and until then attribution-dependent reads
 *               stay fenced.
 *
 * This module reports that difference; it changes nothing about it. It starts no scheduler, exempts
 * no fence and completes no repair.
 */
export type RepairContinuation = "background" | "manual";

/** The Admin control that runs the manual repair (`components/admin/reattribute-button`). */
export const MANUAL_REPAIR_CONTROL = "Re-attribute content";

export function attributionRepairContinuation(env: NodeJS.ProcessEnv = process.env): RepairContinuation {
  if (isCopiedStagingRuntime(env)) return "manual";
  const dedicated = env.ATTRIBUTION_REPAIR_POLL_ENABLED !== "false";
  const ingestBackstop = env.INGEST_POLL_ENABLED !== "false";
  return dedicated || ingestBackstop ? "background" : "manual";
}

function progress(outcome: AttributionRepairOutcome): string {
  const versions = outcome.versionsUpdated ? ` + ${outcome.versionsUpdated} version(s)` : "";
  return `Re-attributed ${outcome.updated} of ${outcome.scanned} item(s)${versions}`;
}

/**
 * Whether the outcome KNOWS of work this invocation committed. A bounded run takes the team's turn
 * batch by batch and lets go of it in between, so it can commit several batches and only then find
 * another owner on the turn: `busy` says how it ended, not what it did.
 *
 * The converse does not hold, and nothing here may be built on it. The counters describe ONE
 * revision's repair and start again when a newer revision replaces it, so a run can commit a batch
 * at revision R, see R+1 arrive, lose R+1's turn, and return `busy` with every counter at zero.
 * Zero counters mean "no committed work is known at the current revision" — never "this run did
 * nothing".
 */
function knownCommittedWork(outcome: AttributionRepairOutcome): boolean {
  return outcome.scanned > 0 || outcome.updated > 0 || outcome.versionsUpdated > 0 || outcome.contributionsUpdated > 0;
}

/**
 * The Admin button's message. Four different facts, never run together: the repair COMPLETED; it
 * made progress and stopped at its budget; it made progress and then another run took the team's
 * repair; or it stopped because another run holds the repair, with no progress known at the current
 * revision — which is said as contention and as nothing more: no claim is made about the whole
 * run. In the last three, what happens next is said as it is for this deployment.
 */
export function describeManualRepair(
  outcome: AttributionRepairOutcome,
  continuation: RepairContinuation = attributionRepairContinuation(),
): string {
  if (outcome.status === "complete") return `${progress(outcome)} to current identity mappings.`;
  const worked = knownCommittedWork(outcome);
  if (continuation === "background") {
    if (!outcome.busy) return `${progress(outcome)} so far; re-attribution is continuing in the background.`;
    return worked
      ? `${progress(outcome)} so far; another re-attribution run then took over this team's repair, and re-attribution is continuing in the background.`
      : "Re-attribution is already running for this team and is continuing in the background.";
  }
  const again = `an admin must run ${MANUAL_REPAIR_CONTROL} again`;
  const disabled = "Progress is saved, but background continuation is disabled on this deployment";
  if (!outcome.busy) return `${progress(outcome)} so far; the repair is not complete. ${disabled}: ${again} to continue.`;
  return worked
    ? `${progress(outcome)} so far; another re-attribution run then took over this team's repair, and the repair is not complete. `
      + `${disabled}: ${again} once that run has finished.`
    : `Another re-attribution run holds this team's repair right now, so this run stopped and the repair is not complete. `
      + `${disabled}: ${again} once that run has finished.`;
}

/**
 * The post-mutation hooks' log line for a repair they could not finish, or null when it finished.
 * A hook only accelerates; where nothing continues in the background, the line says who must.
 */
export function describeRepairHandover(
  teamId: string,
  outcome: AttributionRepairOutcome,
  continuation: RepairContinuation = attributionRepairContinuation(),
): string | null {
  if (outcome.status === "complete") return null;
  const why = outcome.busy ? "another run holds its repair" : "its bounded budget ended";
  return continuation === "background"
    ? `[attribution] repair for team ${teamId} is continuing in the background (${why})`
    : `[attribution] repair for team ${teamId} is NOT complete (${why}): progress is saved, but background `
      + `continuation is disabled on this deployment — an admin must run ${MANUAL_REPAIR_CONTROL} again`;
}

/** Log a hook's unfinished repair: informational where it continues by itself, a warning where it
 * waits on a person. */
export function reportRepairHandover(
  teamId: string,
  outcome: AttributionRepairOutcome,
  continuation: RepairContinuation = attributionRepairContinuation(),
): void {
  const line = describeRepairHandover(teamId, outcome, continuation);
  if (!line) return;
  if (continuation === "background") console.info(line);
  else console.warn(line);
}
