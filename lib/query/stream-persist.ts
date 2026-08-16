import "server-only";
import type { DbClient } from "@/lib/db/types";
import type { RetrievedContext } from "./retrieve";
import { streamAnswer, type ChatTurn, type CallerIdentity, type ProviderKeys } from "./claude";
import { clientErrorMessage } from "./stream-retry";
import { appendMessage } from "@/lib/chat/store";
import { generateAndSetTitle } from "@/lib/chat/title";
import { recordLlmUsage } from "@/lib/costs/llm-usage";
import { flushPartial, finishRun, failRun } from "./turn-runs";

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
  /** Injectable clock for tests (heartbeat throttling). */
  now?: () => number;
}

/** Heartbeat cadence: often enough for a returning tab to see progress, rare enough to be cheap. */
export const PARTIAL_FLUSH_MS = 1_500;

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
      send("sources", { sources });
      send("done", chunk.usage);

      let finalMessageId: string | null = null;
      if (conversationId) {
        finalMessageId = await appendMessage(db, owner, conversationId, "assistant", answer, {
          cited_item_ids: sources.map((s) => s.item_id).filter((id): id is string => Boolean(id)),
          input_tokens: chunk.usage.input_tokens,
          output_tokens: chunk.usage.output_tokens,
          cost_usd: chunk.usage.cost_usd,
        });
        if (args.createdNew) {
          await generateAndSetTitle(db, owner, conversationId, question, answer, keys);
        }
      }

      await db.from("query_log").insert({
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
  }
}
