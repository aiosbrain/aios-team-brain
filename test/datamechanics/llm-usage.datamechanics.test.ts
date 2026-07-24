import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { recordLlmUsage, type LlmUsageSource } from "@/lib/costs/llm-usage";
import { getLlmCostBreakdown } from "@/lib/metrics/llm-costs";
import { db, seedTeam } from "./helpers";

/**
 * Spec for the brain-inference spend ledger (`llm_usage`) on REAL Postgres. The ledger is the lowest
 * shared layer for "what is our inference costing" — every LLM call records one row, and the Pulse
 * Spend KPI + Costs breakdown read it. Two contracts that need the real DB (constraints + null-member
 * semantics + the app-code scope with no RLS backstop):
 *   1. rows persist and aggregate by `source` (the breakdown "what's costing what").
 *   2. `scopeLlmUsage` is the ONLY gate: a non-admin sees ONLY spend they initiated; background
 *      (null-member) + other members' spend is admin-only. A leak here is a real tier/scope bug.
 * Derived from the product contract, not the implementation.
 */

async function addMember(teamId: string): Promise<string> {
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: teamId,
      email: `${randomUUID()}@test.local`,
      display_name: "Other",
      actor_handle: `actor-${randomUUID().slice(0, 8)}`,
      role: "member",
      tier: "team",
      status: "active",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed member failed: ${error?.message}`);
  return data.id as string;
}

function spend(teamId: string, memberId: string | null, source: LlmUsageSource, cost: number, estimated = false) {
  return recordLlmUsage(db(), {
    teamId,
    memberId,
    source,
    provider: "openrouter",
    model: "test/model",
    inputTokens: 100,
    outputTokens: 20,
    costUsd: cost,
    estimated,
  });
}

describe("llm_usage ledger (real Postgres)", () => {
  it("persists a metered call and aggregates cost by source", async () => {
    const seed = await seedTeam();
    await spend(seed.teamId, seed.memberId, "query", 0.1);
    await spend(seed.teamId, seed.memberId, "query", 0.2);
    await spend(seed.teamId, null, "arcs", 1.5);
    await spend(seed.teamId, null, "meeting-extract", 0.4, true);

    const b = await getLlmCostBreakdown(db(), seed.teamId, "30d", { isAdmin: true, memberId: seed.memberId });

    expect(b.total_usd).toBeCloseTo(2.2, 5);
    expect(b.calls).toBe(4);
    // Sorted by cost desc: arcs ($1.5) > meeting-extract ($0.4) > query ($0.3).
    expect(b.by_source.map((s) => s.key)).toEqual(["arcs", "meeting-extract", "query"]);
    const query = b.by_source.find((s) => s.key === "query")!;
    expect(query.cost_usd).toBeCloseTo(0.3, 5);
    expect(query.calls).toBe(2);
    // A source is "estimated" only if EVERY row in it is: query rows are metered → false.
    expect(query.estimated).toBe(false);
    expect(b.by_source.find((s) => s.key === "meeting-extract")!.estimated).toBe(true);
    expect(b.hasEstimates).toBe(true);
  });

  it("scopes spend by role: a non-admin sees ONLY their own, never background or other members'", async () => {
    const seed = await seedTeam();
    const other = await addMember(seed.teamId);

    await spend(seed.teamId, seed.memberId, "query", 0.10); // mine
    await spend(seed.teamId, other, "query", 0.20); // another member's
    await spend(seed.teamId, null, "arcs", 0.40); // system/background (no member)

    // Admin: whole team incl. background.
    const admin = await getLlmCostBreakdown(db(), seed.teamId, "30d", { isAdmin: true, memberId: seed.memberId });
    expect(admin.total_usd).toBeCloseTo(0.7, 5);

    // Non-admin (me): ONLY my $0.10 — the other member's $0.20 and the null-member $0.40 must not leak.
    const mine = await getLlmCostBreakdown(db(), seed.teamId, "30d", { isAdmin: false, memberId: seed.memberId });
    expect(mine.total_usd).toBeCloseTo(0.1, 5);
    expect(mine.calls).toBe(1);
  });
});
