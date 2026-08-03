import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runSql } from "@/lib/db/pg/pool";
import { getLlmCostBreakdown } from "@/lib/metrics/llm-costs";
import { getSpendTotalUsd, getSpendDailyUsd } from "@/lib/metrics/llm-spend";
import { db, seedTeam, type Seed } from "./helpers";

/**
 * Spec: a reported spend total is the EXACT sum of the window, at any row count.
 *
 * This is a persistence/aggregation bug, so it can only be caught here. The unit tier stubs the DB,
 * and the row caps that cause it (`.limit(50_000)` on the Pulse KPI, `.limit(100_000)` on the costs
 * breakdown) are invisible until the table actually holds more rows than the cap — which production
 * now does: 128,998 rows in a 30-day window reported as $18.62 on Pulse and $88.33 on /costs, against
 * a true $98.84.
 *
 * The seeded row count is a LITERAL, deliberately not derived from any production constant. Deriving
 * it (`CAP + 1`) would mean a future cap change silently re-sizes the fixture and the test stops
 * exercising the thing it was written for.
 */

/** Comfortably above both production caps (50k / 100k), and above any plausible near-term raise. */
const ROWS = 120_000;
/** Whole cents, so the expected total is exact in float: 120_000 × $0.001 = $120.00 exactly. */
const COST_PER_ROW = 0.001;
const EXPECTED_TOTAL = 120;

const ADMIN = (seed: Seed) => ({ isAdmin: true, memberId: seed.memberId });
const MEMBER = (seed: Seed) => ({ isAdmin: false, memberId: seed.memberId });

/**
 * Bulk-insert via generate_series — one statement, ~1s for 120k rows. Row-at-a-time through the
 * adapter would take minutes and make this tier too slow to keep.
 */
async function seedUsage(
  seed: Seed,
  opts: { rows: number; memberId?: string | null; source?: string; model?: string; provider?: string; daysAgo?: number }
): Promise<void> {
  const { rows, memberId = null, source = "graph", model = "m1", provider = "openrouter", daysAgo = 1 } = opts;
  await runSql(
    `insert into llm_usage (id, team_id, member_id, source, provider, model, cost_usd, input_tokens, output_tokens, estimated, created_at)
     select gen_random_uuid(), $1, $2, $3, $4, $5, $6, 10, 5, false, now() - ($7 || ' days')::interval
     from generate_series(1, $8)`,
    [seed.teamId, memberId, source, provider, model, COST_PER_ROW, String(daysAgo), rows]
  );
}

describe("llm spend totals are exact, not capped (real Postgres)", () => {
  it("sums every row in the window — not just the first N the cap allows", async () => {
    // THE REPRODUCTION. On the pre-fix code this returns ~$50 (Pulse's 50k cap) or ~$100 (the costs
    // page's 100k cap) instead of $120.
    const seed = await seedTeam();
    await seedUsage(seed, { rows: ROWS });

    const total = await getSpendTotalUsd(db(), seed.teamId, 30, ADMIN(seed));
    expect(total).toBeCloseTo(EXPECTED_TOTAL, 6);

    const breakdown = await getLlmCostBreakdown(db(), seed.teamId, "30d", ADMIN(seed));
    expect(breakdown.total_usd).toBeCloseTo(EXPECTED_TOTAL, 6);
    expect(breakdown.calls).toBe(ROWS);
  });

  it("Pulse and the costs page agree — the same window cannot yield two totals", async () => {
    // The user-visible symptom: $18.62 on Pulse beside $88.33 on /costs, same team, same 30 days.
    const seed = await seedTeam();
    await seedUsage(seed, { rows: ROWS });

    const pulseTotal = await getSpendTotalUsd(db(), seed.teamId, 30, ADMIN(seed));
    const costsTotal = (await getLlmCostBreakdown(db(), seed.teamId, "30d", ADMIN(seed))).total_usd;

    expect(pulseTotal).toBeCloseTo(costsTotal, 6);
  });

  it("breakdown slices sum to the headline total", async () => {
    // Truncation understated every bar too, not just the total, so the slices are part of the fix.
    const seed = await seedTeam();
    await seedUsage(seed, { rows: 60_000, source: "graph", model: "m1", provider: "openrouter" });
    await seedUsage(seed, { rows: 60_000, source: "query", model: "m2", provider: "anthropic" });

    const b = await getLlmCostBreakdown(db(), seed.teamId, "30d", ADMIN(seed));
    const sumOf = (slices: { cost_usd: number }[]) => slices.reduce((s, x) => s + x.cost_usd, 0);

    expect(b.total_usd).toBeCloseTo(EXPECTED_TOTAL, 6);
    expect(sumOf(b.by_source)).toBeCloseTo(b.total_usd, 6);
    expect(sumOf(b.by_model)).toBeCloseTo(b.total_usd, 6);
    expect(sumOf(b.by_provider)).toBeCloseTo(b.total_usd, 6);
    expect(b.by_source.map((s) => s.key).sort()).toEqual(["graph", "query"]);
  });

  it("respects the window boundary", async () => {
    const seed = await seedTeam();
    await seedUsage(seed, { rows: 1_000, daysAgo: 2 }); // inside 30d and 7d
    await seedUsage(seed, { rows: 1_000, daysAgo: 20 }); // inside 30d, outside 7d

    expect(await getSpendTotalUsd(db(), seed.teamId, 30, ADMIN(seed))).toBeCloseTo(2, 6);
    expect(await getSpendTotalUsd(db(), seed.teamId, 7, ADMIN(seed))).toBeCloseTo(1, 6);
  });

  it("keeps the tier boundary: a member sees only their own rows, an admin the whole team", async () => {
    // `llm_usage` has no RLS backstop — the viewer predicate is the ONLY thing standing between a
    // member and the team's total spend, so moving the sum into SQL must carry it into the SQL.
    const seed = await seedTeam();
    await seedUsage(seed, { rows: 2_000, memberId: seed.memberId }); // $2 — theirs
    await seedUsage(seed, { rows: 3_000, memberId: null }); // $3 — system/background rows

    expect(await getSpendTotalUsd(db(), seed.teamId, 30, ADMIN(seed))).toBeCloseTo(5, 6);
    expect(await getSpendTotalUsd(db(), seed.teamId, 30, MEMBER(seed))).toBeCloseTo(2, 6);

    const asMember = await getLlmCostBreakdown(db(), seed.teamId, "30d", MEMBER(seed));
    expect(asMember.total_usd).toBeCloseTo(2, 6);
  });

  it("never leaks another team's spend", async () => {
    const mine = await seedTeam();
    const theirs = await seedTeam();
    await seedUsage(mine, { rows: 1_000 });
    await seedUsage(theirs, { rows: 5_000 });

    expect(await getSpendTotalUsd(db(), mine.teamId, 30, ADMIN(mine))).toBeCloseTo(1, 6);
  });

  it("returns 0 for a team with no rows, rather than throwing on a null SUM", async () => {
    // `SUM()` over no rows is NULL in SQL, not 0 — an unguarded Number(null) would read as 0 by luck
    // and as NaN if the shape ever changes.
    const seed = await seedTeam();
    expect(await getSpendTotalUsd(db(), seed.teamId, 30, ADMIN(seed))).toBe(0);
  });

  it("buckets the daily series by day, and the buckets sum to the total", async () => {
    // Pulse's sparkline reads this; it was fed by the same truncated row set as the KPI.
    const seed = await seedTeam();
    await seedUsage(seed, { rows: 1_000, daysAgo: 1 });
    await seedUsage(seed, { rows: 2_000, daysAgo: 3 });

    const daily = await getSpendDailyUsd(db(), seed.teamId, new Date(Date.now() - 30 * 86_400_000).toISOString(), ADMIN(seed));
    const sum = [...daily.values()].reduce((s, v) => s + v, 0);

    expect(sum).toBeCloseTo(3, 6);
    expect(daily.size).toBe(2);
  });

  it("is unaffected by unrelated rows in other teams' windows", async () => {
    const seed = await seedTeam();
    const other = await seedTeam();
    await seedUsage(seed, { rows: 500, source: "query" });
    await seedUsage(other, { rows: 500, source: "query" });

    const b = await getLlmCostBreakdown(db(), seed.teamId, "30d", ADMIN(seed));
    expect(b.total_usd).toBeCloseTo(0.5, 6);
    expect(b.by_source).toHaveLength(1);
  });

  it("folds blank and literal-'unknown' keys into ONE slice without losing money", async () => {
    // `model`/`source` are NOT NULL with a '' default, so a blank is its own SQL group. If '' and a
    // literal 'unknown' both appear in a window and the fold happens in JS, one group overwrites the
    // other and its dollars vanish from the breakdown while the headline total still counts them —
    // the slices would stop summing to the total.
    const seed = await seedTeam();
    await runSql(
      `insert into llm_usage (id, team_id, member_id, source, provider, model, cost_usd, input_tokens, output_tokens, estimated, created_at)
       values (gen_random_uuid(), $1, null, 'query', 'p', '',        1.00, 1, 1, false, now()),
              (gen_random_uuid(), $1, null, 'query', 'p', 'unknown', 2.00, 1, 1, false, now())`,
      [seed.teamId]
    );

    const b = await getLlmCostBreakdown(db(), seed.teamId, "30d", ADMIN(seed));
    const unknown = b.by_model.filter((m) => m.key === "unknown");
    expect(unknown).toHaveLength(1); // one slice, not two colliding ones
    expect(unknown[0].cost_usd).toBeCloseTo(3, 6); // and NEITHER dollar was dropped
    expect(b.by_model.reduce((s2, m) => s2 + m.cost_usd, 0)).toBeCloseTo(b.total_usd, 6);
  });

  it("reports token sums per slice, not just cost", async () => {
    const seed = await seedTeam();
    await seedUsage(seed, { rows: 1_000 });

    const b = await getLlmCostBreakdown(db(), seed.teamId, "30d", ADMIN(seed));
    const graph = b.by_source.find((s) => s.key === "graph")!;
    expect(graph.calls).toBe(1_000);
    expect(graph.input_tokens).toBe(10_000); // 1000 rows × 10
    expect(graph.output_tokens).toBe(5_000); // 1000 rows × 5
    expect(graph.estimated).toBe(false);
  });

  it("marks a slice estimated only when EVERY row in it is an estimate", async () => {
    const seed = await seedTeam();
    const id = randomUUID();
    await runSql(
      `insert into llm_usage (id, team_id, member_id, source, provider, model, cost_usd, input_tokens, output_tokens, estimated, created_at)
       values (gen_random_uuid(), $1, null, 'query', 'anthropic', 'est-only', 0.5, 1, 1, true, now()),
              (gen_random_uuid(), $1, null, 'arcs', 'anthropic', 'mixed', 0.5, 1, 1, true, now()),
              (gen_random_uuid(), $1, null, 'arcs', 'anthropic', 'mixed', 0.5, 1, 1, false, now())`,
      [seed.teamId]
    );
    void id;

    const b = await getLlmCostBreakdown(db(), seed.teamId, "30d", ADMIN(seed));
    expect(b.by_source.find((s) => s.key === "query")!.estimated).toBe(true);
    expect(b.by_source.find((s) => s.key === "arcs")!.estimated).toBe(false); // one metered row ⇒ not estimated
    expect(b.hasEstimates).toBe(true);
  });
});
