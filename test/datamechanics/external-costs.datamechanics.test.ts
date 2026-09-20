import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ingestUsageCost } from "@/lib/costs/ingest";
import {
  getExternalCosts,
  getExternalCostSeries,
} from "@/lib/metrics/external-costs";
import { IngestValidationError } from "@/lib/api/schemas";
import { db, seedTeam } from "./helpers";

/**
 * ROLLING DAYS, IN UTC — not fixed dates.
 *
 * The readers derive the `90d` window's lower bound from `Date.now()` and filter on `cost_date`, so
 * a hard-coded seed day silently ages out of the window and every positive cost assertion reads
 * zero (CI 35447298065: the 2026-06-20 seed went 91 days old). These are ingest/idempotence/role
 * tests, not date-boundary ones: in-window seeds sit comfortably inside the window, and an
 * `AGED_OUT` seed well outside it proves the window filter is live, so the positives are not vacuous.
 */
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const recentDay = () => daysAgo(1);
const agedOutDay = () => daysAgo(120);

describe("usage_costs ingest + read (W2.1)", () => {
  it("upserts daily provider cost and reads it back team-wide for admin", async () => {
    const seed = await seedTeam();
    const auth = {
      teamId: seed.teamId,
      memberId: seed.memberId,
      apiKeyId: "test-key",
    };

    await ingestUsageCost(db(), auth, {
      date: recentDay(),
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
      date: recentDay(),
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

    // Honest split: cursor (dashboard-api) is billed; claude (session-logs) is an estimate.
    expect(adminView.totals.billed_usd).toBeCloseTo(83.57, 2);
    expect(adminView.totals.estimated_usd).toBeCloseTo(12.5, 2);
    const byProv = Object.fromEntries(
      adminView.by_provider.map((p) => [p.provider, p.estimated]),
    );
    expect(byProv.cursor).toBe(false);
    expect(byProv.claude).toBe(true);

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
      date: recentDay(),
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
    // Non-vacuity: the same key on an aged-out day is a distinct row the window must exclude.
    await ingestUsageCost(db(), auth, { ...payload, date: agedOutDay(), cost_usd: 1000, events: 999 });

    const view = await getExternalCosts(db(), seed.teamId, "90d", {
      isAdmin: true,
      memberId: seed.memberId,
    });
    expect(view.totals.cost_usd).toBeCloseTo(61.5, 2);
    expect(view.totals.events).toBe(36);

    // Both day rows are stored (re-push upserted in place, the aged-out day is its own row), so the
    // single in-window row above is the window filter at work, not a missing seed.
    const { data: stored } = await db()
      .from("usage_costs")
      .select("cost_usd, events")
      .eq("team_id", seed.teamId)
      .order("cost_date", { ascending: true });
    // Compared by cost in date order, not by the date value: the pg adapter returns `date` columns
    // as local-midnight Date objects, which would make a string compare timezone-dependent.
    const costs = ((stored ?? []) as { cost_usd: number | string; events: number }[]).map((r) => [Number(r.cost_usd), r.events]);
    expect(costs).toEqual([[1000, 999], [61.5, 36]]);
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
    const day = recentDay();
    await ingestUsageCost(
      db(),
      { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: "k1" },
      {
        date: day,
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
        date: day,
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

    // Non-vacuity: an aged-out row for a THIRD provider must not surface anywhere in the window.
    await ingestUsageCost(
      db(),
      { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: "k1" },
      { date: agedOutDay(), provider: "cursor", source: "dashboard-api", project: "aios", cost_usd: 500, events: 1 },
    );

    // Admin sees the whole team: both providers, both costs stacked on the one day.
    const admin = await getExternalCostSeries(db(), seed.teamId, "90d", {
      isAdmin: true,
      memberId: seed.memberId,
    });
    // Exact order (no sort) — asserts the stable providerRank ordering: codex before opencode.
    expect(admin.providers).toEqual(["codex", "opencode"]);
    // codex (session-logs) is an estimate; opencode (session-api) is billed.
    expect(admin.estimatedProviders).toEqual(["codex"]);
    expect(admin.spendByDay.length).toBe(1);
    expect(admin.spendByDay[0].date).toBe(day);
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
        date: recentDay(),
        provider: "cursor",
        source: "dashboard-api",
        project: "",
        cost_usd: 1,
      }),
    ).rejects.toBeInstanceOf(IngestValidationError);
  });
});
