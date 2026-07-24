import "server-only";
import type { DbClient } from "@/lib/db/types";
import { scopeLlmUsage, type QueryLogViewer } from "@/lib/auth/visibility";
import { rangeDays, type Range } from "./range";

/**
 * The brain's own inference-spend breakdown, read from the `llm_usage` ledger (every generation the
 * product makes — Q&A, arcs, meetings, timeline, social, titles). Powers the costs breakdown page
 * (the Spend KPI drills into this) and answers "what is actually costing what". Role-scoped in app
 * code via `scopeLlmUsage` (admin → team-wide incl. system rows; else → own spend) — no RLS backstop.
 *
 * Aggregation is done in JS over rows in the window (mirrors `lib/metrics/pulse`); fine at MVP
 * volumes. If `llm_usage` grows large, push the group-by into SQL.
 */

/** Human labels for the `source` slice (the feature that spent the tokens). */
export const SOURCE_LABEL: Record<string, string> = {
  query: "Q&A queries",
  "chat-title": "Chat titles",
  arcs: "Narrative arcs",
  "meeting-extract": "Meeting extraction",
  "meeting-merge": "Meeting merge",
  "timeline-summary": "Timeline summaries",
  social: "Social content",
  attribution: "Attribution",
};

export interface CostSlice {
  key: string;
  label: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  calls: number;
  /** true when EVERY row in this slice is a price-table estimate (Anthropic); false if any is metered. */
  estimated: boolean;
}

export interface LlmCostBreakdown {
  days: number;
  total_usd: number;
  calls: number;
  /** true when ANY row in the window is an estimate — so the page can flag "includes estimates". */
  hasEstimates: boolean;
  by_source: CostSlice[];
  by_model: CostSlice[];
  by_provider: CostSlice[];
}

interface UsageRow {
  source: string;
  provider: string;
  model: string;
  cost_usd: number | string;
  input_tokens: number;
  output_tokens: number;
  estimated: boolean;
}

/** Group rows by a key, summing cost/tokens/calls; returns slices sorted by cost desc. */
function slicesBy(rows: UsageRow[], keyOf: (r: UsageRow) => string, labelOf: (k: string) => string): CostSlice[] {
  const map = new Map<string, CostSlice>();
  for (const r of rows) {
    const key = keyOf(r) || "unknown";
    const cur =
      map.get(key) ??
      { key, label: labelOf(key), cost_usd: 0, input_tokens: 0, output_tokens: 0, calls: 0, estimated: true };
    cur.cost_usd += Number(r.cost_usd) || 0;
    cur.input_tokens += Number(r.input_tokens) || 0;
    cur.output_tokens += Number(r.output_tokens) || 0;
    cur.calls += 1;
    // A slice is "estimated" only if EVERY row in it is — one metered row makes it real.
    cur.estimated = cur.estimated && r.estimated;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.cost_usd - a.cost_usd);
}

export async function getLlmCostBreakdown(
  db: DbClient,
  teamId: string,
  range: Range,
  viewer: QueryLogViewer
): Promise<LlmCostBreakdown> {
  const days = rangeDays(range);
  const windowStart = new Date(Date.now() - days * 86_400_000);

  const res = await scopeLlmUsage(
    db
      .from("llm_usage")
      .select("source, provider, model, cost_usd, input_tokens, output_tokens, estimated")
      .eq("team_id", teamId)
      .gte("created_at", windowStart.toISOString())
      .limit(100_000),
    viewer
  );
  const rows = (res.data ?? []) as UsageRow[];

  const total_usd = rows.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0);
  const calls = rows.length;
  const hasEstimates = rows.some((r) => r.estimated);

  return {
    days,
    total_usd,
    calls,
    hasEstimates,
    by_source: slicesBy(rows, (r) => r.source, (k) => SOURCE_LABEL[k] ?? k),
    by_model: slicesBy(rows, (r) => r.model, (k) => k),
    by_provider: slicesBy(rows, (r) => r.provider, (k) => k),
  };
}
