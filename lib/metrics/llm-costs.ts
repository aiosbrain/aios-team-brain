import "server-only";
import type { DbClient } from "@/lib/db/types";
import { scopeLlmUsage, type QueryLogViewer } from "@/lib/auth/visibility";
import { rangeDays, type Range } from "./range";
import {
  getLedgerLifetimeUsdExact,
  getSpendCallCount,
  getSpendSlices,
  getSpendTotalUsd,
  type SpendSlice,
} from "./llm-spend";

/**
 * The brain's own inference-spend breakdown, read from the `llm_usage` ledger (every generation the
 * product makes — Q&A, arcs, meetings, timeline, social, titles). Powers the costs breakdown page
 * (the Spend KPI drills into this) and answers "what is actually costing what". Role-scoped in app
 * code via `scopeLlmUsage` (admin → team-wide incl. system rows; else → own spend) — no RLS backstop.
 *
 * Aggregation is done in JS over rows in the window (mirrors `lib/metrics/pulse`); fine at MVP
 * volumes. If `llm_usage` grows large, push the group-by into SQL.
 */

/** Cap on the failure fetch. Fetching cap+1 makes truncation DETECTABLE rather than silent — a storm is
 *  exactly when an unreported truncation would understate the thing you are looking at. */
const FAILED_ROW_CAP = 50_000;

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
  graph: "Graph extraction",
  embeddings: "Embeddings",
};

export interface CostSlice {
  key: string;
  label: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  /** METERED calls only. Deliberately NOT widened to include failed attempts: this number already means
   *  "calls whose spend is in `cost_usd`", and silently growing it would make every derived reading
   *  (cost per call, "we made N calls") quietly wrong. Failures are counted separately. */
  calls: number;
  /** Billed-but-unmeterable ATTEMPTS in this slice (`llm_failures`) — a timeout, a dropped connection,
   *  a response with no `usage`. Their dollars are in the provider's bill and in the reconciliation
   *  banner's remainder, never here, because an aborted call returns nothing to price.
   *
   *  POPULATED ON `by_source` ONLY. The failure fetch selects `source` alone (it is the slice anyone
   *  asks "which feature lost the money" about), so `by_model` and `by_provider` carry a structural 0
   *  — do not render it there without also widening the fetch, or the zero reads as "no failures". */
  failed_attempts: number;
  /** true when EVERY row in this slice is a price-table estimate (Anthropic); false if any is metered. */
  estimated: boolean;
}

export interface LlmCostBreakdown {
  days: number;
  total_usd: number;
  calls: number;
  /** Billed-but-unmeterable attempts in the window. See `CostSlice.failed_attempts`. */
  failed_attempts: number;
  /** True when the failure fetch hit its cap, so `failed_attempts` is a FLOOR (rendered as "≥ N").
   *  Failures arrive in retry-amplified storms, which is exactly when a silent truncation would lie. */
  failed_truncated: boolean;
  /** true when ANY row in the window is an estimate — so the page can flag "includes estimates". */
  hasEstimates: boolean;
  /** ISO timestamp of the EARLIEST metered call for this team, or null if the ledger is empty. The
   *  ledger only began when cost metering shipped, so a 30d/90d window over a few days of data reads as
   *  "the brain barely spends anything". The page uses this to say "tracking since <date>" instead of
   *  letting empty pre-metering days masquerade as real low-spend days. */
  trackingSince: string | null;
  /** true when `trackingSince` falls INSIDE the selected window — i.e. metering began mid-window, so the
   *  window covers fewer than `days` full days. Decided here (server) so the page needn't call `Date.now`
   *  during render (a React purity violation). */
  partialWindow: boolean;
  by_source: CostSlice[];
  by_model: CostSlice[];
  by_provider: CostSlice[];
}


/** Group rows by a key, summing cost/tokens/calls; returns slices sorted by cost desc. */
function slicesBy(
  slices: SpendSlice[],
  labelOf: (k: string) => string,
  /** Failure attempts per key, folded in AFTER the spend pass — so a key that only ever failed still
   *  gets a row (it spent money we can't see), and `estimated` is decided purely by priced rows. */
  failuresByKey?: Map<string, number>
): CostSlice[] {
  const map = new Map<string, CostSlice>();
  for (const r of slices) {
    const key = r.key || "unknown";
    // MERGE, never replace. The SQL already folds ''/NULL into one 'unknown' group, so a collision
    // should be impossible — but `map.set` would silently DROP a slice's dollars if one ever arrived,
    // and a breakdown that quietly loses money is the bug this whole change exists to remove.
    const cur =
      map.get(key) ??
      { key, label: labelOf(key), cost_usd: 0, input_tokens: 0, output_tokens: 0, calls: 0, failed_attempts: 0, estimated: true };
    cur.cost_usd += r.cost_usd;
    cur.input_tokens += r.input_tokens;
    cur.output_tokens += r.output_tokens;
    cur.calls += r.calls;
    // "estimated" is all-rows, so merging two groups keeps it only if BOTH are estimated.
    cur.estimated = cur.estimated && r.estimated;
    map.set(key, cur);
  }
  for (const [key, n] of failuresByKey ?? []) {
    const cur =
      map.get(key) ??
      // A slice with failures but no metered rows: `estimated` false, because there is no priced row to
      // call an estimate — claiming "these are list-price estimates" about $0 would be nonsense.
      { key, label: labelOf(key), cost_usd: 0, input_tokens: 0, output_tokens: 0, calls: 0, failed_attempts: 0, estimated: false };
    cur.failed_attempts += n;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.cost_usd - a.cost_usd || b.failed_attempts - a.failed_attempts);
}

export async function getLlmCostBreakdown(
  db: DbClient,
  teamId: string,
  range: Range,
  viewer: QueryLogViewer
): Promise<LlmCostBreakdown> {
  const days = rangeDays(range);
  const windowStart = new Date(Date.now() - days * 86_400_000);

  // EXACT, aggregated in Postgres. This used to fetch up to 100,000 rows and sum them here, which
  // silently under-reported once the window held more rows than the cap — production hit that at
  // 128,998 rows, reporting $88.33 against a true $98.84 while Pulse's lower 50k cap said $18.62.
  // A larger cap would only move the cliff; `SUM`/`GROUP BY` has no cliff to move.
  const [total_usd, calls, sourceSlices, modelSlices, providerSlices] = await Promise.all([
    getSpendTotalUsd(db, teamId, days, viewer),
    getSpendCallCount(db, teamId, days, viewer),
    getSpendSlices(db, teamId, days, "source", viewer),
    getSpendSlices(db, teamId, days, "model", viewer),
    getSpendSlices(db, teamId, days, "provider", viewer),
  ]);

  // Failures live in their OWN table, fetched separately — never merged into the row set above. Sharing
  // `llm_usage` would let a storm of $0 attempt rows evict real spend rows inside this query's 100k cap
  // (and the Pulse KPI's newest-50k), so the Spend number would FALL during a paid-failure storm. The
  // separation is what makes every dollar figure on this page safe by construction rather than by
  // remembering a filter. Scoped exactly like spend: a non-admin sees only attempts they initiated,
  // which in practice means ~none — graph and background work carries `member_id = null`.
  const failRes = await scopeLlmUsage(
    db
      .from("llm_failures")
      .select("source")
      .eq("team_id", teamId)
      .gte("created_at", windowStart.toISOString())
      .limit(FAILED_ROW_CAP + 1),
    viewer
  );
  const failRows = (failRes.data ?? []) as { source: string }[];
  const failed_truncated = failRows.length > FAILED_ROW_CAP;
  const counted = failed_truncated ? failRows.slice(0, FAILED_ROW_CAP) : failRows;
  const failuresBySource = new Map<string, number>();
  for (const f of counted) failuresBySource.set(f.source || "unknown", (failuresBySource.get(f.source || "unknown") ?? 0) + 1);
  const failed_attempts = counted.length;

  // "any estimated row exists" — a slice is `estimated` only when ALL its rows are, so a slice being
  // estimated is sufficient evidence, and a mixed slice is covered by its own rows being counted
  // elsewhere. Cheap and exact: derived from the grouped result, not a second scan.
  // ANY estimate in the window. `slice.estimated` is bool_and (all-rows), so it alone would miss a
  // MIXED slice — `any_estimated` is the bool_or companion computed in the same GROUP BY.
  const hasEstimates = sourceSlices.some((s2) => s2.any_estimated);

  // Earliest metered call = when this team's ledger began (i.e. when metering shipped). Team-scoped,
  // NOT role-scoped: "metering began on X" is an instance-level fact, not per-member spend, and a
  // member with no rows of their own should still see the honest tracking date. Cheap: one indexed row.
  const firstRes = await db
    .from("llm_usage")
    .select("created_at")
    .eq("team_id", teamId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const firstAt = (firstRes.data as { created_at: string | Date } | null)?.created_at ?? null;
  const trackingSince = firstAt ? new Date(firstAt).toISOString() : null;
  const partialWindow = trackingSince != null && new Date(trackingSince) > windowStart;

  return {
    days,
    total_usd,
    calls,
    failed_attempts,
    failed_truncated,
    hasEstimates,
    trackingSince,
    partialWindow,
    by_source: slicesBy(sourceSlices, (k) => SOURCE_LABEL[k] ?? k, failuresBySource),
    by_model: slicesBy(modelSlices, (k) => k),
    by_provider: slicesBy(providerSlices, (k) => k),
  };
}

/**
 * The ledger's LIFETIME total for a team, for reconciliation against the provider's own figure.
 *
 * Lifetime, not windowed, because the thing it is compared against is: OpenRouter's `/credits`
 * reports cumulative usage for a key and cannot be sliced by date. Comparing a 30-day ledger slice
 * to a lifetime provider total would manufacture a gap that isn't there — the opposite failure to
 * the one this exists to expose.
 *
 * Team-wide by construction (no viewer scoping): the provider figure is for the whole key, so the
 * only meaningful comparison is the whole team's ledger. The caller gates this on `isAdmin` for the
 * same reason — a member's scoped subtotal beside a whole-key total would read as a huge fake gap.
 */
/**
 * Retained as the historical cap this function used to fetch under. Nothing reads it any more — the
 * sum is exact — but the constant is exported, so it is kept and marked rather than silently dropped.
 *
 * @deprecated The lifetime total is now an exact SQL `SUM`; there is no cap to hit.
 */
export const LEDGER_LIFETIME_ROW_CAP = 500_000;

export async function getLedgerLifetimeUsd(
  db: DbClient,
  teamId: string,
  provider: string
): Promise<number | null> {
  // Delegates to the exact aggregate. The old implementation fetched up to 500,000 rows and returned
  // `null` when it hit the cap rather than under-report — the right instinct, and the reason the
  // /costs reconciliation banner stayed correct while the headline beside it drifted. With an exact
  // `SUM` there is nothing left to refuse, so the null case now means only "the query failed".
  return getLedgerLifetimeUsdExact(db, teamId, provider);
}
