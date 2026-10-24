/**
 * What one Google Drive coordinator report contributes to the Admin run ledger (`ingest_runs`) —
 * the ledger whose failure STREAK drives the loud pipeline banner (`lib/ingest/pipeline-health`).
 *
 * The durable per-run report (`gdrive_run_requests`) is always kept; this decides only whether the
 * ledger gains a row, and whether that row is a success or a failure. Three answers:
 *
 *   · `success`  — an AUTHORITATIVELY complete run (`status=complete` AND `authoritativeComplete`)
 *                  with no failed work: the explicit recovery invariant. It ends a failure streak and
 *                  is the only thing that may.
 *   · `failure`  — any run that failed work, failed outright, or deferred for any reason other than
 *                  the exact busy shape below — and a `complete` report that does NOT claim
 *                  authoritative completion. That report is self-contradictory (the coordinator
 *                  sends `complete` only on authoritative completion), so it is never trusted to
 *                  clear a streak; it extends it.
 *   · `neutral`  — a run that is neither: NO ledger row, so it can neither confirm a failure banner
 *                  nor clear a genuine one, and it never advances complete-success time.
 *
 * Neutral is exactly two shapes (AIO-1167 r36 F1, r37):
 *   1. a VERIFIED busy deferral — another coordinator held the lease; this run did nothing;
 *   2. HEALTHY PARTIAL PROGRESS — the run worked, failed nothing, and is not yet authoritatively
 *      complete (a run budget, a rate-limit or deadline deferral, a staged snapshot still uploading).
 * A partial run that failed work is a failure. A refused execution authority other than busy is
 * reported by the sidecar with failed work, so it can never pass for healthy progress.
 */
export interface GdriveRunOutcome {
  status: "complete" | "partial" | "failed" | "deferred";
  created: number;
  updated: number;
  unchanged: number;
  removed: number;
  failed: number;
  authoritativeComplete: boolean;
  error?: string;
}

export type GdriveLedgerDisposition = "success" | "failure" | "neutral";

/** The exact `execution_busy` deferral the coordinator reports: nothing done, nothing failed. */
export function isVerifiedBusyDeferral(outcome: GdriveRunOutcome): boolean {
  return outcome.status === "deferred"
    && outcome.error === "execution_busy"
    && outcome.failed === 0
    && outcome.created === 0 && outcome.updated === 0 && outcome.unchanged === 0 && outcome.removed === 0
    && !outcome.authoritativeComplete;
}

/** Progress without failure that is not yet authoritatively complete. */
export function isHealthyPartial(outcome: GdriveRunOutcome): boolean {
  return outcome.status === "partial" && outcome.failed === 0 && !outcome.authoritativeComplete;
}

export function gdriveLedgerDisposition(outcome: GdriveRunOutcome): GdriveLedgerDisposition {
  // Recovery requires the authoritative claim itself, not just the status word: a `complete` report
  // without it falls through to failure below (it is neither busy nor partial).
  if (outcome.status === "complete" && outcome.authoritativeComplete && outcome.failed === 0) return "success";
  if (isVerifiedBusyDeferral(outcome) || isHealthyPartial(outcome)) return "neutral";
  return "failure";
}
