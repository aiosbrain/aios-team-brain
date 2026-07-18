import { describe, expect, it } from "vitest";
import { createOpportunity } from "@/lib/social/store";
import { planOpportunity } from "@/lib/social/plan";
import { generateVariantImage, imageBudget, ImageBudgetError, DAILY_IMAGE_CAP } from "@/lib/media/generate-image";
import { db, seedTeam } from "./helpers";

/**
 * Spec for image generation + the cost guard on real Postgres, with the provider STUBBED (the
 * data-mechanics tier stubs the model). Derived from intent: an image is stored for the variant at
 * the variant's tier, and generation is hard-capped per team per day (Chetan: 10) — enforced
 * before any provider call.
 */
const stubGen = async () => ({ b64: Buffer.from("fake-png-bytes").toString("base64"), model: "gpt-image-1.5" });

async function plannedVariant(access: "team" | "external" = "team") {
  const seed = await seedTeam();
  const opp = await createOpportunity(db(), seed.teamId, { access, sourceType: "manual", title: "Shipped the queue" });
  const { variants } = await planOpportunity(db(), seed.teamId, opp.id, { memberId: seed.memberId });
  return { seed, variant: variants[0] };
}

describe("image generation + cost guard (real Postgres, stubbed provider)", () => {
  it("stores an image at the variant's tier and decrements the budget", async () => {
    const { seed, variant } = await plannedVariant("team");
    const asset = await generateVariantImage(db(), seed.teamId, variant.id, { generate: stubGen, actor: { memberId: seed.memberId } });
    expect(asset.access).toBe("team");
    expect(asset.provider).toBe("openai");
    expect(asset.model).toBe("gpt-image-1.5");
    expect(asset.cost_usd).toBeGreaterThan(0);

    const budget = await imageBudget(db(), seed.teamId);
    expect(budget.used).toBe(1);
    expect(budget.remaining).toBe(DAILY_IMAGE_CAP - 1);
  });

  it("inherits external tier from an external variant", async () => {
    const { seed, variant } = await plannedVariant("external");
    const asset = await generateVariantImage(db(), seed.teamId, variant.id, { generate: stubGen });
    expect(asset.access).toBe("external");
  });

  it("enforces the daily cap — the (cap+1)th image is rejected before any spend", async () => {
    const { seed, variant } = await plannedVariant("team");
    let providerCalls = 0;
    const counted = async () => { providerCalls++; return stubGen(); };

    for (let i = 0; i < DAILY_IMAGE_CAP; i++) {
      await generateVariantImage(db(), seed.teamId, variant.id, { generate: counted });
    }
    expect((await imageBudget(db(), seed.teamId)).remaining).toBe(0);

    await expect(generateVariantImage(db(), seed.teamId, variant.id, { generate: counted })).rejects.toBeInstanceOf(ImageBudgetError);
    // The provider was never called for the over-cap request.
    expect(providerCalls).toBe(DAILY_IMAGE_CAP);
  });

  // audit #8: the cap is an ATOMIC reservation, not a check-then-act on count() — so concurrent
  // requests can never both pass the check and both spend. Firing cap+N at once, EXACTLY cap may
  // reserve a slot and reach the provider; the rest are refused before any spend. (Against the old
  // check-then-act this races: many would read count<cap and all spend → providerCalls > cap.)
  it("#8 concurrent requests never exceed the cap (atomic reservation)", async () => {
    const { seed, variant } = await plannedVariant("team");
    let providerCalls = 0;
    const counted = async () => { providerCalls++; return stubGen(); };

    const results = await Promise.allSettled(
      Array.from({ length: DAILY_IMAGE_CAP + 3 }, () =>
        generateVariantImage(db(), seed.teamId, variant.id, { generate: counted })
      )
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const refused = results.filter((r) => r.status === "rejected").length;
    expect(ok).toBe(DAILY_IMAGE_CAP);
    expect(refused).toBe(3);
    expect(providerCalls).toBe(DAILY_IMAGE_CAP); // never spent past the cap
    // Assert the counter directly — `remaining` clamps at 0 and would hide an over-run.
    expect((await imageBudget(db(), seed.teamId)).used).toBe(DAILY_IMAGE_CAP);
  });

  // A failed generation (bad key, provider error, moderation reject) must RELEASE its reserved slot,
  // so a transient failure doesn't permanently burn a slot against today's cap.
  it("#8 releases the reserved slot when generation fails", async () => {
    const { seed, variant } = await plannedVariant("team");
    const boom = async () => { throw new Error("moderation rejected"); };
    await expect(generateVariantImage(db(), seed.teamId, variant.id, { generate: boom })).rejects.toThrow(/moderation/);
    expect((await imageBudget(db(), seed.teamId)).used).toBe(0); // slot released — full budget intact

    const asset = await generateVariantImage(db(), seed.teamId, variant.id, { generate: stubGen });
    expect(asset).toBeTruthy();
    expect((await imageBudget(db(), seed.teamId)).used).toBe(1);
  });
});
