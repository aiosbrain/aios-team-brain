import "server-only";
import type { DbClient } from "@/lib/db/types";

/**
 * Single writer + reader for `chat_turn_runs` — the in-flight state of one answer attempt (QBGSTREAM-1).
 *
 * Owner-scoped exactly like `lib/chat/store`: every query filters `(team_id, member_id)`, and there is
 * no RLS backstop on Postgres, so this module IS the gate. A run is created when a query starts, its
 * partial answer is heartbeat-flushed while streaming, and it is finalized to `done` (pointing at the
 * persisted assistant message) or `error` (carrying the SANITIZED client message).
 *
 * The point of the table is that the run outlives the request's client: the browser can close, reload,
 * or navigate away and the answer still lands, and a returning tab can re-attach to it.
 */

export type TurnRunStatus = "streaming" | "done" | "error";

export interface TurnRun {
  id: string;
  conversation_id: string;
  question: string;
  status: TurnRunStatus;
  partial_text: string;
  error_message: string | null;
  final_message_id: string | null;
  created_at: string;
  updated_at: string;
}

export type RunOwner = { teamId: string; memberId: string };

/**
 * How long a `streaming` run may go without a heartbeat before a reader must treat it as dead.
 *
 * Sized off the route's own ceiling: `maxDuration = 120s` is the intended upper bound for a single
 * answer, and the flush interval is a couple of seconds — so 3 minutes of silence means the process
 * that owned this run is gone (a deploy restart, an OOM), not that it is thinking. Deploys happen on
 * every merge to `main`, which is exactly how a run gets orphaned in practice.
 */
export const RUN_STALE_AFTER_MS = 3 * 60_000;

/**
 * Is this run dead-but-still-marked-streaming? PURE (clock injected) so the rule is unit-testable
 * without a database, and so a reader can apply it without waiting for a sweeper to run.
 *
 * ONLY `streaming` runs can be stale: a finished run is a settled fact whose `updated_at` merely ages,
 * and calling it stale would turn every old completed answer into a failure on read.
 */
export function isRunStale(
  run: Pick<TurnRun, "status" | "updated_at">,
  now: Date = new Date(),
  staleAfterMs: number = RUN_STALE_AFTER_MS
): boolean {
  if (run.status !== "streaming") return false;
  const updated = new Date(run.updated_at).getTime();
  // An unparseable timestamp must not silently read as "fresh" (NaN comparisons are always false),
  // because that is the eternal-spinner state this function exists to end.
  if (!Number.isFinite(updated)) return true;
  return now.getTime() - updated > staleAfterMs;
}

/**
 * The status a READER should act on — `isRunStale` collapsed into the status enum, so every surface
 * (the poll endpoint, the UI, a future sweeper) reports a dead run identically instead of each
 * re-implementing the threshold.
 */
export function effectiveRunStatus(
  run: Pick<TurnRun, "status" | "updated_at">,
  now: Date = new Date()
): TurnRunStatus {
  return isRunStale(run, now) ? "error" : run.status;
}

/** Message shown for a run whose owning process died mid-answer (no error was ever recorded). */
export const STALE_RUN_MESSAGE =
  "This answer was interrupted (the server restarted while it was running). Please ask again.";

export async function createRun(
  db: DbClient,
  owner: RunOwner,
  conversationId: string,
  question: string
): Promise<{ id: string } | null> {
  const { data, error } = await db
    .from("chat_turn_runs")
    .insert({
      conversation_id: conversationId,
      team_id: owner.teamId,
      member_id: owner.memberId,
      question,
      status: "streaming",
    })
    .select("id")
    .single();
  if (error) throw new Error(`createRun: ${error.message}`);
  return (data as { id: string } | null) ?? null;
}

/**
 * Heartbeat the run with the answer so far. Also the liveness signal `isRunStale` reads, so this must
 * be called periodically even when the text hasn't grown much — silence is what marks a run dead.
 */
export async function flushPartial(db: DbClient, runId: string, partial: string): Promise<void> {
  const { error } = await db
    .from("chat_turn_runs")
    .update({ partial_text: partial, updated_at: new Date().toISOString() })
    .eq("id", runId)
    .eq("status", "streaming"); // never resurrect a finished run
  if (error) throw new Error(`flushPartial: ${error.message}`);
}

/**
 * Finalize a successful turn. Call AFTER the assistant message row exists, passing its id: the reader
 * prefers the final message over `partial_text`, so this ordering makes a crash in between show the
 * good answer rather than a partial beside it.
 */
export async function finishRun(db: DbClient, runId: string, finalMessageId: string | null): Promise<void> {
  const { error } = await db
    .from("chat_turn_runs")
    .update({ status: "done", final_message_id: finalMessageId, updated_at: new Date().toISOString() })
    .eq("id", runId);
  if (error) throw new Error(`finishRun: ${error.message}`);
}

/**
 * Finalize a failed turn. `message` MUST be the sanitized client-facing text — the raw provider error
 * carries the internal model + base URL, and this column is read back by the browser.
 */
export async function failRun(db: DbClient, runId: string, message: string): Promise<void> {
  const { error } = await db
    .from("chat_turn_runs")
    .update({ status: "error", error_message: message, updated_at: new Date().toISOString() })
    .eq("id", runId);
  if (error) throw new Error(`failRun: ${error.message}`);
}

/** The most recent run of a conversation, owner-checked. Null when absent/not owned. */
export async function latestRun(
  db: DbClient,
  owner: RunOwner,
  conversationId: string
): Promise<TurnRun | null> {
  const { data } = await db
    .from("chat_turn_runs")
    .select("id, conversation_id, question, status, partial_text, error_message, final_message_id, created_at, updated_at")
    .eq("team_id", owner.teamId)
    .eq("member_id", owner.memberId)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as TurnRun | null) ?? null;
}

/**
 * The member's currently-running turn, if any — what `/query` polls on mount to decide whether to
 * re-open a thread instead of showing a blank new chat.
 *
 * Staleness is applied HERE, not left to the caller: a run orphaned by a deploy is still
 * `status='streaming'` in the table, and returning it would auto-reopen a thread onto a spinner that
 * never resolves. A stale run is reported as no active run.
 */
export async function activeRun(db: DbClient, owner: RunOwner, now: Date = new Date()): Promise<TurnRun | null> {
  const { data } = await db
    .from("chat_turn_runs")
    .select("id, conversation_id, question, status, partial_text, error_message, final_message_id, created_at, updated_at")
    .eq("team_id", owner.teamId)
    .eq("member_id", owner.memberId)
    .eq("status", "streaming")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const run = (data as TurnRun | null) ?? null;
  if (!run || isRunStale(run, now)) return null;
  return run;
}
