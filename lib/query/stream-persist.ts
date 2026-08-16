import "server-only";
import type { DbClient } from "@/lib/db/types";
import type { RetrievedContext } from "./retrieve";
import { streamAnswer, type ChatTurn, type CallerIdentity, type ProviderKeys } from "./claude";
import { clientErrorMessage } from "./stream-retry";
import { appendMessage } from "@/lib/chat/store";
import { generateAndSetTitle } from "@/lib/chat/title";
import { recordLlmUsage } from "@/lib/costs/llm-usage";
import { flushPartial, finishRun, failRun, touchRun } from "./turn-runs";

/**
 * Run ONE answer turn to completion and persist it — independently of whether the client is still
 * listening (QBGSTREAM-1).
 *
 * WHY THIS EXISTS AS ITS OWN MODULE. Previously this logic lived inline in the route's
 * `ReadableStream.start()`, and `send("done")` ran BEFORE the persistence block. When the browser
 * disconnected (tab close, reload, network drop) the `controller.enqueue` inside `send` threw, the
 * throw escaped into the catch, and EVERY write was skipped — no assistant message, and no
 * `query_log`/`llm_usage` row for an answer the provider had already generated and billed. So a
 * disconnected turn was silently lost AND under-billed.
 *
 * Here, `send` is a best-effort side effect (the caller makes it a no-op once cancelled) and the
 * persistence path cannot be aborted by it. The turn therefore survives its client.
 *
 * WRITE ORDER IS LOAD-BEARING: the assistant message is inserted FIRST, then the run flips to `done`
 * carrying its id. Readers prefer the final message over the run's `partial_text`, so a crash between
 * those two writes shows the completed answer rather than a partial beside it.
 */

export interface RunAnswerTurnArgs {
  db: DbClient;
  owner: { teamId: string; memberId: string };
  /** Null when the thread could not be created — the answer still streams, it just isn't persisted. */
  conversationId: string | null;
  /** Null when no run row exists (e.g. no conversation) — persistence still happens. */
  runId: string | null;
  question: string;
  ctx: RetrievedContext;
  keys: ProviderKeys;
  historyTurns: ChatTurn[];
  caller: CallerIdentity;
  timeZone: string;
  /** True on a brand-new thread → replace the derived title with an LLM-written one. */
  createdNew: boolean;
  /** Wall-clock start, for `query_log.latency_ms`. */
  startedAt: number;
  /** Best-effort delivery to the client. MUST NOT throw — a dead client cannot fail the turn. */
  send: (event: string, data: unknown) => void;
  /** Injectable clock for tests (partial-flush throttling). */
  now?: () => number;
  /** Liveness heartbeat interval; tests shorten it. Defaults to HEARTBEAT_MS. */
  heartbeatMs?: number;
}

/** Partial-text flush cadence: often enough for a returning tab to see progress, rare enough to be cheap. */
export const PARTIAL_FLUSH_MS = 1_500;

/**
 * Liveness heartbeat cadence — INDEPENDENT of the model producing tokens.
 *
 * Comfortably inside `RUN_STALE_AFTER_MS` (3 min) so a healthy-but-quiet turn (a model thinking for a
 * long time before its first token) is never mistaken for a dead process. Without this, staleness was
 * delta-driven: a slow first token declared the run stale, a reader was told "interrupted", and the run
 * then completed anyway — the contradiction the staleness rule is supposed to prevent, not create.
 */
export const HEARTBEAT_MS = 20_000;

export async function runAnswerTurn(args: RunAnswerTurnArgs): Promise<void> {
  const { db, owner, conversationId, runId, question, ctx, keys, historyTurns, caller, timeZone } = args;
  const now = args.now ?? Date.now;
  let answer = "";
  let lastFlush = 0;

  // The sink is CONTAINED here rather than trusted. `send` is documented as non-throwing and the route
  // builds it that way — but if it ever does throw (a closed controller, a future caller that forgets),
  // the throw would land in the catch below and be misreported as an ANSWER failure: the turn would be
  // abandoned, the message never written, and the run marked `error` even though the model succeeded.
  // That is the exact class of bug this slice exists to remove, so it is a guard, not a convention.
  const send = (event: string, data: unknown) => {
    try {
      args.send(event, data);
    } catch (e) {
      console.warn("[query] client sink failed (continuing to persist):", e instanceof Error ? e.message : e);
    }
  };

  // Liveness heartbeat, on a timer rather than on deltas — see HEARTBEAT_MS. Best-effort and always
  // cleared in `finally`, so it can neither fail the turn nor outlive it (a leaked interval would keep
  // a dead run looking alive forever, which is worse than no heartbeat at all).
  const heartbeat = runId
    ? setInterval(() => {
        void touchRun(db, runId).catch((e) =>
          console.warn("[query] heartbeat failed:", e instanceof Error ? e.message : e)
        );
      }, args.heartbeatMs ?? HEARTBEAT_MS)
    : null;
  // Don't hold the process open just for a heartbeat (Node-only; harmless where absent).
  heartbeat?.unref?.();

  try {
    for await (const chunk of streamAnswer(ctx, question, keys, historyTurns, caller, timeZone, {
      onRetry: ({ attempt, delayMs, error }) =>
        console.warn(
          `[query] transient answer-stream failure (attempt ${attempt}), retrying in ${delayMs}ms:`,
          error instanceof Error ? error.message : error
        ),
    })) {
      if (chunk.type === "delta") {
        answer += chunk.text;
        send("delta", { text: chunk.text });
        // Heartbeat the run so a returning tab sees progress AND so `isRunStale` can tell a live run
        // from one whose process died. Throttled, and best-effort: a failed flush must not kill the
        // answer that is otherwise streaming fine.
        if (runId && now() - lastFlush >= PARTIAL_FLUSH_MS) {
          lastFlush = now();
          try {
            await flushPartial(db, runId, answer);
          } catch (e) {
            console.warn("[query] partial flush failed:", e instanceof Error ? e.message : e);
          }
        }
        continue;
      }

      // Terminal `done` chunk: emit, then persist. Persistence is NOT guarded by the client.
      const cited = new Set<string>();
      for (const m of answer.matchAll(/\[(S\d+)\]/g)) cited.add(m[1]);
      const sources = ctx.sources
        .filter((s) => cited.has(s.sid))
        .map((s) => ({ id: s.sid, item_id: s.item_id, project: s.project, path: s.path, kind: s.kind }));
      // PERSIST BEFORE ANNOUNCING. `done` is the client's "this turn is safely finished" signal, so it
      // must not precede the writes: when it did, a DB failure after `done` sent an `error` frame AFTER
      // `done`, marked the run failed even though the model had succeeded (and been billed), and left
      // the turn unlogged — resurrecting the under-bill through the DB-failure edge. Now a persistence
      // failure takes the catch below BEFORE any `done` was claimed, so the client is told the truth.
      let finalMessageId: string | null = null;
      if (conversationId) {
        finalMessageId = await appendMessage(db, owner, conversationId, "assistant", answer, {
          cited_item_ids: sources.map((s) => s.item_id).filter((id): id is string => Boolean(id)),
          input_tokens: chunk.usage.input_tokens,
          output_tokens: chunk.usage.output_tokens,
          cost_usd: chunk.usage.cost_usd,
        });
      }

      // CHECK THE ERROR. The db adapter resolves `{ error }` instead of throwing, so an unchecked
      // insert fails SILENTLY — leaving a persisted answer with no spend row, which is precisely the
      // under-bill this slice exists to close. Loud (thrown → logged + the run marked failed) beats a
      // turn that looks complete but is invisible to the ledger.
      const { error: logError } = await db.from("query_log").insert({
        team_id: owner.teamId,
        member_id: owner.memberId,
        question,
        answer_preview: answer.slice(0, 500),
        cited_item_ids: sources.map((s) => s.item_id).filter(Boolean),
        input_tokens: chunk.usage.input_tokens,
        output_tokens: chunk.usage.output_tokens,
        cache_read_tokens: chunk.usage.cache_read_tokens,
        cost_usd: chunk.usage.cost_usd,
        latency_ms: now() - args.startedAt,
      });
      if (logError) throw new Error(`query_log insert failed: ${logError.message}`);

      await recordLlmUsage(db, {
        teamId: owner.teamId,
        memberId: owner.memberId,
        source: "query",
        provider: chunk.usage.provider,
        model: chunk.usage.model,
        inputTokens: chunk.usage.input_tokens,
        outputTokens: chunk.usage.output_tokens,
        costUsd: chunk.usage.cost_usd,
        estimated: chunk.usage.estimated,
      });

      // Flip the run LAST, pointing at the message that now exists.
      if (runId) await finishRun(db, runId, finalMessageId);

      // Everything durable is written — NOW tell the client the turn is complete.
      send("sources", { sources });
      send("done", chunk.usage);

      // Cosmetic + best-effort, deliberately after `done`: the title generator makes its own bounded
      // LLM call, and nothing about the answer's durability depends on it. Keeping it here means a slow
      // (or failing) title never delays or fails a turn that is already safely persisted.
      if (conversationId && args.createdNew) {
        try {
          await generateAndSetTitle(db, owner, conversationId, question, answer, keys);
        } catch (e) {
          console.warn("[query] title generation failed:", e instanceof Error ? e.message : e);
        }
      }
    }
  } catch (e) {
    // Log the REAL error (it carries the provider status / model / base URL) for diagnosis; the client
    // and the persisted run get only the sanitized text — the run row is read back by the browser, so
    // storing the raw message would undo the QSTREAMRETRY-1 sanitization via the replay path.
    console.error("[query] answer stream failed:", e instanceof Error ? e.message : e);
    const message = clientErrorMessage(e);
    send("error", { message });
    if (runId) {
      try {
        await failRun(db, runId, message);
      } catch (err) {
        console.error("[query] failed to record run failure:", err instanceof Error ? err.message : err);
      }
    }
  } finally {
    // ALWAYS stop the heartbeat. A leaked interval would keep touching `updated_at` after the turn
    // ended, so a run that died would keep reading as alive — defeating the staleness rule entirely.
    if (heartbeat) clearInterval(heartbeat);
  }
}
