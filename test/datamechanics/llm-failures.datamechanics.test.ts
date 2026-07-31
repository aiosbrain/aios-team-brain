import { describe, expect, it } from "vitest";
import { db, seedTeam } from "./helpers";
import { recordLlmUsage, recordLlmFailure } from "@/lib/costs/llm-usage";
import { getLlmCostBreakdown } from "@/lib/metrics/llm-costs";

/**
 * Spec (real Postgres): recording a billed-but-unmeterable ATTEMPT must never move a dollar figure.
 *
 * This is the whole risk of the feature. The Costs page exists to say what spend is; an observability
 * addition that shifts `total_usd`, inflates the call count, or flips the "these are estimates" banner
 * would be worse than the anonymous 45% it set out to explain. So every number on that page is pinned
 * here against a before/after with failures inserted between.
 *
 * Real Postgres and not a fake, because the point is that failures live in a SEPARATE TABLE: a fake
 * that ignores table names would pass this suite while both row kinds shared one array — which is the
 * exact confusion that made the unit-tier double misreport when this shipped.
 */

const admin = { isAdmin: true, memberId: "00000000-0000-0000-0000-000000000000" };

describe("llm_failures never moves the money (data-mechanics)", () => {
  it("leaves total_usd, calls, and the estimate flags byte-identical", async () => {
    const seed = await seedTeam();
    await recordLlmUsage(db(), {
      teamId: seed.teamId,
      memberId: null,
      source: "graph",
      provider: "openrouter",
      model: "qwen/qwen3.6-35b-a3b",
      inputTokens: 4000,
      outputTokens: 200,
      costUsd: 0.0012,
      estimated: false,
    });
    const before = await getLlmCostBreakdown(db(), seed.teamId, "30d", admin);

    // Ten aborted attempts — the 2026-07-29 shape, at a scale that would be impossible to miss.
    for (let i = 0; i < 10; i++) {
      await recordLlmFailure(db(), {
        teamId: seed.teamId,
        memberId: null,
        source: "graph",
        provider: "openrouter",
        model: "qwen/qwen3.6-35b-a3b",
        reason: "timeout",
        durationMs: 120_000,
      });
    }
    const after = await getLlmCostBreakdown(db(), seed.teamId, "30d", admin);

    // The money, and everything derived from priced rows, is untouched.
    expect(after.total_usd).toBe(before.total_usd);
    expect(after.calls).toBe(before.calls);
    expect(after.hasEstimates).toBe(before.hasEstimates);

    const sliceBefore = before.by_source.find((s) => s.key === "graph")!;
    const sliceAfter = after.by_source.find((s) => s.key === "graph")!;
    // Nested, not just top-level: a guard that pinned only the totals would miss a slice regressing.
    expect(sliceAfter.cost_usd).toBe(sliceBefore.cost_usd);
    expect(sliceAfter.calls).toBe(sliceBefore.calls);
    expect(sliceAfter.estimated).toBe(sliceBefore.estimated);
    expect(sliceAfter.input_tokens).toBe(sliceBefore.input_tokens);

    // …and the attempts ARE surfaced, top level and per feature — otherwise this passes vacuously by
    // the failures never having been written at all.
    expect(before.failed_attempts).toBe(0);
    expect(after.failed_attempts).toBe(10);
    expect(sliceAfter.failed_attempts).toBe(10);
    expect(after.failed_truncated).toBe(false);
  });

  it("a feature that ONLY ever failed still appears — invisible spend is the thing being fixed", async () => {
    const seed = await seedTeam();
    await recordLlmFailure(db(), {
      teamId: seed.teamId,
      memberId: null,
      source: "meeting-extract",
      provider: "openrouter",
      model: "m",
      reason: "network",
    });
    const b = await getLlmCostBreakdown(db(), seed.teamId, "30d", admin);
    const slice = b.by_source.find((s) => s.key === "meeting-extract");
    expect(slice, "a source with failures but no metered rows must still get a row").toBeTruthy();
    expect(slice!.failed_attempts).toBe(1);
    expect(slice!.cost_usd).toBe(0);
    // Not "an estimate" — there is no priced row here to describe, and claiming otherwise would put a
    // list-price caveat on a $0 that has nothing to do with list prices.
    expect(slice!.estimated).toBe(false);
  });

  it("a non-admin does not see another member's failed attempts", async () => {
    // Scoped exactly like spend (`scopeLlmUsage`): background work carries member_id = null, so a plain
    // member sees none of it. Same direction as the spend page — team-wide cost is admin-only.
    const seed = await seedTeam();
    await recordLlmFailure(db(), {
      teamId: seed.teamId,
      memberId: null,
      source: "graph",
      provider: "openrouter",
      model: "m",
      reason: "timeout",
    });
    const asMember = await getLlmCostBreakdown(db(), seed.teamId, "30d", { isAdmin: false, memberId: seed.memberId });
    expect(asMember.failed_attempts).toBe(0);
    const asAdmin = await getLlmCostBreakdown(db(), seed.teamId, "30d", admin);
    expect(asAdmin.failed_attempts).toBe(1);
  });
});
