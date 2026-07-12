import { describe, expect, it } from "vitest";
import { createOpportunity, setVariantGeneration, setVariantStatus } from "@/lib/social/store";
import { planOpportunity } from "@/lib/social/plan";
import { setPublishDryRun } from "@/lib/social/settings";
import { scheduleVariant, runPublication } from "@/lib/social/publish";
import { runCollectAnalytics } from "@/lib/social/collect-analytics";
import { getAnalyticsForPublication, teamAnalyticsSummary } from "@/lib/social/analytics";
import { runDueJobs } from "@/lib/jobs";
import type { SocialPublishingProvider } from "@/lib/social/providers/types";
import { db, seedTeam } from "./helpers";

/**
 * Spec for analytics (M6) on real Postgres, provider STUBBED. Derived from intent: after a
 * publication is published, metrics are collected (via a delayed M0 `collect_analytics` job) and
 * stored normalized, one snapshot per publication; dry-run records an empty snapshot; the team
 * summary aggregates. Store-and-display only.
 */
async function approvedVariant(access: "team" | "external" = "team") {
  const seed = await seedTeam();
  const opp = await createOpportunity(db(), seed.teamId, { access, sourceType: "manual", title: "Shipped the queue" });
  const { variants } = await planOpportunity(db(), seed.teamId, opp.id, { memberId: seed.memberId });
  await setVariantGeneration(db(), seed.teamId, variants[0].id, { body: "we shipped", status: "generated", validation: {} });
  await setVariantStatus(db(), seed.teamId, variants[0].id, "approved");
  return { seed, variantId: variants[0].id };
}

const stubProvider = (metrics: { impressions: number; likes: number }): SocialPublishingProvider => ({
  name: "stub",
  publish: async () => ({ externalId: "ext-1", url: "https://x.com/1", status: "published" }),
  getAnalytics: async () => ({ impressions: metrics.impressions, likes: metrics.likes, comments: 0, shares: 0, saves: 0, clicks: 0, raw: {} }),
});

describe("publication analytics (real Postgres, stubbed provider)", () => {
  it("collects a dry-run publication as an empty snapshot via the M0 job", async () => {
    const { seed, variantId } = await approvedVariant();
    const pub = await scheduleVariant(db(), seed.teamId, variantId); // dry-run default
    await runPublication(db(), seed.teamId, pub.id); // → published, enqueues collect_analytics (+6h)

    const { count } = await db()
      .from("social_jobs")
      .select("id", { count: "exact", head: true })
      .eq("team_id", seed.teamId)
      .eq("kind", "collect_analytics");
    expect(count).toBe(1);

    // Run the collection job (advance the clock past the 6h delay).
    await runDueJobs({ db: db(), now: new Date(Date.now() + 7 * 3_600_000) });
    const a = await getAnalyticsForPublication(db(), seed.teamId, pub.id);
    expect(a).toBeTruthy();
    expect(a!.impressions).toBeNull(); // dry-run → no real metrics
  });

  it("collects normalized metrics on the live path and aggregates the team summary", async () => {
    const { seed, variantId } = await approvedVariant();
    await setPublishDryRun(db(), seed.teamId, false);
    const pub = await scheduleVariant(db(), seed.teamId, variantId);
    const provider = stubProvider({ impressions: 250, likes: 12 });
    await runPublication(db(), seed.teamId, pub.id, { provider });

    await runCollectAnalytics(db(), seed.teamId, pub.id, { provider });
    const a = await getAnalyticsForPublication(db(), seed.teamId, pub.id);
    expect(a!.impressions).toBe(250);
    expect(a!.likes).toBe(12);

    const summary = await teamAnalyticsSummary(db(), seed.teamId);
    expect(summary.posts).toBe(1);
    expect(summary.impressions).toBe(250);
  });

  it("upserts in place — re-collecting updates the same snapshot, not a duplicate", async () => {
    const { seed, variantId } = await approvedVariant();
    await setPublishDryRun(db(), seed.teamId, false);
    const pub = await scheduleVariant(db(), seed.teamId, variantId);
    await runPublication(db(), seed.teamId, pub.id, { provider: stubProvider({ impressions: 10, likes: 1 }) });

    await runCollectAnalytics(db(), seed.teamId, pub.id, { provider: stubProvider({ impressions: 10, likes: 1 }) });
    await runCollectAnalytics(db(), seed.teamId, pub.id, { provider: stubProvider({ impressions: 99, likes: 9 }) });

    const { count } = await db()
      .from("publication_analytics")
      .select("id", { count: "exact", head: true })
      .eq("publication_id", pub.id);
    expect(count).toBe(1);
    expect((await getAnalyticsForPublication(db(), seed.teamId, pub.id))!.impressions).toBe(99);
  });
});
