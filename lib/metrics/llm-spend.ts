import "server-only";
import { runSql } from "@/lib/db/pg/pool";
import type { QueryLogViewer } from "@/lib/auth/visibility";

/**
 * llm-spend — EXACT aggregates over the `llm_usage` ledger, computed in Postgres.
 *
 * WHY THIS MODULE EXISTS
 *
 * Both spend surfaces used to fetch raw rows and sum them in JavaScript under a `.limit(...)`:
 * `lib/metrics/pulse` at 50,000 and `getLlmCostBreakdown` at 100,000. Once the table held more rows
 * than the cap, each silently summed a subset — and the two caps differed, so the SAME window
 * produced two different totals. Measured on production 2026-08-03: a 30-day window of 128,998 rows
 * reported **$18.62** on Pulse and **$88.33** on /costs against a true **$98.84**.
 *
 * The failure mode is what makes it worth a shared module rather than two local fixes:
 *
 *   - It UNDER-reports, which looks reassuring, so nobody investigates.
 *   - It has no error state. Nothing logs, nothing 500s; the number is just quietly short.
 *   - It gets worse as the product succeeds — the gap widens with every call.
 *
 * Raising the caps would only move the cliff and re-arrive silently at the new number. Aggregating
 * in SQL removes the cliff: `SUM`/`GROUP BY` is exact at any row count, transfers O(groups) instead
 * of O(rows), and cannot be outgrown. It is also what this file's predecessor planned for —
 * `llm-costs.ts` carried "If `llm_usage` grows large, push the group-by into SQL".
 *
 * DERIVATION LIVES HERE, NOT IN A SURFACE. Pulse and the costs page are two readers of one fact.
 * Computing spend inside either would guarantee they drift again the next time one changes.
 *
 * SQL is written through `runSql` (the adapter's parameterized escape hatch, already used across
 * `lib/auth`, `lib/attribution`, `lib/graph`, …). Every value is a bound parameter; no interpolation.
 *
 * NOTE ON THE `_db` PARAMETER: these functions take a client and ignore it — `runSql` goes to the
 * global pool. It is kept so call sites read like every other metrics function (and so a caller
 * cannot conclude these bypass the adapter), and underscored to say plainly that it is unused. The
 * consequence worth knowing: a transaction-scoped client would NOT be honoured here. No caller needs
 * that today; a future one must add explicit transaction support rather than assume it works.
 */

/**
 * The viewer predicate for `llm_usage`, in SQL — the single definition, mirroring `scopeLlmUsage`.
 *
 * `llm_usage` has NO RLS backstop, so this predicate is the entire tier boundary on the table: an
 * admin sees the team (including `member_id IS NULL` system/background rows, which is most of the
 * graph-extraction spend), and anyone else sees only rows they initiated. A `SUM` that forgot this
 * would hand a member the team's total spend — the aggregate rewrite is exactly the kind of change
 * where that gets lost, so it is expressed once, here, and asserted in the data-mechanics tier.
 *
 * Returns a fragment to append to a WHERE clause plus the params to bind after `startAt`.
 */
function viewerPredicate(viewer: QueryLogViewer, nextParamIndex: number): { sql: string; params: unknown[] } {
  if (viewer.isAdmin) return { sql: "", params: [] };
  return { sql: ` and member_id = $${nextParamIndex}`, params: [viewer.memberId] };
}

/** `days` → the window start, matching the surfaces' existing arithmetic exactly. */
function windowStartIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/**
 * Exact total spend for the window.
 *
 * `SUM()` over zero rows is SQL NULL, not 0 — coalesced in SQL so the caller can never receive a
 * null that reads as 0 by luck and as NaN once a shape changes.
 */
export async function getSpendTotalUsd(
  db: unknown,
  teamId: string,
  days: number,
  viewer: QueryLogViewer
): Promise<number> {
  return getSpendTotalUsdBetween(db, teamId, windowStartIso(days), null, viewer);
}

/**
 * Exact total over an explicit half-open range `[startIso, endIso)`.
 *
 * Pulse needs a PRIOR window (for the % delta) as well as the current one; expressing both through
 * one function keeps the two from drifting — a delta computed against a differently-scoped total is
 * the same class of bug as the one this module exists to remove.
 */
export async function getSpendTotalUsdBetween(
  _db: unknown,
  teamId: string,
  startIso: string,
  endIso: string | null,
  viewer: QueryLogViewer
): Promise<number> {
  const params: unknown[] = [teamId, startIso];
  let sql = `select coalesce(sum(cost_usd), 0) as total from llm_usage where team_id = $1 and created_at >= $2`;
  if (endIso) {
    params.push(endIso);
    sql += ` and created_at < $${params.length}`;
  }
  const scope = viewerPredicate(viewer, params.length + 1);
  sql += scope.sql;
  const { rows } = await runSql<{ total: string | number }>(sql, [...params, ...scope.params]);
  return Number(rows[0]?.total ?? 0) || 0;
}

/**
 * Daily spend, keyed by `YYYY-MM-DD` (UTC) — the Pulse sparkline and the per-day cost series.
 *
 * Only days with spend are returned; the caller already maps onto its own bucket list, and emitting
 * zero-rows for empty days would just move that work into SQL.
 */
export async function getSpendDailyUsd(
  _db: unknown,
  teamId: string,
  startIso: string,
  viewer: QueryLogViewer
): Promise<Map<string, number>> {
  const scope = viewerPredicate(viewer, 3);
  const { rows } = await runSql<{ day: string | Date; total: string | number }>(
    `select to_char(date_trunc('day', created_at at time zone 'UTC'), 'YYYY-MM-DD') as day,
            coalesce(sum(cost_usd), 0) as total
       from llm_usage
      where team_id = $1 and created_at >= $2${scope.sql}
      group by 1`,
    [teamId, startIso, ...scope.params]
  );
  const out = new Map<string, number>();
  for (const r of rows) out.set(String(r.day), Number(r.total) || 0);
  return out;
}

/** Exact graph-extraction usage for one UTC day. */
export interface GraphUsageDay {
  day: string;
  calls: number;
  costUsd: number;
}

/**
 * Exact daily numerator for graph efficiency.
 *
 * This must stay an aggregate: fetching raw `llm_usage` rows under a cap makes calls-per-episode and
 * cost-per-episode look artificially LOW once extraction crosses that cap — precisely when the
 * metric is meant to warn. The viewer predicate is retained even though the current caller is
 * admin-only, so this ledger read cannot become a team-spend leak if it is reused later.
 */
export async function getGraphUsageDaily(
  _db: unknown,
  teamId: string,
  startIso: string,
  viewer: QueryLogViewer
): Promise<GraphUsageDay[]> {
  const scope = viewerPredicate(viewer, 4);
  const { rows } = await runSql<{
    day: string | Date;
    calls: string | number;
    cost_usd: string | number;
  }>(
    `select to_char(date_trunc('day', created_at at time zone 'UTC'), 'YYYY-MM-DD') as day,
            count(*) as calls,
            coalesce(sum(cost_usd), 0) as cost_usd
       from llm_usage
      where team_id = $1 and created_at >= $2 and source = $3${scope.sql}
      group by 1`,
    [teamId, startIso, "graph", ...scope.params]
  );
  return rows.map((r) => ({
    day: String(r.day),
    calls: Number(r.calls) || 0,
    costUsd: Number(r.cost_usd) || 0,
  }));
}

/** One grouped slice, pre-aggregated by Postgres. */
export interface SpendSlice {
  key: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  calls: number;
  /** true only when EVERY row in the slice is a price-table estimate — `bool_and`, not `bool_or`. */
  estimated: boolean;
  /** true when ANY row in the slice is an estimate. Distinct from `estimated`: a MIXED slice is not
   *  "estimated" (one metered row makes it real) but does contain estimates, which is what the
   *  page-level "some figures are estimates" disclosure needs. Deriving that from `estimated` alone
   *  would silently drop the mixed case. */
  any_estimated: boolean;
}

/** The columns we group by. A closed set: interpolated into SQL, so it may never take user input. */
export type SpendDimension = "source" | "model" | "provider";
const DIMENSIONS: Record<SpendDimension, string> = {
  source: "source",
  model: "model",
  provider: "provider",
};

/**
 * Spend grouped by one dimension, exact at any row count.
 *
 * The dimension is looked up in `DIMENSIONS` rather than concatenated: it is the only part of these
 * statements that is not a bound parameter, so it is constrained to a fixed allowlist and can never
 * carry caller input into the SQL text.
 */
export async function getSpendSlices(
  _db: unknown,
  teamId: string,
  days: number,
  dimension: SpendDimension,
  viewer: QueryLogViewer
): Promise<SpendSlice[]> {
  const column = DIMENSIONS[dimension];
  if (!column) throw new Error(`unknown spend dimension: ${dimension}`);

  const scope = viewerPredicate(viewer, 3);
  const { rows } = await runSql<{
    key: string | null;
    cost_usd: string | number;
    input_tokens: string | number;
    output_tokens: string | number;
    calls: string | number;
    estimated: boolean | null;
    any_estimated: boolean | null;
  }>(
    // `nullif(…, '')` matters: `model`/`source` are NOT NULL with a '' default, so a blank arrives as
    // its own group. Folding '' and NULL to 'unknown' HERE means Postgres aggregates them into one
    // group; doing it in JS afterwards would let a '' group and a literal 'unknown' group collide.
    `select coalesce(nullif(${column}, ''), 'unknown') as key,
            coalesce(sum(cost_usd), 0)      as cost_usd,
            coalesce(sum(input_tokens), 0)  as input_tokens,
            coalesce(sum(output_tokens), 0) as output_tokens,
            count(*)                        as calls,
            bool_and(coalesce(estimated, false)) as estimated,
            bool_or(coalesce(estimated, false))  as any_estimated
       from llm_usage
      where team_id = $1 and created_at >= $2${scope.sql}
      group by 1
      order by 2 desc`,
    [teamId, windowStartIso(days), ...scope.params]
  );

  return rows.map((r) => ({
    key: String(r.key ?? "unknown"),
    cost_usd: Number(r.cost_usd) || 0,
    input_tokens: Number(r.input_tokens) || 0,
    output_tokens: Number(r.output_tokens) || 0,
    calls: Number(r.calls) || 0,
    estimated: r.estimated === true,
    any_estimated: r.any_estimated === true,
  }));
}

/** Metered call count for the window — `count(*)`, so it never depends on how many rows we fetched. */
export async function getSpendCallCount(
  _db: unknown,
  teamId: string,
  days: number,
  viewer: QueryLogViewer
): Promise<number> {
  const scope = viewerPredicate(viewer, 3);
  const { rows } = await runSql<{ n: string | number }>(
    `select count(*) as n from llm_usage
      where team_id = $1 and created_at >= $2${scope.sql}`,
    [teamId, windowStartIso(days), ...scope.params]
  );
  return Number(rows[0]?.n ?? 0) || 0;
}

/** One Graphiti prompt's share of graph spend. `callKind` is `''` for pre-instrumentation rows. */
export interface GraphCallKindSlice {
  callKind: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

/**
 * Graph spend grouped by WHICH GRAPHITI PROMPT made the call (GRAPHCOST-5).
 *
 * The question this exists to answer: extraction is ~99% of the bill, and until now all of it was
 * one number, so no lever could be sized. With this, "is the money in entity extraction, in the
 * per-entity attribute fan-out, or in dedupe?" is one query — which is what decides whether a graph
 * service upgrade or a model swap is the bigger win.
 *
 * NOT `getSpendSlices` with a fourth dimension, deliberately. That function folds
 * `coalesce(nullif(col, ''), 'unknown')`, which is right for `model`/`provider` and destructive
 * here: it would merge `''` (recorded before instrumentation shipped — history) into `'unknown'`
 * (classified but unmatched — a DRIFT ALARM saying the deployed prompts have moved). Those two mean
 * opposite things; one is inert, the other is the signal that this whole breakdown has gone stale.
 * So the raw column is grouped as-is and callers render `''` as "pre-instrumentation".
 *
 * Scoped to `source = 'graph'`: no other source writes the column, and including them would put a
 * large `''` bucket next to the real ones for no reason.
 */
export async function getGraphSpendByCallKind(
  _db: unknown,
  teamId: string,
  days: number,
  viewer: QueryLogViewer
): Promise<GraphCallKindSlice[]> {
  const scope = viewerPredicate(viewer, 3);
  const { rows } = await runSql<{
    call_kind: string;
    cost_usd: string | number;
    input_tokens: string | number;
    output_tokens: string | number;
    calls: string | number;
  }>(
    `select call_kind,
            coalesce(sum(cost_usd), 0)      as cost_usd,
            coalesce(sum(input_tokens), 0)  as input_tokens,
            coalesce(sum(output_tokens), 0) as output_tokens,
            count(*)                        as calls
       from llm_usage
      where team_id = $1 and created_at >= $2 and source = 'graph'${scope.sql}
      group by call_kind
      order by 2 desc`,
    [teamId, windowStartIso(days), ...scope.params]
  );
  return rows.map((r) => ({
    callKind: r.call_kind,
    costUsd: Number(r.cost_usd) || 0,
    inputTokens: Number(r.input_tokens) || 0,
    outputTokens: Number(r.output_tokens) || 0,
    calls: Number(r.calls) || 0,
  }));
}

/** Graph spend for one (prompt, model) pair — how small-model routing is verified. */
export interface GraphKindModelSlice {
  callKind: string;
  model: string;
  costUsd: number;
  calls: number;
}

/**
 * Graph spend by (call kind × model served) — the read that proves small-model routing worked.
 *
 * Routing `node_attributes` to a cheap model is only trustworthy if it can be checked afterwards,
 * and this is the check: after the change, `node_attributes` rows should carry the small model while
 * `extract_nodes` rows still carry the strong one. Two rows with the same kind and different models
 * is a routing change in flight; one row is either "not enabled" or "not working", and the model
 * name says which.
 *
 * `model` is written from the `ProxyTarget` the call was actually served with, so this cannot be
 * satisfied by a swapped string that never changed the transport.
 *
 * Like `getGraphSpendByCallKind`, `''` is kept distinct from `'unknown'` — pre-instrumentation
 * history and a drift alarm are not the same fact.
 */
export async function getGraphSpendByCallKindAndModel(
  _db: unknown,
  teamId: string,
  days: number,
  viewer: QueryLogViewer
): Promise<GraphKindModelSlice[]> {
  const scope = viewerPredicate(viewer, 3);
  const { rows } = await runSql<{
    call_kind: string;
    model: string;
    cost_usd: string | number;
    calls: string | number;
  }>(
    `select call_kind, model,
            coalesce(sum(cost_usd), 0) as cost_usd,
            count(*)                   as calls
       from llm_usage
      where team_id = $1 and created_at >= $2 and source = 'graph'${scope.sql}
      group by call_kind, model
      order by 3 desc`,
    [teamId, windowStartIso(days), ...scope.params]
  );
  return rows.map((r) => ({
    callKind: r.call_kind,
    model: r.model,
    costUsd: Number(r.cost_usd) || 0,
    calls: Number(r.calls) || 0,
  }));
}

/**
 * Lifetime ledger total for ONE provider — the reconciliation figure.
 *
 * Replaces a 500,000-row fetch that returned `null` at the cap rather than under-report. That
 * refusal was the right instinct and is why the /costs banner stayed correct while the headline
 * beside it drifted; an exact `SUM` means there is now nothing to refuse.
 */
export async function getLedgerLifetimeUsdExact(
  _db: unknown,
  teamId: string,
  provider: string
): Promise<number | null> {
  try {
    const { rows } = await runSql<{ total: string | number }>(
      // Provider-filtered, and that filter is the whole correctness of the comparison: the figure this
      // is measured against comes from ONE provider's billing API. Summing every provider would count
      // an Anthropic list-price estimate as money that key never saw, erasing the very shortfall the
      // reconciliation exists to expose.
      `select coalesce(sum(cost_usd), 0) as total
         from llm_usage
        where team_id = $1 and provider = $2`,
      [teamId, provider]
    );
    return Number(rows[0]?.total ?? 0) || 0;
  } catch {
    return null; // can't reconcile → the caller shows nothing rather than a wrong comparison
  }
}
