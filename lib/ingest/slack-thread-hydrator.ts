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
function retryDate(claim: SlackThreadClaim, category: string, providerAt?: string): Date {
  const now = Date.now();
  if (providerAt) {
    const deadline = new Date(providerAt).getTime();
    if (Number.isFinite(deadline)) return new Date(Math.max(now + (category === "rate_limited" ? 60_000 : 1_000), deadline));
  }
  const delay = category === "auth_error" || category === "blocked" ? 24 * 60 * 60_000
    : category === "transport_error" || category === "rate_limited" ? Math.min(60 * 60_000, 60_000 * 2 ** Math.min(claim.attempts - 1, 6))
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
