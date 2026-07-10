import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ingestUsageCost } from "@/lib/costs/ingest";
import {
  getExternalCosts,
  getExternalCostSeries,
} from "@/lib/metrics/external-costs";
import { IngestValidationError } from "@/lib/api/schemas";
import { db, seedTeam } from "./helpers";

describe("usage_costs ingest + read (W2.1)", () => {
  it("upserts daily provider cost and reads it back team-wide for admin", async () => {
    const seed = await seedTeam();
    const auth = {
      teamId: seed.teamId,
      memberId: seed.memberId,
      apiKeyId: "test-key",
    };

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
    expect(adminView.by_provider.map((p) => p.provider).sort()).toEqual([
      "claude",
      "cursor",
    ]);
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
    const auth = {
      teamId: seed.teamId,
      memberId: seed.memberId,
      apiKeyId: "test-key",
    };
    const payload = {
      date: "2026-06-20",
      provider: "cursor" as const,
      source: "dashboard-api",
      project: "",
      cost_usd: 60.0,
      events: 35,
    };

    await ingestUsageCost(db(), auth, payload);
    await ingestUsageCost(db(), auth, {
      ...payload,
      cost_usd: 61.5,
      events: 36,
    });

    const view = await getExternalCosts(db(), seed.teamId, "90d", {
      isAdmin: true,
      memberId: seed.memberId,
    });
    expect(view.totals.cost_usd).toBeCloseTo(61.5, 2);
    expect(view.totals.events).toBe(36);
  });

  it("getExternalCostSeries builds day×provider buckets and role-scopes non-admins", async () => {
    const seed = await seedTeam();
    // A second member on the SAME team, with their own spend.
    const { data: other } = await db()
      .from("members")
      .insert({
        team_id: seed.teamId,
        email: `${randomUUID()}@test.local`,
        display_name: "Other",
        actor_handle: `actor-${randomUUID().slice(0, 8)}`,
        role: "member",
        tier: "team",
        status: "active",
      })
      .select("id")
      .single();
    const otherId = (other as { id: string }).id;

    // member1: opencode; member2: codex — same day, exercising the new providers.
    await ingestUsageCost(
      db(),
      { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: "k1" },
      {
        date: "2026-07-09",
        provider: "opencode",
        source: "session-api",
        project: "aios",
        input_tokens: 300,
        output_tokens: 120,
        cost_usd: 4.0,
        events: 6,
      },
    );
    await ingestUsageCost(
      db(),
      { teamId: seed.teamId, memberId: otherId, apiKeyId: "k2" },
      {
        date: "2026-07-09",
        provider: "codex",
        source: "session-logs",
        project: "aios",
        input_tokens: 500,
        output_tokens: 60,
        cost_usd: 2.0,
        events: 9,
        meta: { estimated: true },
      },
    );

    // Admin sees the whole team: both providers, both costs stacked on the one day.
    const admin = await getExternalCostSeries(db(), seed.teamId, "90d", {
      isAdmin: true,
      memberId: seed.memberId,
    });
    // Exact order (no sort) — asserts the stable providerRank ordering: codex before opencode.
    expect(admin.providers).toEqual(["codex", "opencode"]);
    expect(admin.spendByDay.length).toBe(1);
    expect(admin.spendByDay[0].date).toBe("2026-07-09");
    expect(admin.spendByDay[0].opencode).toBeCloseTo(4.0, 2);
    expect(admin.spendByDay[0].codex).toBeCloseTo(2.0, 2);
    expect(admin.tokensByDay[0].input).toBe(800);

    // Non-admin member1 sees ONLY their own opencode row — codex must not leak.
    const self = await getExternalCostSeries(db(), seed.teamId, "90d", {
      isAdmin: false,
      memberId: seed.memberId,
    });
    expect(self.selfOnly).toBe(true);
    expect(self.providers).toEqual(["opencode"]);
    expect(self.spendByDay[0].codex).toBeUndefined();
    expect(self.tokensByDay[0].input).toBe(300);
  });

  it("rejects an unknown member handle as a client error (→ route 422, not 500)", async () => {
    const seed = await seedTeam();
    const auth = {
      teamId: seed.teamId,
      memberId: seed.memberId,
      apiKeyId: "test-key",
    };

    await expect(
      ingestUsageCost(db(), auth, {
        member: "nobody-here",
        date: "2026-06-22",
        provider: "cursor",
        source: "dashboard-api",
        project: "",
        cost_usd: 1,
      }),
    ).rejects.toBeInstanceOf(IngestValidationError);
  });
});
