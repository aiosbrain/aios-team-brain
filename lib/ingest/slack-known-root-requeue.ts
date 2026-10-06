import type { TransactionSession } from "@/lib/db/types";
import type { SlackKnownRootEntry, SlackKnownRootExecution } from "./slack-known-root-page";

/**
 * AIO-1170 AC-02 — INACTIVE preparation of completed-root reconciliation work
 * (`docs/design/slack-known-root-requeue-spec.md`, §5, §6 and §8).
 *
 * RED-CHECKPOINT STUB. This file fixes the typed public surface only, so the behavioural tests
 * compile and fail on behaviour. `prepareSlackKnownRootRequeue` does no work and reports a
 * placeholder refusal; the classifier and the tally reducer return fixed placeholders and inspect
 * nothing. No SQL, no lock, no enqueue, no validation. The accepted algorithms replace every body.
 *
 * Nothing in the application imports this module
 * (`test/guards/slack-known-root-requeue-not-wired.test.ts`, `test/guards/slack-source-not-wired.test.ts`).
 */

export const SLACK_KNOWN_ROOT_UNATTESTED_REASONS = [
  "not_slack",
  "invalid_metadata",
  "missing_channel_binding",
  "missing_namespace_pin",
  "item_missing",
  "canonical_mismatch",
  "missing_root_witness",
  "contradictory_ledger",
] as const;

export const SLACK_KNOWN_ROOT_REFUSED_REASONS = [
  "namespace_changed_or_unready",
  "source_not_current",
  "binding_changed",
  "channel_not_public",
  "scoped_path_conflict",
  "legacy_path_conflict",
] as const;

/** The safe reporting vocabulary for a preparation that THREW. Nothing else is reportable. */
export const SLACK_KNOWN_ROOT_FAILURE_CATEGORIES = [
  "lock_timeout",
  "statement_timeout",
  "deadline_exceeded",
  "serialization_failure",
  "deadlock",
  "database_failure",
  "dependency_failure",
  "commit_unknown",
] as const;

export type SlackKnownRootUnattestedReason = (typeof SLACK_KNOWN_ROOT_UNATTESTED_REASONS)[number];
export type SlackKnownRootRefusedReason = (typeof SLACK_KNOWN_ROOT_REFUSED_REASONS)[number];
export type SlackKnownRootFailureCategory = (typeof SLACK_KNOWN_ROOT_FAILURE_CATEGORIES)[number];

/** Provisional until the caller's transaction commits. Never `{ ok: false }`. */
export type SlackKnownRootPreparationResult =
  | { readonly outcome: "enqueued" }
  | { readonly outcome: "already_pending" }
  | { readonly outcome: "not_due" }
  | { readonly outcome: "unattested"; readonly reason: SlackKnownRootUnattestedReason }
  | { readonly outcome: "refused"; readonly reason: SlackKnownRootRefusedReason };

/**
 * Everything a caller supplies: the team and one complete enumerated entry. No workspace, channel,
 * integration, root, token, fingerprint or revision of its own.
 */
export interface SlackKnownRootRequeueInput {
  readonly teamId: string;
  readonly entry: SlackKnownRootEntry;
}

/**
 * Recreate the missing pending row of one witnessed, canonical, previously published root.
 *
 * STUB: does nothing and reports a placeholder refusal for every input.
 */
export async function prepareSlackKnownRootRequeue(
  session: TransactionSession,
  input: SlackKnownRootRequeueInput,
  execution: SlackKnownRootExecution
): Promise<SlackKnownRootPreparationResult> {
  void session;
  void input;
  void execution;
  return { outcome: "refused", reason: "source_not_current" };
}

/**
 * The final rejection of a complete transaction promise, as exactly one reportable category.
 *
 * STUB: inspects nothing and returns one fixed placeholder.
 */
export function classifySlackKnownRootPreparationFailure(error: unknown): SlackKnownRootFailureCategory {
  void error;
  return "dependency_failure";
}

/** One terminal receipt per page slot. A callback result still awaiting its commit is not one. */
export type SlackKnownRootReceipt =
  | { readonly entryIndex: number; readonly state: "not_attempted"; readonly attempts: 0 }
  | {
      readonly entryIndex: number;
      readonly state: "committed";
      readonly attempts: 1 | 2;
      readonly result: SlackKnownRootPreparationResult;
    }
  | {
      readonly entryIndex: number;
      readonly state: "failed";
      /** Callbacks that actually ran: 0 when transaction setup failed before any did. */
      readonly attempts: 0 | 1 | 2;
      readonly failure: SlackKnownRootFailureCategory;
    };

export interface SlackKnownRootPageTallyInput {
  /** The committed page's examined count, 0–100. Its entry order defines `entryIndex`. */
  readonly examined: number;
  readonly receipts: readonly SlackKnownRootReceipt[];
}

/**
 * Counters and closed category counts only: no receipt, item id, cursor or error.
 *
 * `examined = enqueued + already_pending + not_due + unattested + refused + preparation_failed + not_attempted`.
 */
export interface SlackKnownRootPageTally {
  readonly examined: number;
  readonly enqueued: number;
  readonly already_pending: number;
  readonly not_due: number;
  readonly unattested: number;
  readonly refused: number;
  readonly preparation_failed: number;
  readonly not_attempted: number;
  readonly unattestedCounts: Readonly<Record<SlackKnownRootUnattestedReason, number>>;
  readonly refusedCounts: Readonly<Record<SlackKnownRootRefusedReason, number>>;
  readonly failureCounts: Readonly<Record<SlackKnownRootFailureCategory, number>>;
}

function zeroCounts<K extends string>(keys: readonly K[]): Record<K, number> {
  const counts = {} as Record<K, number>;
  for (const key of keys) counts[key] = 0;
  return counts;
}

/**
 * One contribution per enumerated page slot, after every started invocation has settled.
 *
 * STUB: validates nothing, reads no receipt and returns the same placeholder for every input. Its
 * `examined` is deliberately impossible (-1), so it is not the correct tally of an empty page either.
 */
export function tallySlackKnownRootPage(input: SlackKnownRootPageTallyInput): SlackKnownRootPageTally {
  void input;
  return {
    examined: -1,
    enqueued: 0,
    already_pending: 0,
    not_due: 0,
    unattested: 0,
    refused: 0,
    preparation_failed: 0,
    not_attempted: 0,
    unattestedCounts: zeroCounts(SLACK_KNOWN_ROOT_UNATTESTED_REASONS),
    refusedCounts: zeroCounts(SLACK_KNOWN_ROOT_REFUSED_REASONS),
    failureCounts: zeroCounts(SLACK_KNOWN_ROOT_FAILURE_CATEGORIES),
  };
}
