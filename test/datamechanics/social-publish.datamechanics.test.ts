import { describe, expect, it } from "vitest";
import { createOpportunity, getVariant, setVariantStatus } from "@/lib/social/store";
import { planOpportunity } from "@/lib/social/plan";
import { setPublishDryRun } from "@/lib/social/settings";
import { scheduleVariant, runPublication, PublishError } from "@/lib/social/publish";
import { getPublication } from "@/lib/social/publications";
import { runDueJobs } from "@/lib/jobs";
import type { SocialPublishingProvider } from "@/lib/social/providers/types";
import { db, seedTeam } from "./helpers";

/**
 * Spec for publishing on real Postgres (M5), provider STUBBED. Derived from intent: scheduling an
 * approved variant records a publication and enqueues a durable M0 `publish` job; the job runs it
 * (dry-run posts nothing); the live path calls the provider; failures mark the publication failed
 * and rethrow so the M0 runner retries. Nothing goes live in dry-run (the default).
 */
async function approvedVariant() {
  const seed = await seedTeam();
  const opp = await createOpportunity(db(), seed.teamId, { access: "team", sourceType: "manual", title: "Shipped the queue" });
  const { variants } = await planOpportunity(db(), seed.teamId, opp.id, { memberId: seed.memberId });
  await setVariantGenerationBody(seed.teamId, variants[0].id);
  await setVariantStatus(db(), seed.teamId, variants[0].id, "approved");
  return { seed, variantId: variants[0].id };
}
async function setVariantGenerationBody(teamId: string, id: string) {
  const { setVariantGeneration } = await import("@/lib/social/store");
  await setVariantGeneration(db(), teamId, id, { body: "we shipped a durable queue", status: "generated", validation: {} });
}

describe("publishing + M0 job (real Postgres, stubbed provider)", () => {
  it("schedules an approved variant (dry-run default), enqueues a publish job, and the job publishes it", async () => {
    const { seed, variantId } = await approvedVariant();
    const pub = await scheduleVariant(db(), seed.teamId, variantId, { actor: { memberId: seed.memberId } });
    expect(pub.dry_run).toBe(true);
    expect(pub.status).toBe("scheduled");
    expect((await getVariant(db(), seed.teamId, variantId))!.status).toBe("scheduled");

    const { count } = await db()
      .from("social_jobs")
      .select("id", { count: "exact", head: true })
      .eq("team_id", seed.teamId)
      .eq("kind", "publish");
    expect(count).toBe(1);

    // Inject a clock a minute ahead so the job (run_after ≈ enqueue time) is due regardless of any
    // small DB/JS clock skew.
    const summary = await runDueJobs({ db: db(), now: new Date(Date.now() + 60_000) });
    expect(summary.succeeded).toBeGreaterThanOrEqual(1);

    const after = await getPublication(db(), seed.teamId, pub.id);
    expect(after!.status).toBe("published");
    expect(after!.external_id).toBe("dry-run"); // nothing posted
    expect((await getVariant(db(), seed.teamId, variantId))!.status).toBe("published");
  });

  it("refuses to schedule a variant that isn't approved", async () => {
    const seed = await seedTeam();
    const opp = await createOpportunity(db(), seed.teamId, { access: "team", sourceType: "manual", title: "x" });
    const { variants } = await planOpportunity(db(), seed.teamId, opp.id);
    await expect(scheduleVariant(db(), seed.teamId, variants[0].id)).rejects.toBeInstanceOf(PublishError);
  });

  it("calls the provider on the live path and records the external post", async () => {
    const { seed, variantId } = await approvedVariant();
    await setPublishDryRun(db(), seed.teamId, false);
    const pub = await scheduleVariant(db(), seed.teamId, variantId);
    expect(pub.dry_run).toBe(false);

    const stub: SocialPublishingProvider = {
      name: "stub",
      publish: async () => ({ externalId: "ext-1", url: "https://x.com/1", status: "published" }),
    };
    await runPublication(db(), seed.teamId, pub.id, { provider: stub });
    const after = await getPublication(db(), seed.teamId, pub.id);
    expect(after!.status).toBe("published");
    expect(after!.external_id).toBe("ext-1");
    expect(after!.external_url).toBe("https://x.com/1");
  });

  it("marks the publication failed and rethrows when the provider errors (so M0 retries)", async () => {
    const { seed, variantId } = await approvedVariant();
    await setPublishDryRun(db(), seed.teamId, false);
    const pub = await scheduleVariant(db(), seed.teamId, variantId);
    const boom: SocialPublishingProvider = {
      name: "boom",
      publish: async () => { throw new Error("provider 500"); },
    };
    await expect(runPublication(db(), seed.teamId, pub.id, { provider: boom })).rejects.toThrow(/publish failed/);
    const after = await getPublication(db(), seed.teamId, pub.id);
    expect(after!.status).toBe("failed");
    expect(after!.last_error).toContain("provider 500");
    expect((await getVariant(db(), seed.teamId, variantId))!.status).toBe("failed");
  });
});
