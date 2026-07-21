import { describe, expect, it } from "vitest";
import { createOpportunity, getVariant, setVariantGeneration, setVariantStatus } from "@/lib/social/store";
import { planOpportunity } from "@/lib/social/plan";
import { saveBrandProfile } from "@/lib/brand/manage";
import { setPublishDryRun } from "@/lib/social/settings";
import { scheduleVariant, runPublication, cancelScheduledPublication, PublishError } from "@/lib/social/publish";
import { createPublication, getPublication } from "@/lib/social/publications";
import { enqueueJob, runDueJobs } from "@/lib/jobs";
import type { SocialPublishingProvider } from "@/lib/social/providers/types";
import { db, seedTeam } from "./helpers";

/**
 * Spec for the FAIL-CLOSED publish door (2026-07-16 audit #1/#3/#6). Every safety property is
 * checked at creation/labeling time, but `runPublication` fires later off a row it must not trust —
 * so the observable outcome we assert is: internal, unapproved-anymore, gate-violating, or
 * dry-run-flipped content NEVER reaches the provider, and a scheduled post can be cancelled.
 * Provider is stubbed with a call recorder so "did it post?" is a hard assertion, not a proxy.
 */

function recorder(): SocialPublishingProvider & { calls: number } {
  const p = {
    name: "stub",
    calls: 0,
    async publish() {
      p.calls++;
      return { externalId: "ext-should-not-happen", url: null, status: "published" };
    },
  };
  return p;
}

async function approvedVariant(access: "team" | "external", body = "we shipped a durable queue") {
  const seed = await seedTeam();
  const opp = await createOpportunity(db(), seed.teamId, { access, sourceType: "manual", title: "Shipped the queue" });
  const { variants } = await planOpportunity(db(), seed.teamId, opp.id, { memberId: seed.memberId });
  const variantId = variants[0].id;
  await setVariantGeneration(db(), seed.teamId, variantId, { body, status: "generated", validation: {} });
  await setVariantStatus(db(), seed.teamId, variantId, "approved");
  return { seed, variantId };
}

describe("publish door is fail-closed (real Postgres, stubbed provider)", () => {
  it("#1 schedule: refuses an approved INTERNAL (team) variant — never creates a publication", async () => {
    const { seed, variantId } = await approvedVariant("team");
    await expect(scheduleVariant(db(), seed.teamId, variantId)).rejects.toBeInstanceOf(PublishError);
    const { count } = await db()
      .from("social_publications")
      .select("id", { count: "exact", head: true })
      .eq("team_id", seed.teamId);
    expect(count).toBe(0);
  });

  it("#1 fire: a publication for an internal variant is cancelled at the door — provider never called", async () => {
    // Bypass scheduleVariant (which already refuses) to prove the DOOR itself re-checks tier at fire.
    const { seed, variantId } = await approvedVariant("team");
    const pub = await createPublication(
      db(),
      seed.teamId,
      { variantId, access: "team", dryRun: false, scheduledAt: new Date().toISOString() }
    );
    const stub = recorder();
    await runPublication(db(), seed.teamId, pub.id, { provider: stub });
    expect(stub.calls).toBe(0); // nothing posted
    expect((await getPublication(db(), seed.teamId, pub.id))!.status).toBe("cancelled");
  });

  it("#1 runner: a door-refused publish job settles as DONE, never requeued (a refusal is not a retry)", async () => {
    const { seed, variantId } = await approvedVariant("team");
    const pub = await createPublication(
      db(),
      seed.teamId,
      { variantId, access: "team", dryRun: false, scheduledAt: new Date().toISOString() }
    );
    await enqueueJob(db(), { teamId: seed.teamId, kind: "publish", payload: { publicationId: pub.id }, dedupKey: `publish:${pub.id}` });
    const summary = await runDueJobs({ db: db(), now: new Date(Date.now() + 60_000) });
    expect(summary.requeued).toBe(0); // NOT retried
    expect(summary.dead).toBe(0);
    const { data } = await db().from("social_jobs").select("status").eq("team_id", seed.teamId).eq("kind", "publish");
    expect((data as { status: string }[])[0].status).toBe("done");
    expect((await getPublication(db(), seed.teamId, pub.id))!.status).toBe("cancelled");
  });

  it("#3 fire: a variant reverted out of the publish lifecycle (regenerated → rejected) can't fire", async () => {
    const { seed, variantId } = await approvedVariant("external");
    await setPublishDryRun(db(), seed.teamId, false);
    const pub = await scheduleVariant(db(), seed.teamId, variantId);
    // Simulate a regenerate-after-approval that rejected the new body: status leaves the lifecycle.
    await setVariantStatus(db(), seed.teamId, variantId, "rejected");
    const stub = recorder();
    await runPublication(db(), seed.teamId, pub.id, { provider: stub });
    expect(stub.calls).toBe(0);
    expect((await getPublication(db(), seed.teamId, pub.id))!.status).toBe("cancelled");
  });

  it("#3 fire: a body that VIOLATES the gate at fire time is refused (re-runs governance)", async () => {
    const { seed, variantId } = await approvedVariant("external", "our synergy platform ships today");
    await setPublishDryRun(db(), seed.teamId, false);
    // Schedule while the brand has no rules (clean), THEN add a prohibited phrase the body contains.
    const pub = await scheduleVariant(db(), seed.teamId, variantId);
    await saveBrandProfile(db(), seed.teamId, { voice: { prohibitedPhrases: ["synergy"] } }, { memberId: seed.memberId });
    const stub = recorder();
    await runPublication(db(), seed.teamId, pub.id, { provider: stub });
    expect(stub.calls).toBe(0);
    expect((await getPublication(db(), seed.teamId, pub.id))!.status).toBe("cancelled");
    // The variant is rewound out of the publish lifecycle (not stranded in 'scheduled'), so a fresh
    // gate-passing regenerate is required before it can re-enter the publish path.
    expect((await getVariant(db(), seed.teamId, variantId))!.status).toBe("rejected");
  });

  it("#6 fire: flipping dry-run back ON after scheduling HOLDS a pending LIVE post (not a fake success)", async () => {
    const { seed, variantId } = await approvedVariant("external");
    await setPublishDryRun(db(), seed.teamId, false); // scheduled LIVE
    const pub = await scheduleVariant(db(), seed.teamId, variantId);
    expect(pub.dry_run).toBe(false);
    await setPublishDryRun(db(), seed.teamId, true); // operator hits the brakes
    const stub = recorder();
    await runPublication(db(), seed.teamId, pub.id, { provider: stub });
    expect(stub.calls).toBe(0); // live dry-run wins → nothing posted
    // Held, not "published" — cancelled, and the variant is freed to re-schedule once the brake lifts.
    expect((await getPublication(db(), seed.teamId, pub.id))!.status).toBe("cancelled");
    expect((await getVariant(db(), seed.teamId, variantId))!.status).toBe("approved");
  });

  it("#6 cancel: a scheduled publication can be cancelled, freeing the variant, and won't fire", async () => {
    const { seed, variantId } = await approvedVariant("external");
    await setPublishDryRun(db(), seed.teamId, false);
    const pub = await scheduleVariant(db(), seed.teamId, variantId);
    const { cancelled } = await cancelScheduledPublication(db(), seed.teamId, pub.id, { memberId: seed.memberId });
    expect(cancelled).toBe(true);
    expect((await getPublication(db(), seed.teamId, pub.id))!.status).toBe("cancelled");
    expect((await getVariant(db(), seed.teamId, variantId))!.status).toBe("approved"); // freed to re-schedule

    const stub = recorder();
    await runPublication(db(), seed.teamId, pub.id, { provider: stub }); // terminal — no-op
    expect(stub.calls).toBe(0);
  });
});
