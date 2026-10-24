import "server-only";
import { isDeepStrictEqual } from "node:util";
import type { DbClient } from "@/lib/db/types";
import { runContextTransaction } from "@/lib/projects/context/transaction";
import type { SlackMethodScope } from "./slack-method-budget";
import { slackReservedRequest, type SlackPage } from "./sources/slack-page-request";
import { parseSlackTimestamp } from "./sources/slack-message-evidence";
import {
  checkpointSlackThread,
  claimDueSlackThread,
  readSlackThreadSnapshot,
  releaseSlackThreadForRetry,
  restartSlackThreadSnapshot,
  writeSlackThreadSnapshot,
  type SlackThreadClaim,
} from "./slack-thread-state";

/** Inactive, one-page-at-a-time source hydrator.  It is intentionally not imported by any runner,
 * scheduler, route, action, or discovery pass.  A caller must already have validated the binding
 * and provide its verified method scope/token; this module is not an authorization shortcut. */
export interface SlackThreadHydratorInput {
  readonly db: DbClient;
  readonly teamId: string;
  readonly token: string;
  readonly methodScope: SlackMethodScope;
}
export interface SlackThreadHydratorOptions {
  readonly fetchImpl?: typeof fetch;
  readonly leaseMs?: number;
  readonly snapshotTtlMs?: number;
  /** Jitter sampler for a transient retry: one number in `[0, 1)` per decision. Defaults to `Math.random`. */
  readonly random?: () => number;
}
export type SlackThreadHydrationResult = {
  readonly outcome: "idle" | "progressed" | "deferred" | "failed" | "refused";
  readonly category?: string;
};
const LEASE_MS = 60_000;
const SNAPSHOT_TTL_MS = 60 * 60 * 1000;
const MAX_BYTES = 1_048_576;

/** First page establishes the root. Continuations may contain replies only. */
export function validateSlackRepliesPage(page: SlackPage, rootTs: string, sentCursor: string | null, seenCursors: readonly string[] = []):
  | { ok: true; messages: readonly Record<string, unknown>[]; nextCursor: string | null; terminal: boolean }
  | { ok: false; category: "malformed_page" | "missing_root" | "cursor_repeated" | "pagination_incomplete" } {
  if (!Array.isArray(page.messages)) return { ok: false, category: "malformed_page" };
  const messages = page.messages as unknown as Record<string, unknown>[];
  if (sentCursor === null && (!messages.length || messages[0]?.ts !== rootTs)) return { ok: false, category: "missing_root" };
  if (!messages.every((m) => m && typeof m === "object" && typeof m.ts === "string" && !!parseSlackTimestamp(m.ts))) return { ok: false, category: "malformed_page" };
  if (page.hasMore && messages.length === 0) return { ok: false, category: "pagination_incomplete" };
  if (page.hasMore && (!page.nextCursor || !page.nextCursor.trim())) return { ok: false, category: "pagination_incomplete" };
  // The mirror contradiction (P4-03's sibling): a live cursor while `has_more` is false or absent. Taken as terminal it
  // would stage a truncated thread as COMPLETE and checkpoint its cursor to null.
  if (!page.hasMore && page.nextCursor) return { ok: false, category: "pagination_incomplete" };
  if (page.nextCursor && (page.nextCursor.length > 1024 || !page.nextCursor.trim() || /[\x00-\x1f\x7f]/.test(page.nextCursor))) return { ok: false, category: "malformed_page" };
  if (page.hasMore && page.nextCursor && (page.nextCursor === sentCursor || seenCursors.includes(page.nextCursor))) return { ok: false, category: "cursor_repeated" };
  return { ok: true, messages, nextCursor: page.hasMore ? page.nextCursor : null, terminal: !page.hasMore };
}

function merged(existing: readonly Record<string, unknown>[], page: readonly Record<string, unknown>[]): Record<string, unknown>[] | null {
  const out = new Map<string, Record<string, unknown>>();
  for (const message of [...existing, ...page]) {
    const ts = message.ts;
    if (typeof ts !== "string") continue;
    const previous = out.get(ts);
    if (previous && !isDeepStrictEqual(previous, message)) return null;
    if (!previous) out.set(ts, message);
  }
  return [...out.values()];
}
function snapshotBytes(messages: readonly Record<string, unknown>[]): number { return Buffer.byteLength(JSON.stringify(messages), "utf8"); }
class CheckpointRefused extends Error {}
class SnapshotTooLarge extends Error {}

/**
 * TRANSIENT FAILURES — the closed set this module retries with jitter. It is private and deliberately
 * repeated here rather than shared: the transport owns sanitization and the raw HTTP-to-outcome
 * mapping, and this module owns only the retry schedule.
 *
 *  • every `transport_error`, whatever its diagnostic category (no answer, or an unreadable one);
 *  • a `provider_error` the transport reported by status alone, `http_500` … `http_599` — matched on
 *    its sanitized category, exactly and anchored, never on provider body text;
 *  • a `provider_error` carrying one of the five transient provider codes.
 *
 * Everything else — unknown codes and the reachability/refusal codes — keeps the flat five minutes.
 * The category decides the DELAY only: what is stored and returned stays the coarse outcome.
 */
const TRANSIENT_HTTP_STATUS = /^http_5[0-9]{2}$/;
const TRANSIENT_PROVIDER_CODES: ReadonlySet<string> = new Set([
  "ratelimited", "internal_error", "service_unavailable", "fatal_error", "request_timeout",
]);
function isTransientFailure(call: { readonly outcome: string; readonly category?: string }): boolean {
  if (call.outcome === "transport_error") return true;
  if (call.outcome !== "provider_error" || typeof call.category !== "string") return false;
  return TRANSIENT_HTTP_STATUS.test(call.category) || TRANSIENT_PROVIDER_CODES.has(call.category);
}

const TRANSIENT_CAP_MS = 5 * 60_000;
const TRANSIENT_FIRST_UPPER_MS = 2 * 60_000;

/**
 * The claim's persisted ordinal, or a static refusal. `attempts` is the row's LIFETIME claim count as
 * the database returned it, not a count of consecutive failures; a real claim already validates the
 * stored counter, so this guards a malformed one from being clamped into a delay. The rejected value
 * is not quoted.
 */
function claimOrdinal(claim: SlackThreadClaim): number {
  const attempts: unknown = claim.attempts;
  if (typeof attempts !== "number" || !Number.isSafeInteger(attempts) || attempts < 1) {
    throw new TypeError("Slack thread claim attempts must be a positive safe integer");
  }
  return attempts;
}

/** One sample from the injected source, or a static refusal. It is never coerced. */
function jitterSample(random: () => number): number {
  const sample: unknown = random();
  if (typeof sample !== "number" || !Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new TypeError("Slack retry jitter sample must be a finite number in [0, 1)");
  }
  return sample;
}

/**
 * Five-minute-capped, jittered backoff on the persisted claim ordinal: `[60s, 120s]` on the first
 * lifetime claim, `[120s, 240s]` on the second, `[150s, 300s]` from the third on. The cap is applied
 * BEFORE any exponent, so the exponent is only ever 0 or 1 and a very large ordinal cannot overflow.
 * Past the second claim the delay is uniform jitter in the capped band and repeated failures do not
 * lengthen it; request pressure in a sustained outage is bounded by the method budget, not by this.
 * The sample maps onto every integer of the inclusive band (`+ 1`), and cannot exceed its upper end.
 */
function transientDelayMs(attempts: number, sample: number): number {
  const upperMs = attempts >= 3 ? TRANSIENT_CAP_MS : TRANSIENT_FIRST_UPPER_MS * 2 ** (attempts - 1);
  const lowerMs = upperMs / 2;
  return lowerMs + Math.floor(sample * (upperMs - lowerMs + 1));
}

/**
 * The due time for every NON-transient requeue. A parsable provider deadline keeps its precedence and
 * its minimum, and is never shortened to the transient cap. Without one, `rate_limited` keeps its
 * deterministic exponential fallback on the claim ordinal (up to one hour) — it is not the jittered
 * policy and draws no sample — auth and block hold for a day, and everything else is five minutes.
 */
function retryDate(claim: SlackThreadClaim, category: string, providerAt?: string): Date {
  const now = Date.now();
  if (providerAt) {
    const deadline = new Date(providerAt).getTime();
    if (Number.isFinite(deadline)) return new Date(Math.max(now + (category === "rate_limited" ? 60_000 : 1_000), deadline));
  }
  const delay = category === "auth_error" || category === "blocked" ? 24 * 60 * 60_000
    : category === "rate_limited" ? Math.min(60 * 60_000, 60_000 * 2 ** Math.min(claimOrdinal(claim) - 1, 6))
    : 5 * 60_000;
  return new Date(now + delay);
}

async function requeue(input: SlackThreadHydratorInput, claim: SlackThreadClaim, category: string, dueAt: Date): Promise<SlackThreadHydrationResult> {
  const result = await runContextTransaction(input.db, (s) => releaseSlackThreadForRetry(s, claim, { nextDueAt: dueAt, errorCode: category }));
  return result.outcome === "refused" ? { outcome: "refused", category: "stale_lease" }
    : { outcome: category === "deferred" || category === "rate_limited" ? "deferred" : "failed", category };
}

export async function hydrateOneSlackThread(input: SlackThreadHydratorInput, options: SlackThreadHydratorOptions = {}): Promise<SlackThreadHydrationResult> {
  const methodScope = input.methodScope;
  if (methodScope.kind !== "verified" || methodScope.teamId !== input.teamId) {
    throw new TypeError("Slack thread hydration requires a verified method scope for this team");
  }
  const snapshotTtlMs = options.snapshotTtlMs ?? SNAPSHOT_TTL_MS;
  if (!Number.isSafeInteger(snapshotTtlMs) || snapshotTtlMs < 1_000 || snapshotTtlMs > SNAPSHOT_TTL_MS) {
    throw new TypeError("Slack snapshot TTL must be between one second and one hour");
  }
  const acquired = await runContextTransaction(input.db, (s) => claimDueSlackThread(s, input.teamId, {
    leaseMs: options.leaseMs ?? LEASE_MS, workspaceId: methodScope.workspaceId,
  }));
  if (!acquired) return { outcome: "idle" };
  let claim: SlackThreadClaim = acquired;
  let prior = claim.pageCursor ? await runContextTransaction(input.db, (s) => readSlackThreadSnapshot(s, claim)) : null;
  if (claim.pageCursor && (!prior || prior.complete || prior.messages[0]?.ts !== claim.scope.rootTs || prior.seenCursors?.at(-1) !== claim.pageCursor)) {
    const restarted = await runContextTransaction(input.db, (s) => restartSlackThreadSnapshot(s, claim));
    if (!restarted) return { outcome: "refused", category: "stale_lease" };
    claim = restarted;
    prior = null;
  }
  const call = await slackReservedRequest({ db: input.db, scope: input.methodScope, token: input.token }, "conversations.replies", {
    channel: claim.scope.channelId, ts: claim.scope.rootTs, ...(claim.pageCursor ? { cursor: claim.pageCursor } : {}),
  }, options.fetchImpl ? { fetchImpl: options.fetchImpl } : {});
  if (call.outcome !== "ok") {
    if (call.outcome === "provider_error" && (call.category === "invalid_cursor" || call.category === "pagination_not_available") && claim.pageCursor) {
      const restarted = await runContextTransaction(input.db, (s) => restartSlackThreadSnapshot(s, claim));
      if (!restarted) return { outcome: "refused", category: "stale_lease" };
      return requeue(input, restarted, call.category, retryDate(restarted, call.category));
    }
    const category = call.outcome === "deferred" ? "deferred" : call.outcome === "rate_limited" ? "rate_limited"
      : call.outcome === "blocked" ? "blocked" : call.outcome === "auth_error" ? "auth_error"
      : call.outcome === "transport_error" ? "transport_error" : "provider_error";
    if (isTransientFailure(call)) {
      // The ordinal of the claim actually held (a same-lease snapshot restart above keeps it), then
      // exactly ONE sample. Either can throw, and deliberately does so before the release: the row
      // stays leased as it was after the claim, the spent method reservation is not refunded, and
      // another worker reclaims it only once the lease expires. Nothing is staged or advanced.
      const attempts = claimOrdinal(claim);
      // The platform sampler is looked up when the decision is made, not captured at module load.
      const delayMs = transientDelayMs(attempts, jitterSample(options.random ?? (() => Math.random())));
      return requeue(input, claim, category, new Date(Date.now() + delayMs));
    }
    return requeue(input, claim, category, retryDate(claim, category, "nextPermittedAt" in call ? call.nextPermittedAt : undefined));
  }
  const page = validateSlackRepliesPage(call.page, claim.scope.rootTs, claim.pageCursor, prior?.seenCursors ?? []);
  if (!page.ok) return requeue(input, claim, page.category, retryDate(claim, page.category));
  if (page.nextCursor && (prior?.seenCursors?.length ?? 0) >= 1000) {
    return requeue(input, claim, "pagination_incomplete", retryDate(claim, "pagination_incomplete"));
  }
  const messages = merged(prior?.messages ?? [], page.messages);
  if (messages === null) {
    const restarted = await runContextTransaction(input.db, (s) => restartSlackThreadSnapshot(s, claim));
    if (!restarted) return { outcome: "refused", category: "stale_lease" };
    return requeue(input, restarted, "message_conflict", retryDate(restarted, "message_conflict"));
  }
  const storedBytes = snapshotBytes(messages);
  if (storedBytes > MAX_BYTES) return requeue(input, claim, "snapshot_too_large", retryDate(claim, "snapshot_too_large"));
  try {
    await runContextTransaction(input.db, async (s) => {
      const nextGeneration = claim.snapshotGeneration + 1;
      const seenCursors = page.nextCursor ? [...(prior?.seenCursors ?? []), page.nextCursor] : prior?.seenCursors ?? [];
      const result = await writeSlackThreadSnapshot(s, claim, {
        messages, storedBytes, seenCursors, complete: page.terminal,
        expiresAt: new Date(Date.now() + snapshotTtlMs).toISOString(),
      });
      if (result === "refused") throw new CheckpointRefused();
      if (result === "too_large") throw new SnapshotTooLarge();
      const checkpoint = await checkpointSlackThread(s, claim, { pageCursor: page.nextCursor, snapshotGeneration: nextGeneration });
      if (checkpoint.outcome !== "checkpointed") throw new CheckpointRefused();
    });
    return { outcome: "progressed" };
  } catch (error) {
    if (error instanceof CheckpointRefused) return { outcome: "refused", category: "stale_lease" };
    // The database measures `messages::text`, which is larger than the JSON.stringify count checked above.
    if (error instanceof SnapshotTooLarge) return requeue(input, claim, "snapshot_too_large", retryDate(claim, "snapshot_too_large"));
    throw error;
  }
}
