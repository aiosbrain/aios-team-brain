import "server-only";
import type { DbClient } from "@/lib/db/types";

/**
 * The brain's own LLM inference spend ledger (`llm_usage`). One row per generation call — Q&A,
 * meeting extraction, narrative arcs, timeline summaries, social content, chat titles, attribution,
 * cron/background jobs. This is the lowest shared layer for "what is our inference costing": Pulse
 * Spend and the costs breakdown page both read it. Distinct from `usage_costs` (external dev-tool
 * spend pushed from workstations).
 *
 * SINGLE WRITER: this file is the only legal writer of `llm_usage` AND its sibling `llm_failures` —
 * guarded by `test/guards/single-writer-llm-usage.test.ts`. Everything that spends brain inference
 * records here.
 */

/** Coerce a possibly-NaN/Infinity number to a finite, non-negative value (never lose a row to bad math). */
function safeNum(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Feature that spent the tokens — the `source` slice on the costs breakdown. */
export type LlmUsageSource =
  | "query" // interactive Q&A (Query box / API)
  | "chat-title" // short conversation-title generation
  | "arcs" // narrative-arc synthesis
  | "meeting-extract" // meeting summary / attendees / action items
  | "meeting-merge" // duplicate-meeting merge reconciliation
  | "timeline-summary" // work-timeline day/person summaries
  | "social" // social-content generation
  | "attribution" // attribution-correction reasoning
  | "graph" // Graphiti entity/fact extraction (via the graph LLM proxy) — the highest-volume consumer
  | "embeddings"; // vector embeddings — item indexing + query/graph embedding (a distinct model class)

/**
 * The DB context a caller threads down to a wrapper (callMeetingsLLM, mergeTranscriptsLLM, …) so the
 * wrapper can meter into `llm_usage`. The `source` is fixed by the wrapper; this carries the rest.
 * `undefined` = don't meter (a caller with no team context in scope).
 */
export interface LlmMeterCtx {
  db: DbClient;
  teamId: string;
  memberId?: string | null;
}

export interface LlmUsageRecord {
  teamId: string;
  /** Human initiator, or null for a system/background call (cron, ingest, arc recompute). */
  memberId?: string | null;
  source: LlmUsageSource;
  /** `openrouter` | `anthropic` | `openai` | `local`. */
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** true = price-table estimate (Anthropic); false = provider-metered (OpenRouter `usage.cost`). */
  estimated: boolean;
  /**
   * Which Graphiti prompt made this call (`source='graph'` only) — see `lib/llm/graph-call-kind`.
   * Omitted everywhere else, which stores `''`.
   *
   * `''` means "not instrumented" and is indistinguishable from pre-deploy history, so the graph
   * proxy passes this REQUIRED rather than optional: a graph call site that forgets it would
   * silently file live spend as history, and the drift alarm (`unknown`) would never fire.
   */
  callKind?: string;
}

/**
 * Record one LLM call's spend. BEST-EFFORT: metering must never break or slow the actual generation,
 * so this swallows every error (a wedged ledger insert can't take down Q&A or a cron job). Fire it
 * after the call succeeds.
 */
export async function recordLlmUsage(db: DbClient, rec: LlmUsageRecord): Promise<void> {
  try {
    const { error } = await db.from("llm_usage").insert({
      team_id: rec.teamId,
      member_id: rec.memberId ?? null,
      source: rec.source,
      provider: rec.provider,
      model: rec.model,
      input_tokens: Math.round(safeNum(rec.inputTokens)),
      output_tokens: Math.round(safeNum(rec.outputTokens)),
      // Match the numeric(12,5) column scale; never persist a negative or NaN.
      cost_usd: Math.round(safeNum(rec.costUsd) * 100000) / 100000,
      estimated: rec.estimated,
      call_kind: rec.callKind ?? "",
    });
    if (error) console.error("[llm_usage] insert failed:", error.message);
  } catch (err) {
    console.error("[llm_usage] insert threw:", err instanceof Error ? err.message : err);
  }
}

/**
 * Why a billed attempt produced nothing to meter.
 *
 * `timeout` is OURS — our own deadline fired while the model was still generating, and the provider
 * billed for what it had produced. That is what happened on 2026-07-29 (a 120s proxy ceiling, three SDK
 * retries per job), and keeping it distinguishable from a provider fault is the whole reason this is a
 * column rather than a counter.
 */
export type LlmFailureReason =
  | "timeout" // our AbortController/AbortSignal fired — the caller's deadline was too short
  | "network" // the connection failed before any response
  | "no_usage" // a response arrived carrying no `usage` block, so there was nothing to meter
  | "empty_content" // 2xx with usage but no text (the reasoning-model starvation signature)
  | `http_${number}`; // provider answered non-2xx with nothing meterable

export interface LlmFailureRecord {
  teamId: string;
  memberId?: string | null;
  source: LlmUsageSource;
  provider: string;
  model: string;
  reason: LlmFailureReason;
  durationMs?: number;
}

/**
 * Record one BILLED-BUT-UNMETERABLE attempt into `llm_failures`.
 *
 * The unit is one ATTEMPT, not one logical call: a provider bills each attempt independently, and the
 * SDKs above us retry, so a single extraction that dies three times is three rows. That is the honest
 * unit for a spend-gap ledger — but it means the count is of attempts, and every surface must say so.
 *
 * NEVER call this for a refusal we raised BEFORE reaching a provider (rate limit, an Anthropic-backend
 * refusal, a bad dimension, a stream request). Those spend nothing, so counting them here would inflate
 * a ledger whose only job is to explain money — the same false-accusation failure the work-key check
 * taught us. This belongs at the transport, after the request is on the wire.
 *
 * BEST-EFFORT, like `recordLlmUsage`: observability must never break the call it is observing.
 */
export async function recordLlmFailure(db: DbClient, rec: LlmFailureRecord): Promise<void> {
  try {
    const { error } = await db.from("llm_failures").insert({
      team_id: rec.teamId,
      member_id: rec.memberId ?? null,
      source: rec.source,
      provider: rec.provider,
      model: rec.model,
      failure_reason: rec.reason,
      duration_ms: Math.round(safeNum(rec.durationMs ?? 0)),
    });
    if (error) console.error("[llm_failures] insert failed:", error.message);
  } catch (err) {
    console.error("[llm_failures] insert threw:", err instanceof Error ? err.message : err);
  }
}

/**
 * Classify a thrown transport error. The two abort flavours are NOT the same object: a manual
 * `AbortController.abort()` throws `AbortError`, while `AbortSignal.timeout()` throws `TimeoutError`.
 * Treating only the first as a timeout would file our own deadline bug — the expensive one — under
 * "network", which is exactly the misattribution this table exists to prevent.
 */
export function classifyLlmFailure(err: unknown): LlmFailureReason {
  const name = err instanceof Error ? err.name : "";
  return name === "AbortError" || name === "TimeoutError" ? "timeout" : "network";
}
