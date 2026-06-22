import { describe, expect, it } from "vitest";
import { ingestUsageCost } from "@/lib/costs/ingest";
import { getExternalCosts } from "@/lib/metrics/external-costs";
import { IngestValidationError } from "@/lib/api/schemas";
import { db, seedTeam } from "./helpers";

describe("usage_costs ingest + read (W2.1)", () => {
  it("upserts daily provider cost and reads it back team-wide for admin", async () => {
    const seed = await seedTeam();
    const auth = { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: "test-key" };

    await ingestUsageCost(db(), auth, {
      date: "2026-06-22",
      provider: "cursor",
      source: "dashboard-api",
      project: "aios",
      input_tokens: 1_000_000,
      output_tokens: 50_000,
      cache_read_tokens: 5_000_000,
      cost_usd: 83.57,
      events: 116,
      meta: { models: { "gpt-5.5-high": 109.78 } },
    });

    await ingestUsageCost(db(), auth, {
      date: "2026-06-22",
      provider: "claude",
      source: "session-logs",
      project: "aios",
      input_tokens: 500_000,
      output_tokens: 20_000,
      cache_read_tokens: 0,
      cost_usd: 12.5,
      events: 42,
      meta: { estimated: true },
    });

    const adminView = await getExternalCosts(db(), seed.teamId, "90d", {
      isAdmin: true,
      memberId: seed.memberId,
    });
    expect(adminView.totals.cost_usd).toBeCloseTo(96.07, 2);
    expect(adminView.by_provider.map((p) => p.provider).sort()).toEqual(["claude", "cursor"]);
    expect(adminView.rows[0].providers.length).toBe(2);

    const selfView = await getExternalCosts(db(), seed.teamId, "90d", {
      isAdmin: false,
      memberId: seed.memberId,
    });
    expect(selfView.selfOnly).toBe(true);
    expect(selfView.totals.cost_usd).toBeCloseTo(96.07, 2);
  });

  it("idempotent re-push updates the same day row", async () => {
    const seed = await seedTeam();
    const auth = { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: "test-key" };
    const payload = {
      date: "2026-06-20",
      provider: "cursor" as const,
      source: "dashboard-api",
      project: "",
      cost_usd: 60.0,
      events: 35,
    };

    await ingestUsageCost(db(), auth, payload);
    await ingestUsageCost(db(), auth, { ...payload, cost_usd: 61.5, events: 36 });

    const view = await getExternalCosts(db(), seed.teamId, "90d", {
      isAdmin: true,
      memberId: seed.memberId,
    });
    expect(view.totals.cost_usd).toBeCloseTo(61.5, 2);
    expect(view.totals.events).toBe(36);
  });

  it("rejects an unknown member handle as a client error (→ route 422, not 500)", async () => {
    const seed = await seedTeam();
    const auth = { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: "test-key" };

    await expect(
      ingestUsageCost(db(), auth, {
        member: "nobody-here",
        date: "2026-06-22",
        provider: "cursor",
        source: "dashboard-api",
        project: "",
        cost_usd: 1,
      })
    ).rejects.toBeInstanceOf(IngestValidationError);
  });
});
