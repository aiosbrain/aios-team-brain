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
});
