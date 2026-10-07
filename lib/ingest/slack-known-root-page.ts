import type { TransactionSession } from "@/lib/db/types";

/**
 * AIO-1170 AC-02 — INACTIVE enumeration of previously published Slack roots
 * (`docs/design/slack-known-root-requeue-spec.md`, §4 and §7).
 *
 * PARTLY IMPLEMENTED. `createSlackKnownRootExecution` is the accepted validation and deadline
 * calculation (§7.2). `readSlackKnownRootItemPage` is STILL THE RED-CHECKPOINT PLACEHOLDER: it reads
 * nothing, validates nothing, checks no deadline and decorates no session, and returns a fixed page
 * that is deliberately not a valid one. The accepted enumeration replaces that body.
 *
 * Nothing in the application imports this module
 * (`test/guards/slack-known-root-requeue-not-wired.test.ts`, `test/guards/slack-source-not-wired.test.ts`).
 */

export const SLACK_KNOWN_ROOT_LIMITS = Object.freeze({
  /** Items examined by one page. The lookahead id is not an examined item. */
  pageSize: Object.freeze({ min: 1, max: 100 }),
  /** The revisit policy. There is no runtime default: every first-page request states it. */
  revisitAfterMs: Object.freeze({ min: 60_000, max: 86_400_000 }),
  /** The operation allowance of one execution context, shared by every transaction attempt. */
  allowanceMs: Object.freeze({ default: 2_000, min: 1_000, max: 5_000 }),
  /** The cap on any single lock wait. */
  lockTimeoutMs: 250,
});

export const SLACK_KNOWN_ROOT_CURSOR_VERSION = 1;

/** A structured continuation: internal metadata, not a viewer API, a capability or sweep state. */
export interface SlackKnownRootCursor {
  readonly version: typeof SLACK_KNOWN_ROOT_CURSOR_VERSION;
  readonly teamId: string;
  /** The upper bound of the key range the first page froze. */
  readonly upperItemId: string;
  /** The last EXAMINED id. The item need not exist any more. */
  readonly afterItemId: string;
  /** The revisit policy the traversal was started with. */
  readonly revisitAfterMs: number;
}

export interface SlackKnownRootPageRequest {
  readonly teamId: string;
  /** Integer, 1–100. */
  readonly pageSize: number;
  /** Integer milliseconds, 60,000–86,400,000. Required; echoed into every entry. */
  readonly revisitAfterMs: number;
  /** Absent on a first page. */
  readonly cursor?: SlackKnownRootCursor;
}

/** Durable facts read during enumeration. Not a capability: preparation checks every one again. */
export interface SlackKnownRootLocator {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly rootTs: string;
  readonly integrationId: string;
  readonly bindingConfigRevision: string;
  readonly namespaceRevision: number;
}

export type SlackKnownRootUnlocatedCategory =
  | "not_slack"
  | "invalid_metadata"
  | "missing_channel_binding"
  | "missing_namespace_pin";

interface SlackKnownRootEntryBase {
  readonly teamId: string;
  readonly itemId: string;
  /** The validated, echoed policy. Not durable source evidence and not an authority credential. */
  readonly revisitAfterMs: number;
}

export interface SlackKnownRootLocatedEntry extends SlackKnownRootEntryBase {
  readonly locator: SlackKnownRootLocator;
}

export interface SlackKnownRootUnlocatedEntry extends SlackKnownRootEntryBase {
  readonly unlocated: SlackKnownRootUnlocatedCategory;
}

/** One entry per EXAMINED item id, whatever it turned out to be. */
export type SlackKnownRootEntry = SlackKnownRootLocatedEntry | SlackKnownRootUnlocatedEntry;

export interface SlackKnownRootItemPage {
  readonly entries: readonly SlackKnownRootEntry[];
  readonly nextCursor: SlackKnownRootCursor | null;
  /** The key range ended. Never "the source is synchronized" and never "reconciliation is complete". */
  readonly exhausted: boolean;
  readonly examined: number;
}

/** An invalid caller contract. The message is static: it never quotes the rejected value. */
export class SlackKnownRootValidationError extends Error {
  constructor() {
    super("slack known-root: invalid request");
    this.name = "SlackKnownRootValidationError";
  }
}

/** The slice's explicit deadline marker, read by the failure classifier and by nothing else. */
export class SlackKnownRootDeadlineError extends Error {
  readonly slackKnownRootDeadlineExceeded = true as const;

  constructor() {
    super("slack known-root: operation deadline exceeded");
    this.name = "SlackKnownRootDeadlineError";
  }
}

export interface SlackKnownRootExecutionOptions {
  /** Integer milliseconds, 1,000–5,000. Default 2,000. */
  readonly allowanceMs?: number;
  /**
   * An ambient deadline on the same monotonic clock, or `null` to DECLARE that there is none. The
   * session cannot discover one, so the caller always says.
   */
  readonly ambientDeadlineAt: number | null;
  /** Monotonic milliseconds. Production omits it; a test may control it. */
  readonly monotonicNow?: () => number;
}

/** Created BEFORE the transaction and reused across its attempts: a retry gets no fresh allowance. */
export interface SlackKnownRootExecution {
  readonly allowanceMs: number;
  /** The effective absolute deadline on the monotonic clock. */
  readonly deadlineAt: number;
  readonly monotonicNow: () => number;
}

function invalidRequest(): never {
  throw new SlackKnownRootValidationError();
}

/** The process's own monotonic clock, in milliseconds. */
function realMonotonicNow(): number {
  return performance.now();
}

/**
 * One reading of a monotonic clock. A clock that throws, or that answers with anything but a finite
 * number, is a broken caller contract: it is refused with the static error, and neither the clock's
 * exception nor the value it returned travels any further.
 */
function readMonotonicClock(clock: () => number): number {
  let reading: unknown;
  try {
    reading = clock();
  } catch {
    return invalidRequest();
  }
  if (typeof reading !== "number" || !Number.isFinite(reading)) return invalidRequest();
  return reading;
}

/**
 * The execution context of one logical operation: its allowance and its absolute deadline, fixed
 * from ONE clock reading taken here. It is created before the transaction and handed to every
 * attempt, so a retry is measured against the same deadline and receives no fresh allowance.
 *
 * The effective deadline is the earlier of `now + allowance` and the ambient deadline the caller
 * declared. An ambient deadline that has already passed is a valid declaration — it is a fact about
 * the caller's remaining time — and yields a context that is already out of time; refusing to start
 * work under it is the job of the primitive that is handed the context, not of this function.
 *
 * Throws only the static validation error. Every option is read once and copied; the options
 * object is not retained.
 */
export function createSlackKnownRootExecution(options: SlackKnownRootExecutionOptions): SlackKnownRootExecution {
  let allowance: unknown;
  let ambient: unknown;
  let clock: unknown;
  try {
    if (typeof options !== "object" || options === null || Array.isArray(options)) return invalidRequest();
    const supplied = options as unknown as Record<string, unknown>;
    allowance = supplied.allowanceMs;
    ambient = supplied.ambientDeadlineAt;
    clock = supplied.monotonicNow;
  } catch {
    // An options object whose accessor throws is as invalid as one that is not an object.
    return invalidRequest();
  }

  const limits = SLACK_KNOWN_ROOT_LIMITS.allowanceMs;
  let allowanceMs: number;
  if (allowance === undefined) allowanceMs = limits.default;
  else if (typeof allowance === "number" && Number.isSafeInteger(allowance) && allowance >= limits.min && allowance <= limits.max) allowanceMs = allowance;
  else return invalidRequest();

  // The caller always SAYS: `null` declares that there is no ambient deadline, a finite number is
  // one. An absent declaration is refused — the session cannot discover a deadline on its own.
  let ambientDeadlineAt: number | null;
  if (ambient === null) ambientDeadlineAt = null;
  else if (typeof ambient === "number" && Number.isFinite(ambient)) ambientDeadlineAt = ambient;
  else return invalidRequest();

  let monotonicNow: () => number;
  if (clock === undefined) monotonicNow = realMonotonicNow;
  else if (typeof clock === "function") monotonicNow = clock as () => number;
  else return invalidRequest();

  const createdAt = readMonotonicClock(monotonicNow);
  const operationDeadlineAt = createdAt + allowanceMs;
  const deadlineAt = ambientDeadlineAt === null ? operationDeadlineAt : Math.min(operationDeadlineAt, ambientDeadlineAt);
  if (!Number.isFinite(deadlineAt)) return invalidRequest();

  return Object.freeze({ allowanceMs, deadlineAt, monotonicNow });
}

/**
 * One bounded page of a team's item ids in UUID order, each with its durable Slack locator or the
 * closed reason it has none.
 *
 * STUB: reads nothing and returns the same placeholder for every request. The placeholder is
 * deliberately NOT a valid page — it has no continuation and yet is not exhausted — so it cannot be
 * mistaken for the correct answer to an empty team.
 */
export async function readSlackKnownRootItemPage(
  session: TransactionSession,
  request: SlackKnownRootPageRequest,
  execution: SlackKnownRootExecution
): Promise<SlackKnownRootItemPage> {
  void session;
  void request;
  void execution;
  return Object.freeze({ entries: Object.freeze([]), nextCursor: null, exhausted: false, examined: 0 });
}
