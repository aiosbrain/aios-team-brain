import "server-only";
import type { DbClient } from "@/lib/db/types";

/**
 * The brain's own LLM inference spend ledger (`llm_usage`). One row per generation call — Q&A,
 * meeting extraction, narrative arcs, timeline summaries, social content, chat titles, attribution,
 * cron/background jobs. This is the lowest shared layer for "what is our inference costing": Pulse
 * Spend and the costs breakdown page both read it. Distinct from `usage_costs` (external dev-tool
 * spend pushed from workstations).
 *
 * SINGLE WRITER: this file is the only legal writer of `llm_usage` — guarded by
 * `test/guards/single-writer-llm-usage.test.ts`. Everything that spends brain inference records here.
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
  | "attribution"; // attribution-correction reasoning

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
    });
    if (error) console.error("[llm_usage] insert failed:", error.message);
  } catch (err) {
    console.error("[llm_usage] insert threw:", err instanceof Error ? err.message : err);
  }
}
