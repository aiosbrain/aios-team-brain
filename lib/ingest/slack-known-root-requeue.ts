import { TransactionExecutionError } from "@/lib/db/pg/tx";
import type { TransactionSession } from "@/lib/db/types";
import {
  SlackKnownRootValidationError,
  admitSlackKnownRootExecution,
  captureSlackKnownRootEntry,
  captureSlackKnownRootTeamId,
  runSlackKnownRootOperation,
  type SlackKnownRootEntry,
  type SlackKnownRootExecution,
  type SlackKnownRootLocatedEntry,
} from "./slack-known-root-page";
import { lockReadySlackNamespaceGate } from "./slack-namespace-gate";
import { lockSlackSelection } from "./slack-source-binding";
import { enqueueSlackThread } from "./slack-thread-state";
import { scopedSlackItemPath } from "./sources/slack-namespace";
import { slackChannelPathPrefix } from "./sources/slack-normalize";

/**
 * AIO-1170 AC-02 — INACTIVE preparation of completed-root reconciliation work
 * (`docs/design/slack-known-root-requeue-spec.md`, §5, §6 and §8).
 *
 * `prepareSlackKnownRootRequeue` recreates the missing pending row of ONE previously published,
 * provably canonical Slack root, from the team and one enumerated entry and nothing else. It checks
 * current source authority under the same locks, in the same order, as publication; proves the item
 * canonical and its root witnessed under the item's own lock; and then hands the exact scope and an
 * observation-derived due time to the existing enqueue helper — its only write. It issues no
 * provider request, opens no transaction, and writes no item, ledger row, identity, generation or
 * channel state. A stored proof is checked, never refreshed.
 *
 * The two PURE helpers that account for it — the failure classifier (§8.1) and the page tally
 * reducer (§8.2, §8.3) — are here as well. Neither performs I/O.
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
 * A PostgreSQL SQLSTATE: five characters whose two-character CLASS is one PostgreSQL defines —
 * every class that begins with a digit, and the four that do not (`F0`, `HV`, `P0`, `XX`).
 *
 * The length and alphabet alone are not enough. `EPIPE`, `EPERM`, `EBUSY` and `E2BIG` are five
 * upper-case characters too, and they are Node system error codes: a broken pipe is a dependency
 * failure, not a database one. No PostgreSQL class begins with `E`.
 */
const POSTGRES_SQLSTATE = /^(?:[0-9][0-9A-Z]|F0|HV|P0|XX)[0-9A-Z]{3}$/;

/**
 * The value of one OWN DATA property, or undefined. An accessor is never invoked and a prototype is
 * never consulted, so a hostile getter cannot choose the answer or throw through this function, and
 * a proxy whose trap throws simply has no such property. The markers and the code this module reads
 * are all plain own data properties of the errors that carry them.
 */
function ownDataValue(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/** Known class identity, and nothing read from the instance. A proxy that refuses the question is not one. */
function isTransactionExecutionError(value: object): boolean {
  try {
    return value instanceof TransactionExecutionError;
  } catch {
    return false;
  }
}

/**
 * The FINAL rejection of a complete transaction promise, as exactly one reportable category.
 *
 * Precedence, first match wins:
 *
 *  1. a true `unknownCommit` marker — whatever the callback returned and whatever code is attached,
 *     the one thing known is that the commit's outcome is not;
 *  2. this slice's deadline marker;
 *  3. SQLSTATE `55P03` — a lock wait timed out;
 *  4. SQLSTATE `57014` — a statement was cancelled;
 *  5. SQLSTATE `40001`;
 *  6. SQLSTATE `40P01`;
 *  7. any other PostgreSQL SQLSTATE, or the shared transaction-execution error type;
 *  8. anything else.
 *
 * It reads three own data properties (`unknownCommit`, the deadline marker, `code`) and one class
 * identity. It never reads a message, SQL text, a stack or a cause, and it never serializes,
 * retains, attaches or returns what it was given: the result is one string of the closed
 * vocabulary. It decides no retry, suppresses nothing and cannot throw.
 */
export function classifySlackKnownRootPreparationFailure(error: unknown): SlackKnownRootFailureCategory {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return "dependency_failure";

  if (ownDataValue(error, "unknownCommit") === true) return "commit_unknown";
  if (ownDataValue(error, "slackKnownRootDeadlineExceeded") === true) return "deadline_exceeded";

  const code = ownDataValue(error, "code");
  if (code === "55P03") return "lock_timeout";
  if (code === "57014") return "statement_timeout";
  if (code === "40001") return "serialization_failure";
  if (code === "40P01") return "deadlock";
  if (typeof code === "string" && POSTGRES_SQLSTATE.test(code)) return "database_failure";
  if (isTransactionExecutionError(error)) return "database_failure";
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

/** The largest page a tally can describe: the enumeration's own page-size ceiling. */
const MAX_EXAMINED = 100;

function invalidTally(): never {
  throw new SlackKnownRootValidationError();
}

/** A plain object — never an array, a class instance or a primitive — or null. */
function plainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? (value as Record<string, unknown>) : null;
}

/** True when the record's own keys — string and symbol, enumerable or not — are exactly these. */
function hasExactlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(record);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

function isOneOf<K extends string>(vocabulary: readonly K[], value: unknown): value is K {
  return typeof value === "string" && (vocabulary as readonly string[]).includes(value);
}

/**
 * One validated terminal receipt, reduced to the only facts a tally uses, together with a canonical
 * rendering of ALL its fields. Two receipts for one slot are the same receipt exactly when their
 * renderings are equal — the same state, the same attempt count, the same result or failure.
 */
interface TerminalReceipt {
  readonly entryIndex: number;
  readonly canonical: string;
  readonly parent: "enqueued" | "already_pending" | "not_due" | "unattested" | "refused" | "preparation_failed" | "not_attempted";
  readonly unattested: SlackKnownRootUnattestedReason | null;
  readonly refused: SlackKnownRootRefusedReason | null;
  readonly failure: SlackKnownRootFailureCategory | null;
}

/** A complete closed preparation result (§6): one of five outcomes, with a reason exactly where one belongs. */
function terminalResult(value: unknown): Pick<TerminalReceipt, "parent" | "unattested" | "refused"> & { readonly rendering: string } {
  const result = plainRecord(value);
  if (result === null) return invalidTally();
  const outcome = result.outcome;
  if (outcome === "enqueued" || outcome === "already_pending" || outcome === "not_due") {
    if (!hasExactlyKeys(result, ["outcome"])) return invalidTally();
    return { parent: outcome, unattested: null, refused: null, rendering: outcome };
  }
  if (outcome === "unattested") {
    const reason = result.reason;
    if (!hasExactlyKeys(result, ["outcome", "reason"]) || !isOneOf(SLACK_KNOWN_ROOT_UNATTESTED_REASONS, reason)) return invalidTally();
    return { parent: "unattested", unattested: reason, refused: null, rendering: `unattested/${reason}` };
  }
  if (outcome === "refused") {
    const reason = result.reason;
    if (!hasExactlyKeys(result, ["outcome", "reason"]) || !isOneOf(SLACK_KNOWN_ROOT_REFUSED_REASONS, reason)) return invalidTally();
    return { parent: "refused", unattested: null, refused: reason, rendering: `refused/${reason}` };
  }
  return invalidTally();
}

/**
 * One receipt of the closed grammar (§8.2), or the static error. Each field is read once. A callback
 * result that never reached a commit, a per-attempt record, a receipt carrying anything extra — an
 * item id, an error, SQL — and every value outside its vocabulary are all refused here.
 */
function terminalReceipt(value: unknown, examined: number): TerminalReceipt {
  const receipt = plainRecord(value);
  if (receipt === null) return invalidTally();
  const entryIndex = receipt.entryIndex;
  const state = receipt.state;
  const attempts = receipt.attempts;
  if (typeof entryIndex !== "number" || !Number.isSafeInteger(entryIndex) || entryIndex < 0 || entryIndex >= examined) return invalidTally();

  if (state === "not_attempted") {
    // No preparation invocation was started for this slot.
    if (!hasExactlyKeys(receipt, ["entryIndex", "state", "attempts"]) || attempts !== 0) return invalidTally();
    return { entryIndex, canonical: "not_attempted/0", parent: "not_attempted", unattested: null, refused: null, failure: null };
  }
  if (state === "committed") {
    // The complete transaction promise resolved: at least one callback ran, at most one retry.
    if (!hasExactlyKeys(receipt, ["entryIndex", "state", "attempts", "result"]) || (attempts !== 1 && attempts !== 2)) return invalidTally();
    const result = terminalResult(receipt.result);
    return {
      entryIndex, canonical: `committed/${attempts}/${result.rendering}`, parent: result.parent,
      unattested: result.unattested, refused: result.refused, failure: null,
    };
  }
  if (state === "failed") {
    // The promise finally rejected. Zero attempts is legal: setup can fail before any callback runs.
    const failure = receipt.failure;
    if (!hasExactlyKeys(receipt, ["entryIndex", "state", "attempts", "failure"]) || (attempts !== 0 && attempts !== 1 && attempts !== 2) ||
        !isOneOf(SLACK_KNOWN_ROOT_FAILURE_CATEGORIES, failure)) return invalidTally();
    return {
      entryIndex, canonical: `failed/${attempts}/${failure}`, parent: "preparation_failed",
      unattested: null, refused: null, failure,
    };
  }
  return invalidTally();
}

/**
 * The tally of ONE successfully committed enumeration page: one contribution per page slot, after
 * every started invocation has settled.
 *
 * The whole input is validated and reduced before anything is counted. Every index `0 … examined-1`
 * must be covered. An exact duplicate of a slot's final receipt is collapsed; two different receipts
 * for one slot are a contract error, and neither is chosen. A slot is counted once however many
 * attempts its transaction took, and an unknown commit is a failure of that slot — never the
 * insertion its callback reported.
 *
 * The result holds counters and closed category counts only, in objects of its own: no receipt,
 * item id, cursor or error is retained or returned, so nothing a caller does to its input afterwards
 * can change a tally. Every invalid shape throws the same static validation error.
 */
export function tallySlackKnownRootPage(input: SlackKnownRootPageTallyInput): SlackKnownRootPageTally {
  const slots = new Map<number, TerminalReceipt>();
  let examined: number;
  try {
    const page = plainRecord(input);
    if (page === null || !hasExactlyKeys(page, ["examined", "receipts"])) return invalidTally();
    const count = page.examined;
    const receipts = page.receipts;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > MAX_EXAMINED) return invalidTally();
    if (!Array.isArray(receipts)) return invalidTally();
    examined = count;

    const supplied: number = receipts.length;
    for (let position = 0; position < supplied; position++) {
      const receipt = terminalReceipt(receipts[position] as unknown, examined);
      const known = slots.get(receipt.entryIndex);
      if (known === undefined) slots.set(receipt.entryIndex, receipt);
      else if (known.canonical !== receipt.canonical) return invalidTally();
    }
    // Complete accounting: a slot nobody reported is not silently "not attempted".
    if (slots.size !== examined) return invalidTally();
  } catch {
    // Whatever went wrong while reading caller data — a throwing accessor included — is the same
    // static contract error, and nothing of the input travels with it.
    return invalidTally();
  }

  const parents = { enqueued: 0, already_pending: 0, not_due: 0, unattested: 0, refused: 0, preparation_failed: 0, not_attempted: 0 };
  const unattestedCounts = zeroCounts(SLACK_KNOWN_ROOT_UNATTESTED_REASONS);
  const refusedCounts = zeroCounts(SLACK_KNOWN_ROOT_REFUSED_REASONS);
  const failureCounts = zeroCounts(SLACK_KNOWN_ROOT_FAILURE_CATEGORIES);
  for (const receipt of slots.values()) {
    parents[receipt.parent] += 1;
    if (receipt.unattested !== null) unattestedCounts[receipt.unattested] += 1;
    if (receipt.refused !== null) refusedCounts[receipt.refused] += 1;
    if (receipt.failure !== null) failureCounts[receipt.failure] += 1;
  }

  return Object.freeze({
    examined,
    ...parents,
    unattestedCounts: Object.freeze(unattestedCounts),
    refusedCounts: Object.freeze(refusedCounts),
    failureCounts: Object.freeze(failureCounts),
  });
}
